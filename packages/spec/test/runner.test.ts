import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { ToolBroker, type ToolDef } from '@veridical/tools';
import type { LLMProvider } from '@veridical/llm';
import { parseSpecYaml, runSpec, runSpecTurn, SpecRunError, SpecApprovalPolicy, InMemorySpecRegistry, type SpecRunnerDeps } from '../src/index';
import { StageGateError } from '@veridical/runtime';

const SPEC_YAML = `
name: runner-test
version: 1.0.0
schema_version: 1
instruction:
  system: You are a test agent.
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: main
  model: m
  fallback:
    - provider: backup
      model: b
tools:
  - name: echo
    access: allow
`;

const usage = { input: 1, output: 1, cached: 0, total: 2 };
function provider(text: string): LLMProvider {
  return { complete: async () => ({ text, usage }) };
}
function echoTool(): ToolDef {
  return { id: 'echo', name: 'echo', description: '', deterministic: true, execute: async (a) => a };
}

describe('runSpec', () => {
  it('runs a single-loop spec and records spec-bound events', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const result = await runSpec(
      { store, providers: new Map([['main', provider('hi')], ['backup', provider('boo')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    const types = result.events.map(e => e.type);
    for (const t of ['spec/run/start', 'turn/start', 'llm.request', 'llm.response', 'turn/end', 'spec/run/end']) {
      expect(types).toContain(t);
    }
    expect(result.spec_name).toBe('runner-test');
    expect(result.spec_version).toBe('1.0.0');
    expect(result.outcome).toBe('hi');
  });

  it('injects governed knowledge context and records a path-aware knowledge invocation', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    let requestSystem = '';
    const result = await runSpec({
      store,
      providers: new Map([['main', { complete: async (req) => { requestSystem = String(req.messages[0]?.content); return { text: 'knowledge answer', usage }; } }]]),
      tools: [], tenant_id: 't1', session_id: 'knowledge-session',
      knowledge: { contextPack: async () => ({ summary: '事实证据：项目使用 Postgres。', citations: [{ source_id: 'doc-1' }], snapshot_hash: 'snapshot-1' }) },
    }, spec, '项目存储是什么？');
    expect(requestSystem).toContain('事实证据');
    expect(result.events.some((event) => event.type === 'invocation.start' && (event.payload as any)?.actor === 'knowledge')).toBe(true);
    expect(result.events.find((event) => event.type === 'invocation.start' && (event.payload as any)?.actor === 'knowledge')?.path).toContain('knowledge:context-pack');
  });

  it('records a denied event for a library tool excluded by the spec whitelist', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const otherTool: ToolDef = { id: 'other', name: 'other', description: '', deterministic: true, execute: async (a) => a };
    const result = await runSpec(
      {
        store,
        providers: new Map([['main', provider('x')]]),
        tools: [echoTool(), otherTool],
        tenant_id: 't1',
        session_id: 's1',
        runStep: async () => ({ text: '', tool: { name: 'other', args: {} } }),
      },
      spec,
      'hello',
    );
    const denied = result.events.find(e => e.type === 'tool.result' && (e.payload as any)?.result?.reason === 'denied');
    expect(denied).toBeDefined();
    expect(denied?.verb).toBe('error');
    expect(result.events.filter(e => e.type === 'step/end').every(e => e.verb === 'error')).toBe(true);
  });

  it('falls back when the primary provider fails', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    const result = await runSpec(
      { store, providers: new Map([['main', boom], ['backup', provider('saved')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    expect(result.outcome).toBe('saved');
    expect(result.events.some(e => e.type === 'llm.response' && e.verb === 'error')).toBe(true);
    const requests = result.events.filter(e => e.type === 'llm.request');
    const responses = result.events.filter(e => e.type === 'llm.response');
    expect(responses).toHaveLength(requests.length);
    expect(responses.every(e => typeof (e.payload as any).fingerprint === 'string')).toBe(true);
  });

  it('throws SpecRunError when all providers fail', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    await expect(
      runSpec({ store, providers: new Map([['main', boom], ['backup', boom]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);
  });

  it('persists an error spec/run/end event when all providers fail', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const boom: LLMProvider = { complete: async () => { throw new Error('boom'); } };
    await expect(
      runSpec({ store, providers: new Map([['main', boom], ['backup', boom]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);

    const events = await store.readBySession('s1');
    const start = events.find(e => e.type === 'spec/run/start');
    const end = events.find(e => e.type === 'spec/run/end');
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(end?.verb).toBe('error');
    expect((end?.payload as { message?: string } | undefined)?.message).toContain('all LLM providers failed');
  });

  it('throws SpecRunError when the primary provider is not registered', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    await expect(
      runSpec({ store, providers: new Map([['other', provider('x')]]), tools: [], tenant_id: 't1', session_id: 's1' }, spec, 'hello'),
    ).rejects.toThrow(SpecRunError);
  });

  it('stops at max_steps', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(SPEC_YAML);
    const result = await runSpec(
      { store, providers: new Map([['main', provider('hi')]]), tools: [], tenant_id: 't1', session_id: 's1' },
      spec,
      'hello',
    );
    expect(result.events.filter(e => e.type === 'llm.request').length).toBe(2);
  });
});

describe('SpecApprovalPolicy', () => {
  it('allows whitelisted tools and denies others', async () => {
    const spec = parseSpecYaml(SPEC_YAML);
    const policy = new SpecApprovalPolicy(spec);
    expect(await policy.decide(echoTool(), {})).toBe('allow');
    expect(await policy.decide({ id: 'x', name: 'x', description: '', deterministic: true, execute: async (a) => a }, {})).toBe('deny');
  });

  it('delegates ask to the injected callback', async () => {
    const spec = parseSpecYaml(SPEC_YAML.replace('- name: echo\n    access: allow', '- name: echo\n    access: ask'));
    const policy = new SpecApprovalPolicy(spec, async () => true);
    expect(await policy.decide(echoTool(), {})).toBe('ask');
    expect(await policy.onAsk!(echoTool(), {})).toBe(true);
  });
});

describe('ToolBroker integration', () => {
  it('broker returns denied for a library tool excluded by the spec whitelist', async () => {
    const spec = parseSpecYaml(SPEC_YAML);
    const otherTool: ToolDef = { id: 'other', name: 'other', description: '', deterministic: true, execute: async (a) => a };
    const broker = new ToolBroker([echoTool(), otherTool], new SpecApprovalPolicy(spec));
    const r = await broker.call('other', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('denied');
  });
});

const EXPERT_SPEC = `
name: claims-agent
version: 1.0.0
schema_version: 1
instruction: { system: you are a claims agent }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: query_claims
    access: allow
`;

describe('supervisor runSpec', () => {
  it('dispatches to an expert agent with nested span in same session', async () => {
    const store = new InMemoryTraceStore();
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(EXPERT_SPEC));
    const hub = parseSpecYaml(`
name: hub
version: 1.0.0
schema_version: 1
instruction: { system: you are a hub }
flow: { mode: supervisor, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
agents:
  - name: claims-agent
    spec_ref: claims-agent@1.0.0
`);
    const deps: SpecRunnerDeps = {
      store, registry,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [{ id: 'query_claims', name: 'query_claims', description: '', deterministic: true, execute: async (a) => a }],
      tenant_id: 't1',
      session_id: 'hub_s1',
      runStep: async () => ({ delegate: 'claims-agent', task: '查理赔' }),
      childRunStep: async () => ({ text: '', tool: { name: 'query_claims', args: { task: '查理赔' } } }),
    };
    const result = await runSpec(deps, hub, '客户问理赔');
    const events = await store.readBySession('hub_s1');
    const types = events.map(e => e.type);
    expect(types).toContain('agent.dispatch');
    expect(types).toContain('agent.result');
    // expert events nested under the dispatch
    const dispatchEvt = events.find(e => e.type === 'agent.dispatch')!;
    const expertEvt = events.find(e => e.type === 'invocation.start' && e.path === 'root/delegate:claims-agent')!;
    const root = events.find(e => e.type === 'invocation.start' && e.path === 'root')!;
    expect(expertEvt.parent_invocation_id).toBe(root.invocation_id);
    expect(dispatchEvt.invocation_id).toBe(expertEvt.invocation_id);
    expect(result.events.length).toBe(events.length);
    // expert acts on the task via its declared tool
    expect(types).toContain('tool.called');
    const toolEvt = events.find(e => e.type === 'tool.called');
    expect(toolEvt?.payload?.name).toBe('query_claims');
  });

  it('throws SpecRunError when dispatch targets an unknown agent', async () => {
    const store = new InMemoryTraceStore();
    const registry = new InMemorySpecRegistry();
    const hub = parseSpecYaml(`
name: hub
version: 1.0.0
schema_version: 1
instruction: { system: you are a hub }
flow: { mode: supervisor, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
agents:
  - name: claims-agent
    spec_ref: claims-agent@1.0.0
`);
    const deps: SpecRunnerDeps = {
      store, registry,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [],
      tenant_id: 't1',
      session_id: 'hub_bad',
      runStep: async () => ({ delegate: 'ghost', task: 'x' }),
    };
    await expect(runSpec(deps, hub, 'hi')).rejects.toThrow(SpecRunError);
  });

  it('allows a model-only expert without forcing a first-tool call', async () => {
    const store = new InMemoryTraceStore();
    const registry = new InMemorySpecRegistry();
    await registry.register(parseSpecYaml(`
name: no-tool-agent
version: 1.0.0
schema_version: 1
instruction: { system: you are a no-tool agent }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`));
    const hub = parseSpecYaml(`
name: hub
version: 1.0.0
schema_version: 1
instruction: { system: you are a hub }
flow: { mode: supervisor, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
agents:
  - name: no-tool-agent
    spec_ref: no-tool-agent@1.0.0
`);
    const deps: SpecRunnerDeps = {
      store, registry,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [],
      tenant_id: 't1',
      session_id: 'hub_no_tool',
      runStep: async () => ({ delegate: 'no-tool-agent', task: 'x' }),
    };
    await runSpec(deps, hub, 'hi');
    const events = await store.readBySession('hub_no_tool');
    expect(events.filter(e => e.type === 'agent.dispatch' && e.verb === 'request').length).toBe(2);
    expect(events.some(e => e.type === 'llm.request' && e.path?.startsWith('root/delegate:no-tool-agent'))).toBe(true);
    expect(events.some(e => e.type === 'tool.called')).toBe(false);
  });
});

const STAGE_SPEC = `
name: transfer-advisor
version: 1.0.0
schema_version: 1
instruction: { system: 你是转保顾问 }
flow:
  mode: stage-gate
  max_steps: 3
  stages:
    - id: health_check
      gate: { tool_called: verify_health }
    - id: close
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: verify_health
    access: allow
  - name: submit_transfer
    access: allow
`;

describe('stage-gate runSpec', () => {
  it('runs stages when gates satisfied', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(STAGE_SPEC);
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [
        { id: 'verify_health', name: 'verify_health', description: '', deterministic: true, execute: async (a) => a },
        { id: 'submit_transfer', name: 'submit_transfer', description: '', deterministic: true, execute: async (a) => a },
      ],
      tenant_id: 't1',
      session_id: 'sg_s1',
      runStep: async () => ({ text: '', tool: { name: 'verify_health', args: {} } }),
    };
    const result = await runSpec(deps, spec, '我想转保');
    const events = await store.readBySession('sg_s1');
    const types = events.map(e => e.type);
    expect(types).toContain('stage/start');
    expect(types.filter(t => t === 'stage/start')).toHaveLength(2);
    expect(types.filter(t => t === 'stage/end')).toHaveLength(2);
    expect(types).toContain('tool.called');
    expect(result.events.length).toBe(events.length);
  });

  it('throws StageGateError and records stuck_stage when gate never satisfied', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(STAGE_SPEC);
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [
        { id: 'verify_health', name: 'verify_health', description: '', deterministic: true, execute: async (a) => a },
        { id: 'submit_transfer', name: 'submit_transfer', description: '', deterministic: true, execute: async (a) => a },
      ],
      tenant_id: 't1',
      session_id: 'sg_stuck',
      runStep: async () => ({ text: '我不核验，直接聊', tool: undefined }),
    };
    await expect(runSpec(deps, spec, '我想转保')).rejects.toThrow(StageGateError);
    const events = await store.readBySession('sg_stuck');
    const runEnd = [...events].reverse().find(e => e.type === 'spec/run/end')!;
    expect(runEnd.verb).toBe('error');
    expect((runEnd.payload as any).stuck_stage).toBe('health_check');
    // did not reach stage 2
    expect(events.some(e => e.type === 'stage/start' && (e.payload as any).stage === 'close')).toBe(false);
  });
});

describe('checkpoint + stepBoundary', () => {
  it('records state.checkpoint per step and awaits stepBoundary', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(`
name: cp
version: 1.0.0
schema_version: 1
instruction: { system: hi }
flow: { mode: single-loop, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`);
    let boundaryCalls = 0;
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [],
      tenant_id: 't1',
      session_id: 'cp_s1',
      stepBoundary: async () => { boundaryCalls += 1; },
      runStep: async () => ({ text: 'ok', tool: undefined }),
    };
    await runSpec(deps, spec, 'hi');
    const events = await store.readBySession('cp_s1');
    const cps = events.filter(e => e.type === 'state.checkpoint');
    expect(cps.length).toBe(2);
    expect(boundaryCalls).toBe(2);
    const cp = cps[0];
    expect((cp.payload as any).frame).toBe(1);
    expect(Array.isArray((cp.payload as any).messages)).toBe(true);
    expect((cp.payload as any).outcome_so_far).toBe('ok');
  });

  it('does NOT call stepBoundary when not injected (compat)', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(`
name: cp2
version: 1.0.0
schema_version: 1
instruction: { system: hi }
flow: { mode: single-loop, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`);
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [],
      tenant_id: 't1',
      session_id: 'cp_s2',
      runStep: async () => ({ text: 'ok', tool: undefined }),
    };
    await runSpec(deps, spec, 'hi');
    const events = await store.readBySession('cp_s2');
    expect(events.filter(e => e.type === 'state.checkpoint').length).toBe(2);
  });
});

describe('runSpecTurn (continuation)', () => {
  const TURN_SPEC = `
name: conv
version: 1.0.0
schema_version: 1
instruction: { system: 你是助手 }
flow: { mode: single-loop, max_steps: 2 }
llm: { provider: mock, model: m, fallback: [] }
tools: []
`;

  it('appends to the same session without re-recording spec/run/start or spec/run/end', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(TURN_SPEC);
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]),
      tools: [],
      tenant_id: 't1',
      session_id: 'conv_a',
    };
    await runSpec({ ...deps, session_id: 'conv_a' } as SpecRunnerDeps, spec, '你好');
    await runSpecTurn(deps, spec, '继续');
    const events = await store.readBySession('conv_a');
    const starts = events.filter((e) => e.type === 'spec/run/start');
    const ends = events.filter((e) => e.type === 'spec/run/end');
    const turns = events.filter((e) => e.type === 'turn/start');
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(turns.length).toBe(2);
    expect((events[events.length - 1] as any).session_id).toBe('conv_a');
  });

  it('injects historyMessages before the current prompt in LLMRequest', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(TURN_SPEC);
    let seenMessages: unknown[] = [];
    const spy: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async (req: any) => { seenMessages = req.messages; return { text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }; } }]]),
      tools: [],
      tenant_id: 't1',
      session_id: 'conv_b',
      historyMessages: [{ role: 'user', content: '上一轮' }, { role: 'assistant', content: '上一轮回复' }],
    };
    await runSpecTurn(spy, spec, '这轮问题');
    expect(seenMessages).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '上一轮' },
      { role: 'assistant', content: '上一轮回复' },
      { role: 'user', content: '这轮问题' },
    ]);
  });

  it('does not inject history when historyMessages is undefined (compat)', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(TURN_SPEC);
    let seenMessages: unknown[] = [];
    const deps: SpecRunnerDeps = {
      store,
      providers: new Map([['mock', { complete: async (req: any) => { seenMessages = req.messages; return { text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }; } }]]),
      tools: [],
      tenant_id: 't1',
      session_id: 'conv_c',
    };
    await runSpec(deps, spec, '普通跑');
    expect((seenMessages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('runSpecTurn stage-gate continuation', () => {
  it('two turns drive a stage-gate spec to completion', async () => {
    const store = new InMemoryTraceStore();
    const spec = parseSpecYaml(`
name: convsg
version: 1.0.0
schema_version: 1
instruction: { system: 你是转保顾问 }
flow:
  mode: stage-gate
  max_steps: 2
  stages:
    - id: s1
      gate: { tool_called: verify_health }
    - id: s2
      gate: { tool_called: submit_transfer }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: verify_health
    access: allow
  - name: submit_transfer
    access: allow
`);
    const tools: ToolDef[] = [
      { id: 'verify_health', name: 'verify_health', description: '', deterministic: true, execute: async (a) => a },
      { id: 'submit_transfer', name: 'submit_transfer', description: '', deterministic: true, execute: async (a) => a },
    ];
    // turn1 runStep calls verify_health (s1 gate), turn2 calls submit_transfer (s2 gate)
    let turn = 0;
    const mkCtx = () => {
      const names = ['verify_health', 'submit_transfer'];
      const n = names[turn];
      return async () => ({ text: '', tool: { name: n, args: {} } });
    };
    const mkProviders = () => new Map([['mock', { complete: async () => ({ text: '', usage: { input: 1, output: 1, cached: 0, total: 2 } }) }]]);
    // turn1 = 新对话首轮：turn:true + firstTurn:true（runSpec），stage-gate 走 turn 模式，s1 过 s2 未完 → 优雅结束不抛
    await runSpec({ store, providers: mkProviders(), tools, tenant_id: 't1', session_id: 'csg', runStep: mkCtx() as any, turn: true, firstTurn: true }, spec, '我要转保');
    turn = 1;
    await runSpecTurn({ store, providers: mkProviders(), tools, tenant_id: 't1', session_id: 'csg', runStep: mkCtx() as any }, spec, '我同意提交');
    const events = await store.readBySession('csg');
    const completed = events.filter(e => e.type === 'stage/end' && e.verb === 'response').map(e => (e.payload as any).stage);
    expect(completed).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(events.filter(e => e.type === 'spec/run/start').length).toBe(1);
    expect(events.filter(e => e.type === 'turn/start').length).toBe(2);
    expect(events.some(e => e.type === 'spec/run/end')).toBe(false); // 会话不记 spec/run/end
  });
});
