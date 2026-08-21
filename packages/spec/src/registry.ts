import type { AgentSpec } from './spec';

export class DuplicateSpecError extends Error {
  constructor(name: string, version: string) {
    super(`spec already registered: ${name}@${version}`);
    this.name = 'DuplicateSpecError';
  }
}

export interface SpecRegistry {
  register(spec: AgentSpec): Promise<void>;
  resolve(name: string, version?: string): Promise<AgentSpec | undefined>;
  list(): Promise<AgentSpec[]>;
}
