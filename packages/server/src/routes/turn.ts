import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { TraceEvent } from '@veridical/schema';
import type { LLMProvider, LLMRequest } from '@veridical/llm';
import { LLMGateway } from '@veridical/llm';
import {
  AgentSpecSchema,
  runSpec,
  runSpecTurn,
  type RunnerStepCtx,
  type SpecRunnerDeps,
} from '@veridical/spec';
import { OpenAICompatibleProvider, MockScriptedProvider, resolveTools } from '../providers.js';
import { parseDecision } from '../runStep.js';
import { createLocalModel } from '../local-model.js';
import { z } from 'zod';
import { tenantId } from '../principal.js';

type PendingApproval = { request: Record<string, unknown>; resolve: (allowed: boolean) => void; expires: number };
const pendingApprovals = new Map<string, PendingApproval>();
async function appendApprovalEvent(store: any, session_id: string, spec_version: string, type: string, verb: 'request' | 'response', payload: unknown, tenant_id = 'local') {
  const events = await store.readBySession(session_id).catch(() => []);
  const seq = (events.at(-1)?.seq ?? 0) + 1;
  await store.append({ id: `approval_${randomUUID()}`, tenant_id, session_id, span_id: 'approval', parent_span_id: null, seq, type, verb, attempt: 1, duration_ms: 0, payload, spec_version });
}

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
export function buildHistory(
  events: TraceEvent[],
  sessionId: string,
  maxTurns = 10,
): { role: 'user' | 'assistant'; content: string }[] {
  const sorted = [...events]
    .filter((e) => e.session_id === sessionId)
    .sort((a, b) => a.seq - b.seq);
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

  app.get('/api/approvals', async () => [...pendingApprovals.entries()].filter(([, value]) => value.expires > Date.now()).map(([id, value]) => ({ id, ...value.request, expires_at: new Date(value.expires).toISOString() })));
  app.post<{ Params: { id: string } }>('/api/approvals/:id/decision', async (req, reply) => {
    const parsed = z.object({ decision: z.enum(['allow', 'deny']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_approval_decision' } });
    const pending = pendingApprovals.get(req.params.id);
    if (!pending) return reply.code(404).send({ error: { code: 'approval_not_found' } });
    pendingApprovals.delete(req.params.id); pending.resolve(parsed.data.decision === 'allow');
    return { id: req.params.id, decision: parsed.data.decision, resolved: true };
  });

  app.post<{ Body: TurnBody }>('/api/run/turn', async (req, reply) => {
    const b = req.body;
    if (!b?.specName)
      return reply.code(400).send({ error: { code: 'bad_request', message: 'specName required' } });
    let spec = await registry.resolve(b.specName, b.version);
    if (!spec)
      return reply.code(400).send({
        error: {
          code: 'invalid_spec',
          message: `spec not found: ${b.specName}${b.version ? '@' + b.version : ''}`,
        },
      });

    const isNew = !b.conversationId;
    const session_id = isNew ? `conv_${randomUUID()}` : b.conversationId!;
    let past: TraceEvent[] = [];
    let mode = b.mode ?? 'mock';
    if (!isNew) {
      if (!session_id.startsWith('conv_'))
        return reply.code(400).send({
          error: {
            code: 'not_a_conversation',
            message: 'Single runs cannot be continued as conversations',
          },
        });
      past = await store.readBySession(session_id).catch(() => []);
      if (past.length === 0)
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: `conversation not found: ${session_id}` } });
      const snapshot = past.find((e) => e.type === 'run.provenance');
      const pinned = (snapshot?.payload as any)?.spec;
      if (pinned) {
        spec = AgentSpecSchema.parse(pinned);
        if (spec.name !== b.specName || (b.version && b.version !== spec.version))
          return reply.code(409).send({
            error: { code: 'conversation_spec_mismatch', message: '请使用此会话原始规格' },
          });
        mode = spec.llm.provider === 'local' ? 'live' : (b.mode ?? 'mock');
        if (spec.llm.provider === 'local' && b.mode === 'mock')
          return reply.code(409).send({
            error: { code: 'conversation_mode_mismatch', message: '真实会话不能切换为模拟运行' },
          });
      }
    }

    // Build context before selecting the provider so mock replies also explain
    // which conversation turn they represent.
    const history = isNew ? [] : buildHistory(past, session_id);

    // 校验必须在 hijack 之前完成——以上分支返回普通 JSON。
    // Providers（mock 缺省；live 需 apiKey+model）
    const providers = new Map<string, LLMProvider>();
    if (mode === 'live') {
      try {
        if (b.apiKey && b.model) {
          spec = { ...spec, llm: { ...spec.llm, model: b.model } };
          providers.set(
            spec.llm.provider,
            new OpenAICompatibleProvider('https://api.openai.com/v1', b.apiKey, b.model),
          );
        } else {
          const local = createLocalModel();
          if (!isNew && spec.llm.provider === 'local' && spec.llm.model !== local.model)
            return reply.code(409).send({
              error: {
                code: 'conversation_model_changed',
                message: '服务端模型已变更，请创建新对话',
              },
            });
          spec = {
            ...spec,
            llm: { ...spec.llm, provider: 'local', model: local.model, fallback: [] },
          };
          providers.set('local', local.provider);
        }
      } catch {
        return reply.code(400).send({
          error: {
            code: 'model_not_configured',
            message: '请检查服务端 .env.local 模型配置并重启研究服务',
          },
        });
      }
    } else {
      const mock = new MockScriptedProvider();
      const defaultMock = history.length
        ? JSON.stringify({
            text: `已收到第 ${history.length / 2 + 1} 轮消息。当前为模拟响应。`,
            done: true,
          })
        : JSON.stringify({ text: '已收到你的消息。当前为模拟响应。', done: true });
      (b.script && b.script.length ? b.script : [defaultMock]).forEach((s) => mock.enqueue(s));
      providers.set(spec.llm.provider, mock);
    }

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
    const runStep = async ({
      recorder,
      prompt,
      spec: activeSpec,
      history: stepHistory,
    }: RunnerStepCtx) => {
      const req: LLMRequest = {
        provider: activeSpec.llm.provider,
        model: activeSpec.llm.model,
        messages: [
          { role: 'system', content: activeSpec.instruction.system },
          ...(stepHistory ?? history).map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: prompt },
        ],
      };
      const res = await gateway.stream(req, recorder, (chunk) => {
        if (!doneSending.value) send({ type: 'token', session_id, text: chunk });
      });
      const d = parseDecision(res.text);
      return {
        text: d.text ?? res.text,
        tool: d.tool,
        // A natural-language response completes one conversation turn.
        // Continue only when the model explicitly requests a tool/delegation.
        done: d.done ?? (!d.tool && !d.delegate),
        delegate: d.delegate,
        task: d.task,
      };
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
            if (seq > lastSeq) {
              send({ type: 'event', event: ev });
              lastSeq = seq;
            }
          }
        } catch {
          // 忽略 poll 错误
        }
      }, 150);

      const deps: SpecRunnerDeps = {
        store,
        providers,
        tools: resolveTools(spec.tools.map((t) => t.name)),
        tenant_id: tenantId(req),
        session_id,
        historyMessages: history,
        runStep,
        childRunStep: runStep,
        registry,
        onAsk: async (tool, args) => {
          const id = `approval_${randomUUID()}`;
          const expires = Date.now() + 5 * 60_000;
          const request = { approval_id: id, session_id, tool: tool.name, args, side_effect: tool.side_effect ?? 'none' };
          const allowed = await new Promise<boolean>((resolve) => {
            pendingApprovals.set(id, { request, resolve, expires });
            void appendApprovalEvent(store, session_id, spec.version, 'approval.requested', 'request', request, tenantId(req));
            setTimeout(() => { const pending = pendingApprovals.get(id); if (pending) { pendingApprovals.delete(id); pending.resolve(false); } }, 5 * 60_000).unref();
          });
          void appendApprovalEvent(store, session_id, spec.version, 'approval.resolved', 'response', { approval_id: id, allowed }, tenantId(req));
          return allowed;
        },
        // 未传 stepBoundary：turn 连续执行，每步不暂停（断连时靠 clearPoll/abort 收尾）
      };
      const prompt = b.prompt ?? 'hello';

      const result = isNew
        ? await runSpec({ ...deps, turn: true, firstTurn: true }, spec, prompt)
        : await runSpecTurn(deps, spec, prompt);
      // 收尾 flush：补推尚未轮询到的剩余事件 + turn_end + done
      const evs = await store.readBySession(session_id);
      for (const ev of evs) {
        const seq = ev.seq ?? 0;
        if (seq > lastSeq) {
          send({ type: 'event', event: ev });
          lastSeq = seq;
        }
      }
      send({ type: 'turn_end', session_id });
      send({ type: 'done', session_id, event_count: evs.length, outcome: result.outcome });
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e), session_id });
    } finally {
      if (poll) clearInterval(poll);
      abort();
    }
  });
}
