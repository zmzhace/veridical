import type {
  ContextPack, ContextPackInput, KnowledgeBackendHealth, KnowledgeClaim, KnowledgeHit,
  KnowledgePort, KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeSynthesisInput,
  MemoryCandidateInput, SynthesisResult,
} from './types.js';
import { sha256, shortId } from './hash.js';

export interface NativeKnowledgeDocument {
  id: string;
  organization_id: string;
  project_id: string;
  title: string;
  text: string;
  source: KnowledgeHit['source'];
  claims?: KnowledgeClaim[];
}

/** Small deterministic adapter used by development and tests; production storage can implement the same port. */
export class NativeKnowledgeAdapter implements KnowledgePort {
  readonly type = 'native' as const;
  private documents = new Map<string, NativeKnowledgeDocument>();
  private candidates = new Map<string, MemoryCandidateInput>();

  constructor(documents: NativeKnowledgeDocument[] = []) {
    documents.forEach((document) => this.documents.set(document.id, structuredClone(document)));
  }

  add(document: NativeKnowledgeDocument): void {
    this.documents.set(document.id, structuredClone(document));
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    const terms = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const hits = [...this.documents.values()]
      .filter((document) => document.organization_id === input.organization_id && document.project_id === input.project_id)
      .map((document) => {
        const haystack = `${document.title}\n${document.text}`.toLocaleLowerCase();
        const matched = terms.filter((term) => haystack.includes(term)).length;
        return {
          id: document.id,
          title: document.title,
          text: document.text,
          score: terms.length ? matched / terms.length : 0,
          source: document.source,
          metadata: { claims: document.claims?.length ?? 0 },
        } satisfies KnowledgeHit;
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, input.limit ?? 10);
    return { hits, query: input.query, backend: this.type, snapshot_hash: sha256(hits) };
  }

  async synthesize(input: KnowledgeSynthesisInput): Promise<SynthesisResult> {
    const evidence = input.evidence ?? (await this.search(input)).hits;
    const claims = evidence.map((hit) => ({ text: hit.text, confidence: Math.min(1, hit.score + 0.5), citations: [hit.source] }));
    const answer = evidence.length
      ? evidence.map((hit, index) => `${index + 1}. ${hit.text}`).join('\n')
      : '没有找到有来源的知识。';
    const snapshot_hash = sha256({ query: input.query, evidence });
    return { answer, claims, conflicts: [], gaps: evidence.length ? [] : [{ id: shortId({ input, kind: 'gap' }), organization_id: input.organization_id, project_id: input.project_id, description: `缺少与「${input.query}」相关的可靠来源`, related_page_ids: [], missing_sources: [], severity: 'medium', status: 'open' }], backend: this.type, snapshot_hash };
  }

  async contextPack(input: ContextPackInput): Promise<ContextPack> {
    const synthesis = await this.synthesize(input);
    const claims = synthesis.claims.map((claim) => ({
      id: shortId(claim), organization_id: input.organization_id, project_id: input.project_id,
      text: claim.text, kind: 'fact' as const, confidence: claim.confidence, status: 'verified' as const,
      citations: claim.citations, claim_hash: sha256(claim.text), created_at: new Date().toISOString(),
    }));
    const summary = synthesis.answer.slice(0, Math.max(200, (input.max_tokens ?? 1200) * 3));
    return { summary, claims, citations: claims.flatMap((claim) => claim.citations), conflicts: synthesis.conflicts, gaps: synthesis.gaps, token_estimate: Math.ceil(summary.length / 4), snapshot_hash: synthesis.snapshot_hash };
  }

  async entity(input: { organization_id: string; project_id: string; id: string }): Promise<KnowledgeHit[]> {
    const document = this.documents.get(input.id);
    if (!document || document.organization_id !== input.organization_id || document.project_id !== input.project_id) return [];
    return [{ id: document.id, title: document.title, text: document.text, score: 1, source: document.source }];
  }

  async proposeMemory(input: MemoryCandidateInput) {
    const candidate_id = shortId({ input, at: 'candidate' });
    this.candidates.set(candidate_id, structuredClone(input));
    return { candidate_id, status: 'candidate' as const, content_hash: sha256(input.text) };
  }

  async forget(input: { organization_id: string; project_id: string; id: string }) {
    const document = this.documents.get(input.id);
    if (!document || document.organization_id !== input.organization_id || document.project_id !== input.project_id) return { forgotten: false };
    this.documents.delete(input.id);
    return { forgotten: true };
  }

  async health(): Promise<KnowledgeBackendHealth> {
    return { backend: this.type, ok: true, degraded: false, checked_at: new Date().toISOString() };
  }
}
