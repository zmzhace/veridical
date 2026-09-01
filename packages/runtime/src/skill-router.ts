import { createHash } from 'node:crypto';

export interface SkillSummary {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  triggers?: string[];
  required_tools?: string[];
  version?: string;
  status?: 'draft' | 'approved' | 'deprecated';
}

export interface SkillRoute {
  candidates: Array<{ skill: SkillSummary; score: number; matched: string[] }>;
  selected: SkillSummary[];
  threshold: number;
  max_active: number;
  fingerprint: string;
}

const tokenize = (value: string) => value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 1);

/** Routes Skills by lightweight metadata first; full SKILL.md content is loaded only after selection. */
export class SkillRouter {
  constructor(private readonly summaries: SkillSummary[], private readonly defaults: { max_active?: number; threshold?: number } = {}) {}

  route(task: string, options: { explicit?: string[]; fixed?: string[]; max_active?: number; threshold?: number } = {}): SkillRoute {
    const threshold = options.threshold ?? this.defaults.threshold ?? 0.25;
    const max_active = options.max_active ?? this.defaults.max_active ?? 3;
    const words = new Set(tokenize(task));
    const candidates = this.summaries
      .filter((skill) => skill.status !== 'deprecated')
      .map((skill) => {
        const fields = [skill.name, skill.description ?? '', ...(skill.tags ?? []), ...(skill.triggers ?? [])];
        const matched = [...new Set(fields.flatMap(tokenize).filter((token) => words.has(token)))];
        const score = matched.length / Math.max(1, words.size) + (options.explicit?.includes(skill.id) ? 1 : 0) + (options.fixed?.includes(skill.id) ? 0.75 : 0);
        return { skill, score: Math.min(1, score), matched };
      })
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
    const selectedIds = new Set([...(options.fixed ?? []), ...(options.explicit ?? [])]);
    candidates.forEach((candidate) => { if (candidate.score >= threshold && selectedIds.size < max_active) selectedIds.add(candidate.skill.id); });
    const selected = candidates.filter((candidate) => selectedIds.has(candidate.skill.id)).slice(0, max_active).map((candidate) => candidate.skill);
    return { candidates, selected, threshold, max_active, fingerprint: createHash('sha256').update(JSON.stringify({ task, selected: selected.map((skill) => `${skill.id}@${skill.version ?? '0'}`) })).digest('hex') };
  }
}
