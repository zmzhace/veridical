import { describe, expect, it, vi } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { contentHash, InvocationRecorder, Session, type AgentLoop } from '@veridical/runtime';
import {
  AgentSpecSchema,
  InMemorySpecRegistry,
  runSpec,
  runSpecTurn,
  type SpecRunnerDeps,
} from '@veridical/spec';
import {
  exportGRPO,
  fixtureHash,
  projectInvocations,
  projectTrajectory,
  ReplayCursor,
  ReplayEngine,
} from '../src';
import type { ToolDef } from '@veridical/tools';

const usage = { input: 2, output: 3, cached: 0, total: 5 };
const makeSpec = (name: string, names: string[], max_steps = 2) =>
  AgentSpecSchema.parse({
    name,
    version: '1.0.0',
    schema_version: 1,
    instruction: { system: name },
    flow: { mode: 'single-loop', max_steps },
    llm: { provider: 'mock', model: 'm' },
    tools: names.map((name) => ({ name, access: 'allow' })),
  });
const library: ToolDef[] = ['tool1', 'tool2', 'tool3', 'finish'].map((name) => ({
  name,
  id: name,
  version: '1',
  description: name,
  deterministic: true,
  execute: async (args) => ({ tool: name, args }),
}));

async function scenario() {
  const store = new InMemoryTraceStore(),
    registry = new InMemorySpecRegistry();
  const first = makeSpec('agent1', ['tool1', 'tool2']),
    second = makeSpec('agent2', ['tool3', 'tool2']);
  const hub = AgentSpecSchema.parse({
    ...makeSpec('hub', ['finish'], 3),
    flow: { mode: 'supervisor', max_steps: 3 },
    agents: [first, second].map((s) => ({ name: s.name, spec_ref: s.name + '@1.0.0' })),
  });
  for (const s of [first, second, hub]) await registry.register(s);
  let parentStep = 0;
  const provider = {
    complete: vi.fn(async (req: { messages: unknown[] }) => {
      const messages = req.messages as { role: string; content: string }[];
      const name = messages[0].content;
      const previous = messages.some((m) => m.content.includes('"result"'));
      const tool = previous ? 'tool2' : name === 'agent1' ? 'tool1' : 'tool3';
      return {
        text: JSON.stringify({
          text: name,
          tool: { name: tool, args: { agent: name, index: previous ? 2 : 1 } },
        }),
        usage,
      };
    }),
  };
  const callback: SpecRunnerDeps['runStep'] = async () =>
    ++parentStep <= 2
      ? { text: '', delegate: 'agent' + parentStep, task: 'task' + parentStep }
      : { text: '', tool: { name: 'finish', args: { done: true } } };
  const original = await runSpec(
    {
      store,
      registry,
      tenant_id: 't',
      session_id: 'source',
      tools: library,
      providers: new Map([['mock', provider]]),
      runStep: callback,
      release_artifact_hash: 'a'.repeat(64),
    },
    hub,
    'compare',
  );
  return {
    store,
    registry,
    original,
    hub,
    first,
    second,
    provider,
    engine: new ReplayEngine(store, registry),
  };
}

