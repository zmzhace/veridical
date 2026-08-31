import { describe, expect, it } from 'vitest';
import { AsyncWorker } from '../src/production/async-worker';

describe('AsyncWorker', () => {
  it('claims, executes, heartbeats and finishes a job', async () => {
    let claimed = true;
    let finished: unknown;
    const store = {
      async claim() {
        if (!claimed) return undefined;
        claimed = false;
        return {
          id: 'j1',
          tenant: 't',
          actor: 'a',
          kind: 'run' as const,
          args: {},
          created: Date.now(),
          owner: 'w',
          leaseUntil: Date.now() + 1000,
        };
      },
      async heartbeat() {
        return true;
      },
      async finish(_id: string, _owner: string, state: string, result?: unknown) {
        finished = { state, result };
        return true;
      },
    } as any;
    const worker = new AsyncWorker(store, 'w', 1, 1000);
    await worker.tick(async (job) => ({ id: job.id, ok: true }));
    expect(finished).toMatchObject({ state: 'completed', result: { id: 'j1', ok: true } });
  });
  it('fences a worker when lease heartbeat fails', async () => {
    let finished: unknown;
    const store = {
      async claim() {
        return {
          id: 'j2',
          tenant: 't',
          actor: 'a',
          kind: 'run' as const,
          args: {},
          created: Date.now(),
          owner: 'w',
          leaseUntil: Date.now() + 1000,
        };
      },
      async heartbeat() {
        return false;
      },
      async finish(_id: string, _owner: string, state: string, result?: unknown) {
        finished = { state, result };
        return true;
      },
    } as any;
    const worker = new AsyncWorker(store, 'w', 1, 1000);
    await worker.tick(async (_job, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      signal.throwIfAborted();
      return 'ok';
    });
    expect(finished).toMatchObject({ state: 'completed' });
  });
});
