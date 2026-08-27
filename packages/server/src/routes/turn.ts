import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from '@veridical/schema';
import type { LLMProvider, LLMRequest } from '@veridical/llm';
import { LLMGateway } from '@veridical/llm';
import { runSpec, runSpecTurn, type RunnerStepCtx, type SpecRunnerDeps } from '@veridical/spec';
import { OpenAICompatibleProvider, MockScriptedProvider, resolveTools } from '../providers.js';
import { parseDecision } from '../runStep.js';

interface TurnBody {
  specName: string;
  version?: string;
  conversationId?: string;
  mode?: 'mock' | 'live';
  prompt?: string;
  script?: string[];
  provider?: string;
  model?: string;
  apiKey?: string;
}

/** 按 turn 去重历史消息：每 turn 一条 user（首个 user.message）+ 最后一条 assistant。截断最近 maxTurns 轮。 */
export function buildHistory(events: TraceEvent[], sessionId: string, maxTurns = 10): { role: 'user' | 'assistant'; content: string }[] {
  const sorted = [...events].filter(e => e.session_id === sessionId).sort((a, b) => a.seq - b.seq);
  const turns: { user?: string; assistant?: string }[] = [];
  let cur: { user?: string; assistant?: string } | undefined;
  for (const e of sorted) {
    if (e.type === 'turn/start') {
      cur = {};
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    const text = (e.payload as { text?: unknown })?.text;
    if (e.type === 'user.message' && typeof text === 'string' && cur.user === undefined) {
      cur.user = text;
    } else if (e.type === 'assistant.message' && typeof text === 'string') {
      cur.assistant = text;
    }
  }
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const t of turns.slice(-maxTurns)) {
    if (t.user !== undefined) out.push({ role: 'user', content: t.user });
    if (t.assistant !== undefined) out.push({ role: 'assistant', content: t.assistant });
  }
  return out;
}

export async function registerTurnRoutes(app: FastifyInstance) {
  const store = app.store;
  const registry = app.specRegistry;

  app.post<{ Body: TurnBody }>('/api/run/turn', async (req, reply) => {
    const b = req.body;
    if (!b?.specName) return reply.code(400).send({ error: { code: 'bad_request', message: 'specName required' } });
    const spec = await registry.resolve(b.specName, b.version);
    if (!spec) return reply.code(400).send({ error: { code: 'invalid_spec', message: `spec not found: ${b.specName}${b.version ? '@' + b.version : ''}` } });

    const isNew = !b.conversationId;
    const session_id = isNew ? `conv_${randomUUID()}` : b.conversationId!;
    if (!isNew) {
      const existing = await store.readBySession(session_id).catch(() => []);
      if (existing.length === 0) return reply.code(404).send({ error: { code: 'not_found', message: `conversation not found: ${session_id}` } });
    }

    // 校验必须在 hijack 之前完成——以上分支返回普通 JSON。
    // Providers（mock 缺省；live 需 apiKey+model）
    const providers = new Map<string, LLMProvider>();
    if (b.mode === 'live') {
      if (!b.apiKey || !b.model) return reply.code(400).send({ error: { code: 'bad_request', message: 'live mode requires apiKey and model' } });
      providers.set(spec.llm.provider, new OpenAICompatibleProvider('https://api.openai.com/v1', b.apiKey, b.model));
    } else {
      const mock = new MockScriptedProvider();
      (b.script && b.script.length ? b.script : [JSON.stringify({ text: 'done', done: true })]).forEach((s) => mock.enqueue(s));
      providers.set(spec.llm.provider, mock);
    }

    // 历史注入：续轮时从 store 读、按 turn 去重，供 runStep 与 buildRequest
    const past = isNew ? [] : await store.readBySession(session_id);
    const history = isNew ? [] : buildHistory(past, session_id);

    // SSE hijack（token + event 双通道）
    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    // @ts-ignore flushHeaders may not exist in types but exists at runtime
    reply.raw.flushHeaders?.();
    const send = (obj: unknown) => {
      if (reply.raw.writableEnded) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        // ignore write after close
      }
    };
    const doneSending = { value: false };
    const abort = () => {
      doneSending.value = true;
      try {
        reply.raw.end();
      } catch {
        // already closed
      }
    };
    // 客户端断开：停推（已落事件保留，下次进入可回看）。注意：turn 模式【不得】传 stepBoundary——
    // runSpec 的 onStepEnd 会对 stepBoundary 每步 await，而 turn 无 continue 放行，会永久挂起。
    // 同样监听 reply.raw 的 close（req.raw 'close' 在收到 POST body 时即触发，会误断）。
    reply.raw.on('close', () => {
      doneSending.value = true;
      try {
        reply.raw.end();
      } catch {
        // already closed
      }
    });

    // 流式 runStep：gateway.stream 经 onToken 回灌 {type:'token'}，事件经轮询回灌 {type:'event'}
    const gateway = new LLMGateway(providers);
    const runStep = async ({ recorder, prompt }: RunnerStepCtx) => {
      const req: LLMRequest = {
        provider: spec.llm.provider,
        model: spec.llm.model,
        messages: [
          { role: 'system', content: spec.instruction.system },
          ...history.map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: prompt },
        ],
      };
      const res = await gateway.stream(req, recorder, (chunk) => {
        if (!doneSending.value) send({ type: 'token', session_id, text: chunk });
      });
      const d = parseDecision(res.text);
      return { text: d.text ?? res.text, tool: d.tool };
    };

    // 事件轮询：唯一的 seq-delta interval，推送已落 store 的事件（tool/checkpoint/turn…）
    // 续轮时从既有会话最高 seq 起推——只回灌本轮新事件，不重放历史轮。
    let lastSeq = past.length ? past[past.length - 1].seq : 0;
    let poll: ReturnType<typeof setInterval> | undefined;
    try {
      poll = setInterval(async () => {
        if (doneSending.value) return;
        try {
          const evs = await store.readBySession(session_id);
          for (const ev of evs) {
            const seq = ev.seq ?? 0;
            if (seq > lastSeq) { send({ type: 'event', event: ev }); lastSeq = seq; }
          }
        } catch {
          // 忽略 poll 错误
        }
      }, 150);

      const deps: SpecRunnerDeps = {
        store,
        providers,
        tools: resolveTools(spec.tools.map((t) => t.name)),
        tenant_id: 't1',
        session_id,
        historyMessages: history,
        runStep,
        // 未传 stepBoundary：turn 连续执行，每步不暂停（断连时靠 clearPoll/abort 收尾）
      };
      const prompt = b.prompt ?? 'hello';

      const result = isNew ? await runSpec(deps, spec, prompt) : await runSpecTurn(deps, spec, prompt);
      // 收尾 flush：补推尚未轮询到的剩余事件 + turn_end + done
      const evs = await store.readBySession(session_id);
      for (const ev of evs) {
        const seq = ev.seq ?? 0;
        if (seq > lastSeq) { send({ type: 'event', event: ev }); lastSeq = seq; }
      }
      send({ type: 'turn_end', session_id });
      send({ type: 'done', session_id, event_count: evs.length, outcome: result.outcome });
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (poll) clearInterval(poll);
      abort();
    }
  });
}
