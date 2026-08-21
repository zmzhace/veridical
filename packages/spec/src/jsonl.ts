import { mkdirSync, readdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gt } from 'semver';
import { AgentSpecSchema, type AgentSpec } from './spec';
import { DuplicateSpecError, type SpecRegistry } from './registry';

export class JsonlSpecRegistry implements SpecRegistry {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string, version: string): string {
    return join(this.dir, `${name}@${version}.jsonl`);
  }

  async register(spec: AgentSpec): Promise<void> {
    const f = this.file(spec.name, spec.version);
    if (existsSync(f)) throw new DuplicateSpecError(spec.name, spec.version);
    appendFileSync(f, JSON.stringify(spec) + '\n', 'utf8');
  }

  async resolve(name: string, version?: string): Promise<AgentSpec | undefined> {
    const all = await this.list();
    if (version) return all.find(s => s.name === name && s.version === version);
    let best: AgentSpec | undefined;
    for (const s of all) {
      if (s.name !== name) continue;
      if (!best || gt(s.version, best.version)) best = s;
    }
    return best;
  }

  async list(): Promise<AgentSpec[]> {
    const out: AgentSpec[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        out.push(AgentSpecSchema.parse(JSON.parse(line)));
      }
    }
    return out;
  }
}
