import type { AsyncJobStore } from './job-store';

export type AsyncWorkItem = {
  id: string;
  tenant: string;
  actor: string;
  kind: string;
  args: unknown;
  created: number;
  session?: string;
  deadline?: number;
  owner: string;
  leaseUntil: number;
};

/** Durable async worker loop for Redis-backed jobs. Execution is injected to keep policy in the service layer. */
export class AsyncWorker {
  private stopped = false;
  private active = new Map<string, Promise<void>>();
  constructor(
    private readonly store: AsyncJobStore,
    private readonly owner: string,
    private readonly concurrency = 2,
    private readonly leaseMs = 30_000,
  ) {}
  async tick(execute: (job: AsyncWorkItem, signal: AbortSignal) => Promise<unknown>) {
    await this.store.recoverExpired?.();
    while (!this.stopped && this.active.size < this.concurrency) {
      const job = await this.store.claim(this.owner, this.leaseMs);
      if (!job) break;
      const controller = new AbortController();
      const task = this.run(job, controller, execute).finally(() => this.active.delete(job.id));
      this.active.set(job.id, task);
    }
    await Promise.allSettled(this.active.values());
  }
  private async run(
    job: AsyncWorkItem,
    controller: AbortController,
    execute: (job: AsyncWorkItem, signal: AbortSignal) => Promise<unknown>,
  ) {
    const heartbeat = setInterval(
      () => {
        void this.store
          .heartbeat(job.id, this.owner, this.leaseMs)
          .then((ok) => {
            if (!ok) controller.abort(new Error('execution_fenced'));
          })
          .catch(() => controller.abort(new Error('lease_lost')));
      },
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    );
    try {
      const result = await execute(job, controller.signal);
      await this.store.finish(job.id, this.owner, 'completed', result);
    } catch (error) {
      await this.store.finish(job.id, this.owner, 'failed', {
        code: error instanceof Error ? error.message : 'execution_failed',
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
  async drain() {
    this.stopped = true;
    await Promise.allSettled(this.active.values());
  }
}