describe('complete invocation graph and replay', () => {
  it('records real child LLMs and two children sharing a tool without crossing inputs or outputs', async () => {
    const { original, provider } = await scenario();
    expect(provider.complete).toHaveBeenCalledTimes(4);
    const graph = projectInvocations(original.events);
    const calls = graph.filter((i) => i.actor === 'tool');
    expect(calls.map((i) => i.path)).toEqual([
      'root/delegate:agent1/tool:tool1#1',
      'root/delegate:agent1/tool:tool2#1',
      'root/delegate:agent2/tool:tool3#1',
      'root/delegate:agent2/tool:tool2#1',
      'root/tool:finish#1',
    ]);
    for (const call of calls) {
      expect(call.status).toBe('success');
      expect(call.output).toEqual({ tool: call.operation, args: (call.input as any).args });
      expect(call.end_seq).toBeGreaterThan(call.start_seq);
      const parent = graph.find((i) => i.invocation_id === call.parent_invocation_id)!;
      expect(parent.path).toBe(call.path.slice(0, call.path.lastIndexOf('/')));
    }
    expect(graph.filter((i) => i.operation === 'agent.dispatch').map((i) => i.output)).toEqual([
      { tool: 'tool2', args: { agent: 'agent1', index: 2 } },
      { tool: 'tool2', args: { agent: 'agent2', index: 2 } },
    ]);
  });

  it('strictly replays the full child graph without live model or tool execution', async () => {
    const { engine, provider } = await scenario();
    const replay = await engine.replay('source', { spec: { name: 'hub' } }, library);
    expect(replay).toMatchObject({
      identical: true,
      degraded: false,
      external_calls: 0,
      mode: 'strict',
    });
    expect(provider.complete).toHaveBeenCalledTimes(4);
    expect(
      projectInvocations(replay.events).filter((i) => i.operation === 'agent.dispatch'),
    ).toHaveLength(2);
  });

  it('rejects a changed child spec, missing child, and changed tool artifact', async () => {
    const s = await scenario();
    const missing = new InMemorySpecRegistry();
    await missing.register(s.hub);
    await expect(
      new ReplayEngine(s.store, missing).replay('source', { spec: { name: 'hub' } }, library),
    ).rejects.toMatchObject({ code: 'replay_child_agent_missing' });
    const changed = new InMemorySpecRegistry();
    for (const spec of [s.hub, s.second, { ...s.first, instruction: { system: 'changed' } }])
      await changed.register(spec);
    await expect(
      new ReplayEngine(s.store, changed).replay('source', { spec: { name: 'hub' } }, library),
    ).rejects.toHaveProperty('code');
    await expect(
      s.engine.replay(
        'source',
        { spec: { name: 'hub' } },
        library.map((t) => ({ ...t, version: '2' })),
      ),
    ).rejects.toMatchObject({ code: 'replay_manifest_mismatch' });
  });

  it('does not consume a tool response on argument mismatch', async () => {
    const { original } = await scenario();
    const cursor = new ReplayCursor(original.events),
      path = 'root/delegate:agent2/tool:tool2#1';
    expect(() => cursor.nextTool(path, 'tool2', { agent: 'agent1', index: 2 })).toThrow(
      'replay_tool_argument_mismatch',
    );
    expect(cursor.nextTool(path, 'tool2', { agent: 'agent2', index: 2 })).toEqual({
      tool: 'tool2',
      args: { agent: 'agent2', index: 2 },
    });
    expect(() => cursor.nextTool(path, 'tool2', {})).toThrow('replay_miss');
  });

  it('uses immutable path-bound fixtures, audits degradation, and rejects a bad fingerprint', async () => {
    const { original, engine } = await scenario();
    const call = projectInvocations(original.events).find((i) => i.path === 'root/tool:finish#1')!;
    const body = {
      path: call.path,
      operation: call.operation,
      fingerprint: call.fingerprint,
      output: { repaired: true },
      source: 'golden-local',
      version: '1',
    };
    const fixture = { ...body, hash: fixtureHash(body) };
    const plan = {
      mode: 'fixture' as const,
      spec: { name: 'hub' },
      downgrade_reason: 'external snapshot unavailable',
      invocation_fixtures: [fixture],
    };
    const before = JSON.stringify(plan);
    const result = await engine.replay('source', plan, library);
    expect(result).toMatchObject({
      mode: 'fixture',
      identical: false,
      degraded: true,
      fixtures_used: 1,
      outcome: { repaired: true },
    });
    expect(result.events.some((e) => e.type === 'replay.degraded')).toBe(true);
    expect(JSON.stringify(plan)).toBe(before);
    const bad = { ...body, fingerprint: '0'.repeat(64) };
    await expect(
      engine.replay(
        'source',
        { ...plan, invocation_fixtures: [{ ...bad, hash: fixtureHash(bad) }] },
        library,
      ),
    ).rejects.toMatchObject({ code: 'replay_fingerprint_mismatch' });
  });

  it('semantic replay applies quality, tool, agent, steps, token and golden gates', async () => {
    const { engine, original } = await scenario();
    const result = await engine.replay(
      'source',
      {
        mode: 'semantic',
        downgrade_reason: 'evaluate',
        spec: { name: 'hub' },
        semantic: {
          expected_outcome: original.outcome,
          required_tools: ['tool1', 'tool2', 'tool3'],
          forbidden_tools: ['send'],
          completed_agents: ['agent1', 'agent2'],
          max_steps: 7,
          max_tokens: 20,
          golden: { outcome: original.outcome },
        },
      },
      library,
    );
    expect(result).toMatchObject({ passed: true, identical: false, degraded: true });
    const failure = await engine.replay(
      'source',
      {
        mode: 'semantic',
        downgrade_reason: 'cost regression',
        spec: { name: 'hub' },
        semantic: { max_tokens: 0, forbidden_tools: ['tool2'] },
      },
      library,
    );
    expect(failure.passed).toBe(false);
    expect(failure.differences.map((d: any) => d.path)).toContain('max_tokens');
  });

  it('exports deterministic per-child trajectories with explicit reward ownership and complete LLM messages', async () => {
    const { original } = await scenario();
    const options = {
      path: 'root/delegate:agent1',
      scope: 'tree' as const,
      rewards: { 'root/delegate:agent1/decision#1@1': 0.75 },
      group_id: 'compare-v1',
    };
    const steps = projectTrajectory(original.events, options);
    expect(steps.every((s) => s.path.startsWith(options.path))).toBe(true);
    expect(steps.find((s) => s.path.endsWith('decision#1'))?.reward).toBe(0.75);
    expect(steps.find((s) => s.path.endsWith('decision#2'))?.reward).toBeNull();
    expect(
      (steps.find((s) => s.action.actor === 'llm')?.action.input as any).messages[0].content,
    ).toBe('agent1');
    const jsonl = exportGRPO(original.events, options);
    expect(exportGRPO(original.events, options)).toBe(jsonl);
    const rows = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({
      release_artifact_hash: 'a'.repeat(64),
      group_id: 'compare-v1',
      reward: 0.75,
      training_ready: true,
    });
    expect(rows[0].tools[0]).toMatchObject({
      tool_input: { agent: 'agent1', index: 1 },
      tool_output: { tool: 'tool1' },
    });
  });

  it('replays streaming chunks and multiple conversation turns by isolated paths', async () => {
    const store = new InMemoryTraceStore(),
      registry = new InMemorySpecRegistry(),
      spec = makeSpec('stream', [], 1);
    await registry.register(spec);
    const provider = {
      complete: async () => ({ text: 'unused', usage }),
      async *stream() {
        yield 'a';
        yield 'b';
      },
    };
    const deps: SpecRunnerDeps = {
      store,
      registry,
      tenant_id: 't',
      session_id: 'stream',
      tools: [],
      providers: new Map([['mock', provider]]),
      runStep: async ({ llm, recorder, prompt }) =>
        llm.stream(
          { provider: 'mock', model: 'm', messages: [{ role: 'user', content: prompt }] },
          recorder,
        ),
    };
    await runSpec(deps, spec, 'first');
    await runSpecTurn(deps, spec, 'second');
    const replay = await new ReplayEngine(store, registry).replay(
      'stream',
      { spec: { name: 'stream' } },
      [],
    );
    expect(replay.identical).toBe(true);
    expect(
      replay.events
        .filter((e) => e.type === 'llm.stream_chunk')
        .map((e) => [e.path, (e.payload as any).text]),
    ).toEqual([
      ['root/decision#1/llm#1', 'a'],
      ['root/decision#1/llm#1', 'b'],
      ['root/turn#2/decision#1/llm#1', 'a'],
      ['root/turn#2/decision#1/llm#1', 'b'],
    ]);
  });

  it('keeps retry attempts on the same path and redacts secrets with integrity markers', async () => {
    const store = new InMemoryTraceStore();
    const recorder = InvocationRecorder.root(
      store,
      new Session({ session_id: 'retry', tenant_id: 't', spec_version: '1' }),
      {},
    );
    await recorder.start();
    let attempts = 0;
    await recorder.retry(
      'tool',
      'fetch',
      'tool:fetch',
      { apiKey: 'sensitive' },
      async () => {
        if (++attempts === 1) throw new Error('transient');
        return { authorization: 'private', data: [1, 2] };
      },
      { maxAttempts: 2, shouldRetry: () => true },
    );
    await recorder.end('done');
    const events = await store.readBySession('retry'),
      graph = projectInvocations(events);
    expect(
      graph.filter((i) => i.actor === 'tool').map((i) => [i.path, i.attempt, i.status]),
    ).toEqual([
      ['root/tool:fetch#1', 1, 'failed'],
      ['root/tool:fetch#1', 2, 'success'],
    ]);
    expect(JSON.stringify(events)).not.toContain('sensitive');
    expect(JSON.stringify(events)).not.toContain('private');
    expect((graph[1].input as any).apiKey).toEqual({
      redacted: true,
      hash: contentHash('sensitive'),
      policy: 'invocation-v1',
    });
    expect(() => exportGRPO(events, { group_id: 'g' })).toThrow('require explicit curation');
  });

  it('records parallel child branches and an explicit join independently of finish order', async () => {
    const s = await scenario();
    let reverse = false;
    const parallel: AgentLoop = {
      kind: 'parallel',
      run: async (ctx) => {
        const tasks = [
          { delegate: 'agent1', task: 'one' },
          { delegate: 'agent2', task: 'two' },
        ];
        const results = await ctx.dispatchMany!(reverse ? tasks.reverse() : tasks);
        await ctx.recorder.record({
          span_id: 'parallel',
          parent_span_id: null,
          type: 'turn/end',
          verb: 'response',
          attempt: 1,
          duration_ms: 0,
          payload: { outcome: results },
        });
      },
    };
    const spec = {
      ...s.hub,
      name: 'parallel',
      flow: { ...s.hub.flow, loop: { engine: 'parallel', strategy: 'direct' } },
    };
    await s.registry.register(spec);
    await runSpec(
      {
        store: s.store,
        registry: s.registry,
        tenant_id: 't',
        session_id: 'parallel',
        providers: new Map([['mock', s.provider]]),
        tools: library,
        loops: new Map([['parallel', parallel]]),
      },
      spec,
      'parallel',
    );
    const result = await s.engine.replay('parallel', { spec: { name: 'parallel' } }, library, {
      loops: new Map([['parallel', parallel]]),
    });
    expect(result.identical).toBe(true);
    expect(projectInvocations(result.events).filter((i) => i.actor === 'join')).toHaveLength(1);
    reverse = true;
    const semantic = await s.engine.replay(
      'parallel',
      {
        mode: 'semantic',
        downgrade_reason: 'reverse scheduling order',
        spec: { name: 'parallel' },
        semantic: {
          completed_agents: ['agent1', 'agent2'],
          required_tools: ['tool1', 'tool2', 'tool3'],
        },
      },
      library,
      { loops: new Map([['parallel', parallel]]) },
    );
    expect(semantic).toMatchObject({ passed: true, identical: false });
    expect(semantic.differences.length).toBeGreaterThan(0);
  });

  it.each(['stage-gate', 'research'] as const)(
    'strictly replays the %s loop with checkpoints',
    async (engine) => {
      const store = new InMemoryTraceStore(),
        registry = new InMemorySpecRegistry();
      const names = engine === 'research' ? ['research_search', 'research_verify'] : ['tool1'];
      const tools = names.map((name) => ({ ...library[0], name, id: name }));
      const spec = AgentSpecSchema.parse({
        ...makeSpec(engine, names, 2),
        flow:
          engine === 'research'
            ? { loop: { engine }, max_steps: 2 }
            : {
                mode: 'stage-gate',
                max_steps: 2,
                stages: [{ id: 'review', gate: { tool_called: 'tool1' } }, { id: 'complete' }],
              },
      });
      await registry.register(spec);
      await runSpec(
        {
          store,
          registry,
          tenant_id: 't',
          session_id: engine,
          tools,
          providers: new Map([['mock', { complete: async () => ({ text: 'evidence', usage }) }]]),
          runStep:
            engine === 'stage-gate'
              ? async () => ({ text: '', tool: { name: 'tool1', args: {} } })
              : undefined,
        },
        spec,
        'question',
      );
      const replay = await new ReplayEngine(store, registry).replay(
        engine,
        { spec: { name: engine } },
        tools,
      );
      expect(replay.identical).toBe(true);
      expect(replay.events.some((e) => e.type === 'state.checkpoint')).toBe(true);
    },
  );

  it('strictly reproduces a cancelled boundary without starting a model request', async () => {
    const store = new InMemoryTraceStore(),
      registry = new InMemorySpecRegistry(),
      spec = makeSpec('cancel', [], 1);
    await registry.register(spec);
    const controller = new AbortController();
    controller.abort();
    const complete = vi.fn(async () => ({ text: 'should not run', usage }));
    await expect(
      runSpec(
        {
          store,
          registry,
          tenant_id: 't',
          session_id: 'cancel',
          tools: [],
          providers: new Map([['mock', { complete }]]),
          signal: controller.signal,
        },
        spec,
        'cancel',
      ),
    ).rejects.toThrow();
    const replay = await new ReplayEngine(store, registry).replay(
      'cancel',
      { spec: { name: 'cancel' } },
      [],
    );
    expect(replay.identical).toBe(true);
    expect(projectInvocations(replay.events)[0].status).toBe('cancelled');
    expect(complete).not.toHaveBeenCalled();
  });

  it('replays tool timeout and failure records rather than silently using a success queue', async () => {
    const store = new InMemoryTraceStore(),
      registry = new InMemorySpecRegistry(),
      spec = makeSpec('timeout', ['tool1'], 1);
    await registry.register(spec);
    const tools = [
      { ...library[0], timeout_ms: 5, execute: async () => new Promise<never>(() => {}) },
    ];
    await expect(
      runSpec(
        {
          store,
          registry,
          tenant_id: 't',
          session_id: 'timeout',
          tools,
          providers: new Map([['mock', { complete: async () => ({ text: '', usage }) }]]),
          runStep: async () => ({ text: '', tool: { name: 'tool1', args: {} } }),
        },
        spec,
        'timeout',
      ),
    ).rejects.toThrow();
    const replay = await new ReplayEngine(store, registry).replay(
      'timeout',
      { spec: { name: 'timeout' } },
      tools,
    );
    expect(replay.identical).toBe(true);
    expect(projectInvocations(replay.events).find((i) => i.actor === 'tool')).toMatchObject({
      status: 'failed',
      error: { code: 'TimeoutError' },
    });
    const failedCall = projectInvocations(await store.readBySession('timeout')).find(
      (i) => i.actor === 'tool',
    )!;
    const body = {
      path: failedCall.path,
      operation: failedCall.operation,
      fingerprint: failedCall.fingerprint,
      source: 'recovered-read-snapshot',
      version: '1',
      output: { recovered: true },
    };
    const recovered = await new ReplayEngine(store, registry).replay(
      'timeout',
      {
        mode: 'fixture',
        downgrade_reason: 'replace timed-out read',
        spec: { name: 'timeout' },
        invocation_fixtures: [{ ...body, hash: fixtureHash(body) }],
      },
      tools,
    );
    expect(recovered).toMatchObject({
      identical: false,
      degraded: true,
      fixtures_used: 1,
      outcome: { recovered: true },
    });
  });

  it('records memory input and full hits and replays them without a memory backend', async () => {
    const store = new InMemoryTraceStore(),
      registry = new InMemorySpecRegistry(),
      spec = makeSpec('memory', [], 1);
    await registry.register(spec);
    const recall = vi.fn(async () => [
      { key: 'known', value: { evidence: 'value' }, scope: 'session' },
    ]);
    await runSpec(
      {
        store,
        registry,
        tenant_id: 't',
        session_id: 'memory',
        tools: [],
        providers: new Map([['mock', { complete: async () => ({ text: 'answer', usage }) }]]),
        memory: { recall },
      },
      spec,
      'question',
    );
    const result = await new ReplayEngine(store, registry).replay(
      'memory',
      { spec: { name: 'memory' } },
      [],
    );
    expect(result.identical).toBe(true);
    expect(recall).toHaveBeenCalledTimes(1);
    expect(projectInvocations(result.events).find((i) => i.actor === 'memory')?.output).toEqual([
      { key: 'known', value: { evidence: 'value' }, scope: 'session' },
    ]);
  });

  it('refuses legacy traces and incomplete graphs instead of claiming identical', async () => {
    const s = await scenario();
    await s.store.appendNext({
      tenant_id: 't',
      session_id: 'legacy',
      spec_version: '1',
      span_id: 'legacy',
      parent_span_id: null,
      type: 'spec/run/start',
      verb: 'request',
      attempt: 1,
      duration_ms: 0,
      payload: {},
    });
    await expect(
      s.engine.replay('legacy', { spec: { name: 'hub' } }, library),
    ).rejects.toMatchObject({ code: 'replay_legacy_trace' });
    const recorder = InvocationRecorder.root(
      s.store,
      new Session({ tenant_id: 't', session_id: 'incomplete', spec_version: '1' }),
      {},
    );
    await recorder.start();
    await expect(
      s.engine.replay('incomplete', { spec: { name: 'hub' } }, library),
    ).rejects.toMatchObject({ code: 'replay_incomplete' });
  });
});
