import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import type { Session } from './session';

export type RecordInput = Omit<TraceEvent, 'id' | 'tenant_id' | 'session_id' | 'seq' | 'spec_version'>;

export class Recorder {
  private readonly ordinals = new Map<string, number>();
  constructor(protected store: TraceStore, protected session: Session) {}

  async record(input: RecordInput): Promise<TraceEvent> {
    const path = input.path ?? input.span_id;
    const ordinal = (this.ordinals.get(path) ?? 0) + 1;
    this.ordinals.set(path, ordinal);
    return this.store.appendNext({
      ...input,
      invocation_id: input.invocation_id ?? input.span_id,
      path,
      path_source: input.path ? 'explicit' : 'legacy',
      ordinal: input.ordinal ?? ordinal,
      replay_key: input.replay_key ?? `${path}:${input.type}:${input.attempt}:${ordinal}`,
      tenant_id: this.session.tenant_id,
      session_id: this.session.session_id,
      spec_version: this.session.spec_version,
    });
  }
}
