import type {
  ContextPack, ContextPackInput, KnowledgeBackendHealth, KnowledgeHit, KnowledgePort,
  KnowledgeSearchInput, KnowledgeSearchResult, KnowledgeSynthesisInput, MemoryCandidateInput,
  SynthesisResult, McpInvoker,
} from './types.js';
import { sha256, shortId } from './hash.js';

/**
 * Transport-neutral GBrain adapter. MCP discovery, credentials, tracing and permissions
 * remain in the server ToolBroker; this class only normalizes the seven-verb surface.
 */
export class GBrainMcpAdapter implements KnowledgePort {
  readonly type = 'gbrain' as const;
  constructor(private readonly invoker: McpInvoker, private readonly backendRef = 'gbrain') {}

  private citation(item: any, query: string) {
    const sourceId = String(item?.id ?? item?.slug ?? item?.source_id ?? shortId(item));
    return { source_type: 'gbrain' as const, source_id: sourceId, source_version: item?.version ? String(item.version) : undefined, locator: item?.path ? { invocation_path: String(item.path) } : undefined, excerpt_hash: sha256(item?.text ?? item?.content ?? ''), content_hash: sha256(item) };
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult> {
    const raw = await this.invoker.call<any>('gbrain.search', { query: input.query, limit: input.limit ?? 10, scope: input.scope, organization_id: input.organization_id, project_id: input.project_id });
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [];
    const hits: KnowledgeHit[] = rows.map((item: any, index: number) => ({ id: String(item.id ?? item.slug ?? index), title: String(item.title ?? item.name ?? item.slug ?? 'Knowledge'), text: String(item.text ?? item.content ?? item.excerpt ?? ''), score: Number(item.score ?? 0), source: this.citation(item, input.query), metadata: { backend_ref: this.backendRef, evidence: item.evidence } }));
    return { hits, query: input.query, backend: this.type, snapshot_hash: sha256({ backend: this.backendRef, input, hits }) };
  }

  async synthesize(input: KnowledgeSynthesisInput): Promise<SynthesisResult> {
    const raw = await this.invoker.call<any>('gbrain.synthesize', { query: input.query, intent: input.intent, scope: { organization_id: input.organization_id, project_id: input.project_id } });
    const hits = input.evidence ?? (await this.search(input)).hits;
    const answer = String(raw?.answer ?? raw?.text ?? raw?.content ?? (typeof raw === 'string' ? raw : ''));
    const rawClaims = Array.isArray(raw?.claims) ? raw.claims : [];
    const claims = rawClaims.length ? rawClaims.map((claim: any) => ({ text: String(claim.text ?? claim.claim ?? ''), confidence: Number(claim.confidence ?? 0.5), citations: (Array.isArray(claim.citations) ? claim.citations : [claim]).map((item: any) => this.citation(item, input.query)) })) : hits.map((hit) => ({ text: hit.text, confidence: hit.score, citations: [hit.source] }));
    const gaps = (Array.isArray(raw?.gaps) ? raw.gaps : []).map((gap: any) => ({ id: shortId(gap), organization_id: input.organization_id, project_id: input.project_id, description: String(gap.description ?? gap), related_page_ids: [], missing_sources: [], severity: 'medium' as const, status: 'open' as const }));
    return { answer: answer || 'GBrain 没有返回可引用的答案。', claims, conflicts: [], gaps, backend: this.type, snapshot_hash: sha256({ backend: this.backendRef, input, raw }) };
  }

  async contextPack(input: ContextPackInput): Promise<ContextPack> {
    const raw = await this.invoker.call<any>('gbrain.context_pack', { query: input.query, max_tokens: input.max_tokens ?? 1200, organization_id: input.organization_id, project_id: input.project_id });
    const synthesis = await this.synthesize({ ...input, evidence: Array.isArray(raw?.evidence) ? raw.evidence : undefined });
    return { summary: String(raw?.summary ?? synthesis.answer).slice(0, (input.max_tokens ?? 1200) * 3), claims: synthesis.claims.map((claim) => ({ id: shortId(claim), organization_id: input.organization_id, project_id: input.project_id, text: claim.text, kind: 'fact' as const, confidence: claim.confidence, status: 'verified' as const, citations: claim.citations, claim_hash: sha256(claim.text), created_at: new Date().toISOString() })), citations: synthesis.claims.flatMap((claim) => claim.citations), conflicts: synthesis.conflicts, gaps: synthesis.gaps, token_estimate: Math.ceil(String(raw?.summary ?? synthesis.answer).length / 4), snapshot_hash: sha256({ backend: this.backendRef, raw, synthesis }) };
  }

  async entity(input: { organization_id: string; project_id: string; id: string }) {
    const raw = await this.invoker.call<any>('gbrain.entity', input);
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : [raw];
    return rows.filter(Boolean).map((item: any, index: number) => ({ id: String(item.id ?? input.id ?? index), title: String(item.title ?? item.name ?? input.id), text: String(item.text ?? item.content ?? ''), score: 1, source: this.citation(item, input.id) }));
  }

  async proposeMemory(input: MemoryCandidateInput) {
    const raw = await this.invoker.call<any>('gbrain.remember', { text: input.text, scope: input.scope, citations: input.citations, organization_id: input.organization_id, project_id: input.project_id, status: 'candidate' });
    return { candidate_id: String(raw?.id ?? raw?.candidate_id ?? shortId(input)), status: 'candidate' as const, content_hash: sha256(input.text) };
  }

  async forget(input: { organization_id: string; project_id: string; id: string }) {
    await this.invoker.call('gbrain.forget', input);
    return { forgotten: true };
  }

  async health(): Promise<KnowledgeBackendHealth> {
    try { await this.invoker.call('gbrain.context_pack', { query: '__health__', max_tokens: 1 }); return { backend: this.type, ok: true, degraded: false, checked_at: new Date().toISOString() }; }
    catch (error) { return { backend: this.type, ok: false, degraded: true, checked_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }; }
  }
}
