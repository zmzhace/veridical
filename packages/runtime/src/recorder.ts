import type { TraceStore } from '@rt/store';
import type { TraceEvent } from '@rt/schema';
import { parseEvent } from '@rt/schema';
import type { Session } from './session';

export type RecordInput = Omit<TraceEvent, 'id' | 'tenant_id' | 'session_id' | 'seq' | 'spec_version'>;

export class Recorder {
  private seq = 0;
  constructor(private store: TraceStore, private session: Session) {}

  async record(input: RecordInput): Promise<TraceEvent> {
    this.seq += 1;
    const evt = parseEvent({
      ...input,
      id: `evt_${this.session.session_id}_${this.seq}`,
      tenant_id: this.session.tenant_id,
      session_id: this.session.session_id,
      seq: this.seq,
      spec_version: this.session.spec_version,
    });
    await this.store.append(evt);
    return evt;
  }
}