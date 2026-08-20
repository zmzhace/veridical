export interface SessionOptions {
  session_id: string;
  tenant_id: string;
  spec_version: string;
}

export class Session {
  readonly session_id: string;
  readonly tenant_id: string;
  readonly spec_version: string;

  constructor(opts: SessionOptions) {
    this.session_id = opts.session_id;
    this.tenant_id = opts.tenant_id;
    this.spec_version = opts.spec_version;
  }
}