import type { TraceStore } from '@veridical/store';
import type { TraceEvent } from '@veridical/schema';
import { parseEvent } from '@veridical/schema';
import type { Session } from './session';

export type RecordInput = Omit<TraceEvent, 'id' | 'tenant_id' | 'session_id' | 'seq' | 'spec_version'>;

export class Recorder {
  constructor(private store: TraceStore, private session: Session) {}

  async record(input: RecordInput): Promise<TraceEvent> {
    const seq = (await this.store.readBySession(this.session.session_id)).length + 1;
    const evt = parseEvent({
      ...input,
      id: `evt_${this.session.session_id}_${seq}`,
      tenant_id: this.session.tenant_id,
      session_id: this.session.session_id,
      seq,
      spec_version: this.session.spec_version,
    });
    await this.store.append(evt);
    return evt;
  }
}