import type { ContextPack, ContextPackInput, KnowledgeBackendHealth, KnowledgeHit, KnowledgePort, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeSynthesisInput, MemoryCandidateInput, SynthesisResult } from './types.js';
import { sha256 } from './hash.js';

export class HybridKnowledgeAdapter implements KnowledgePort {
  readonly type = 'hybrid' as const;
  constructor(private readonly primary: KnowledgePort, private readonly secondary: KnowledgePort) {}

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    const [left, right] = await Promise.all([this.primary.search(input), this.secondary.search(input)]);
    const byKey = new Map<string, KnowledgeHit>();
    [...left.hits, ...right.hits].forEach((hit) => {
      const key = `${hit.title}:${hit.text.slice(0, 180)}`;
      const current = byKey.get(key);
      if (!current || hit.score > current.score) byKey.set(key, hit);
    });
    const hits = [...byKey.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, input.limit ?? 10);
    return { hits, query: input.query, backend: this.type, snapshot_hash: sha256({ left: left.snapshot_hash, right: right.snapshot_hash, hits }) };
  }

  async synthesize(input: KnowledgeSynthesisInput): Promise<SynthesisResult> {
    const result = await this.primary.synthesize({ ...input, evidence: input.evidence ?? (await this.search(input)).hits });
    return { ...result, backend: this.type, snapshot_hash: sha256({ primary: result.snapshot_hash, backend: this.type }) };
  }

  async contextPack(input: ContextPackInput): Promise<ContextPack> {
    const [left, right] = await Promise.all([this.primary.contextPack(input), this.secondary.contextPack(input)]);
    const claims = [...left.claims, ...right.claims];
    const seen = new Set<string>();
    const unique = claims.filter((claim) => { const key = claim.claim_hash; if (seen.has(key)) return false; seen.add(key); return true; });
    return { summary: [left.summary, right.summary].filter(Boolean).join('\n\n'), claims: unique, citations: unique.flatMap((claim) => claim.citations), conflicts: [...left.conflicts, ...right.conflicts], gaps: [...left.gaps, ...right.gaps], token_estimate: left.token_estimate + right.token_estimate, snapshot_hash: sha256({ left: left.snapshot_hash, right: right.snapshot_hash }) };
  }

  entity(input: { organization_id: string; project_id: string; id: string }) { return Promise.all([this.primary.entity(input), this.secondary.entity(input)]).then((rows) => rows.flat()); }
  proposeMemory(input: MemoryCandidateInput) { return this.primary.proposeMemory(input); }
  forget(input: { organization_id: string; project_id: string; id: string }) { return this.primary.forget(input); }

  async health(): Promise<KnowledgeBackendHealth> {
    const [left, right] = await Promise.all([this.primary.health(), this.secondary.health()]);
    return { backend: this.type, ok: left.ok || right.ok, degraded: !left.ok || !right.ok, checked_at: new Date().toISOString(), error: [left.error, right.error].filter(Boolean).join('; ') || undefined };
  }
}
