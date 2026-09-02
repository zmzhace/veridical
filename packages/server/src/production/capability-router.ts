export interface CapabilityCandidate {
  id: string;
  kind: 'tool' | 'skill';
  name: string;
  description: string;
  tags?: string[];
  explicitlyBound?: boolean;
  activation?: 'auto' | 'always' | 'manual';
}

export interface RankedCapability extends CapabilityCandidate {
  score: number;
  reasons: string[];
}

function terms(value: string) {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.match(/[a-z0-9_.-]{2,}|[\u3400-\u9fff]/g) ?? [];
  return new Set(words);
}

/** Deterministic shortlist used before the LLM sees tool schemas or full Skill content. */
export function rankCapabilities(
  task: string,
  candidates: CapabilityCandidate[],
  limits: { tools?: number; skills?: number } = {},
): RankedCapability[] {
  const taskTerms = terms(task);
  const ranked = candidates.map<RankedCapability>((candidate) => {
    const nameTerms = terms(candidate.name);
    const descriptionTerms = terms(`${candidate.description} ${(candidate.tags ?? []).join(' ')}`);
    let score = candidate.explicitlyBound ? 30 : 0;
    const reasons: string[] = candidate.explicitlyBound ? ['release_binding'] : [];
    if (candidate.activation === 'always') {
      score += 100;
      reasons.push('always');
    }
    let nameHits = 0;
    let descriptionHits = 0;
    for (const term of taskTerms) {
      if (nameTerms.has(term)) nameHits += 1;
      if (descriptionTerms.has(term)) descriptionHits += 1;
    }
    if (nameHits) {
      score += nameHits * 8;
      reasons.push('name_match');
    }
    if (descriptionHits) {
      score += descriptionHits * 3;
      reasons.push('description_match');
    }
    if (candidate.activation === 'manual' && !nameHits) {
      score = -1;
      reasons.push('manual_not_requested');
    }
    return { ...candidate, score, reasons };
  });
  const sorted = ranked.sort(
    (a, b) => b.score - a.score || `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
  );
  const toolLimit = limits.tools ?? 12;
  const skillLimit = limits.skills ?? 4;
  let tools = 0;
  let skills = 0;
  return sorted.filter((item) => {
    if (item.score < 0) return false;
    if (item.kind === 'tool') return tools++ < toolLimit;
    return skills++ < skillLimit;
  });
}
