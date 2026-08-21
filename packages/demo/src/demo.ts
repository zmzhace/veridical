import { JsonlTraceStore } from '@rt/store';
import { Session, Recorder, runSingleLoop, type FlowContext } from '@rt/runtime';
import { ToolBroker, type ApprovalPolicy } from '@rt/tools';
import { LLMGateway, MockProvider } from '@rt/llm';
import { createHash } from 'node:crypto';

export function demoFingerprint(text: string): string {
  return createHash('sha256').update(JSON.stringify({ provider: 'mock', model: 'm', messages: [{ role: 'user', content: text }] })).digest('hex');
}

export async function runDemo(dir: string) {
  const store = new JsonlTraceStore(dir);
  const session = new Session({ session_id: 's1', tenant_id: 't1', spec_version: '0.0.1' });
  const recorder = new Recorder(store, session);
  let stepCalls = 0;

  const mock = new MockProvider();
  mock.record(demoFingerprint('hello'), 'call echo', { input: 1, output: 1, cached: 0, total: 2 });
  const llm = new LLMGateway(new Map([['mock', mock]]));

  const tools = new ToolBroker(
    [{ id: 'echo', name: 'echo', description: 'echo', deterministic: true, execute: async (a) => a }],
    { decide: async () => 'allow' } satisfies ApprovalPolicy
  );

  const ctx: FlowContext = {
    recorder,
    async runStep() {
      const res = await llm.complete({ messages: [{ role: 'user', content: 'hello' }], model: 'm', provider: 'mock' }, recorder);
      if (stepCalls === 0) {
        stepCalls += 1;
        return { text: res.text, tool: { name: 'echo', args: { x: 1 } } };
      }
      return { text: res.text };
    },
    async executeTool(name, args) { return (await tools.call(name, args)).ok ? 'echoed' : 'failed'; },
    shouldStop() { return false; },
    verifyToolResult() { return true; },
    maxSteps: 2,
  };

  await runSingleLoop(ctx, 'hello');
  return store;
}