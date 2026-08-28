import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import type { Session } from './session';

export type RecordInput = Omit<TraceEvent, 'id' | 'tenant_id' | 'session_id' | 'seq' | 'spec_version'>;

export class Recorder {
  constructor(private store: TraceStore, private session: Session) {}

  async record(input: RecordInput): Promise<TraceEvent> {
    return this.store.appendNext({
      ...input,
      tenant_id: this.session.tenant_id,
      session_id: this.session.session_id,
      spec_version: this.session.spec_version,
    });
  }
}
