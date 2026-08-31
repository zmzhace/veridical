import Redis from 'ioredis';
import type { AsyncJobStore } from './job-store';
import type { JobKind } from './contracts';

export type QueueJob = {
  id: string;
  tenant: string;
  actor: string;
  kind: JobKind;
  args: unknown;
  created: number;
  session?: string;
  deadline?: number;
};

/**
 * Redis-backed durable queue primitive. The service layer remains responsible for
 * authorization and execution; this class only owns delivery and lease fencing.
 */
export class RedisJobQueue implements AsyncJobStore {
  private readonly redis: Redis;
  constructor(
    private readonly url: string,
    private readonly prefix = 'veridical:jobs',
  ) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  }
  private key(name: string) {
    return `${this.prefix}:${name}`;
  }
  async close() {
    await this.redis.quit();
  }
  async enqueue(
    job: QueueJob,
    idempotencyKey: string,
  ): Promise<{ id: string; duplicate: boolean }> {
    const idem = this.key(`idem:${job.tenant}:${idempotencyKey}`);
    const existing = await this.redis.get(idem);
    if (existing) return { id: existing, duplicate: true };
    const multi = this.redis.multi();
    multi.set(idem, job.id, 'EX', 86400, 'NX');
    multi.hset(this.key(`job:${job.id}`), {
      id: job.id,
      tenant: job.tenant,
      actor: job.actor,
      kind: job.kind,
      args: JSON.stringify(job.args),
      created: String(job.created),
      ...(job.session ? { session: job.session } : {}),
      deadline: job.deadline === undefined ? '' : String(job.deadline),
      state: 'queued',
    });
    multi.zadd(this.key('ready'), job.created, job.id);
    const result = await multi.exec();
    if (!result || result[0]?.[1] !== 'OK') {
      const id = await this.redis.get(idem);
      if (id) return { id, duplicate: true };
      throw new Error('redis_enqueue_failed');
    }
    return { id: job.id, duplicate: false };
  }
  async claim(
    owner: string,
    leaseMs: number,
  ): Promise<(QueueJob & { owner: string; leaseUntil: number }) | undefined> {
    const now = Date.now();
    const ids = await this.redis.zrangebyscore(this.key('ready'), '-inf', now, 'LIMIT', 0, 1);
    const id = ids[0];
    if (!id) return undefined;
    const until = now + leaseMs;
    const claimed = await this.redis.eval(
      `
      local id = ARGV[1]
      local job = KEYS[1] .. ':job:' .. id
      local state = redis.call('HGET', job, 'state')
      if state ~= 'queued' then return 0 end
      redis.call('ZREM', KEYS[1] .. ':ready', id)
      redis.call('HSET', job, 'state', 'running', 'owner', ARGV[2], 'lease_until', ARGV[3])
      redis.call('ZADD', KEYS[1] .. ':leases', ARGV[3], id)
      return 1
    `,
      1,
      this.prefix,
      id,
      owner,
      String(until),
    );
    if (claimed !== 1) return undefined;
    const data = await this.redis.hgetall(this.key(`job:${id}`));
    return {
      id,
      tenant: data.tenant,
      actor: data.actor,
      kind: data.kind as JobKind,
      args: JSON.parse(data.args),
      created: Number(data.created),
      ...(data.session ? { session: data.session } : {}),
      ...(data.deadline ? { deadline: Number(data.deadline) } : {}),
      owner,
      leaseUntil: until,
    };
  }
  async heartbeat(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const until = Date.now() + leaseMs;
    const result = await this.redis.eval(
      `
      local job = KEYS[1] .. ':job:' .. ARGV[1]
      if redis.call('HGET', job, 'state') ~= 'running' or redis.call('HGET', job, 'owner') ~= ARGV[2] then return 0 end
      redis.call('HSET', job, 'lease_until', ARGV[3])
      redis.call('ZADD', KEYS[1] .. ':leases', ARGV[3], ARGV[1])
      return 1
    `,
      1,
      this.prefix,
      id,
      owner,
      String(until),
    );
    return result === 1;
  }
  async finish(
    id: string,
    owner: string,
    state: 'completed' | 'failed' | 'cancelled',
    result?: unknown,
  ): Promise<boolean> {
    const changed = await this.redis.eval(
      `
      local job = KEYS[1] .. ':job:' .. ARGV[1]
      if redis.call('HGET', job, 'owner') ~= ARGV[2] then return 0 end
      redis.call('HSET', job, 'state', ARGV[3], 'result', ARGV[4])
      redis.call('ZREM', KEYS[1] .. ':leases', ARGV[1])
      return 1
    `,
      1,
      this.prefix,
      id,
      owner,
      state,
      JSON.stringify(result ?? null),
    );
    return changed === 1;
  }
}
