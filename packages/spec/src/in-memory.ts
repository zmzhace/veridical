import { gt } from 'semver';
import type { AgentSpec } from './spec';
import { DuplicateSpecError, type SpecRegistry } from './registry';

export class InMemorySpecRegistry implements SpecRegistry {
  private specs = new Map<string, AgentSpec>();

  private key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  async register(spec: AgentSpec): Promise<void> {
    const k = this.key(spec.name, spec.version);
    if (this.specs.has(k)) throw new DuplicateSpecError(spec.name, spec.version);
    this.specs.set(k, spec);
  }

  async resolve(name: string, version?: string): Promise<AgentSpec | undefined> {
    if (version) return this.specs.get(this.key(name, version));
    let best: AgentSpec | undefined;
    for (const spec of this.specs.values()) {
      if (spec.name !== name) continue;
      if (!best || gt(spec.version, best.version)) best = spec;
    }
    return best;
  }

  async list(): Promise<AgentSpec[]> {
    return [...this.specs.values()];
  }
}
