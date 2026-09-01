export type KnowledgeBackendType = 'native' | 'gbrain' | 'hybrid';
export type KnowledgeScope = 'task' | 'project' | 'organization' | 'user';
export type ClaimKind = 'fact' | 'decision' | 'preference' | 'hypothesis' | 'instruction';

export interface Citation {
  source_type: 'invocation' | 'artifact' | 'file' | 'wiki' | 'gbrain';
  source_id: string;
  source_version?: string;
  locator?: {
    invocation_path?: string;
    sequence?: number;
    page?: number;
    line?: number;
    start_offset?: number;
    end_offset?: number;
  };
  excerpt_hash: string;
  content_hash: string;
}

export interface KnowledgeClaim {
  id: string;
  organization_id: string;
  project_id: string;
  page_id?: string;
  text: string;
  kind: ClaimKind;
  confidence: number;
  status: 'candidate' | 'verified' | 'conflicted' | 'superseded' | 'rejected';
  citations: Citation[];
  claim_hash: string;
  created_at: string;
}

export interface KnowledgeGap {
  id: string;
  organization_id: string;
  project_id: string;
  description: string;
  related_page_ids: string[];
  missing_sources: string[];
  severity: 'low' | 'medium' | 'high';
  status: 'open' | 'resolved' | 'dismissed';
}

export interface KnowledgeHit {
  id: string;
  title: string;
  text: string;
  score: number;
  source: Citation;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchInput {
  organization_id: string;
  project_id: string;
  query: string;
  limit?: number;
  scope?: KnowledgeScope;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  query: string;
  backend: KnowledgeBackendType;
  snapshot_hash: string;
}

export interface KnowledgeSynthesisInput extends KnowledgeSearchInput {
  intent?: string;
  evidence?: KnowledgeHit[];
}

export interface SynthesisResult {
  answer: string;
  claims: Array<Pick<KnowledgeClaim, 'text' | 'confidence' | 'citations'>>;
  conflicts: Array<{ description: string; left: Citation; right: Citation }>;
  gaps: KnowledgeGap[];
  backend: KnowledgeBackendType;
  snapshot_hash: string;
}

export interface ContextPackInput {
  organization_id: string;
  project_id: string;
  query: string;
  max_tokens?: number;
}

export interface ContextPack {
  summary: string;
  claims: KnowledgeClaim[];
  citations: Citation[];
  conflicts: SynthesisResult['conflicts'];
  gaps: KnowledgeGap[];
  token_estimate: number;
  snapshot_hash: string;
}

export interface MemoryCandidateInput {
  organization_id: string;
  project_id: string;
  scope: KnowledgeScope;
  text: string;
  citations: Citation[];
  confidence?: number;
}

export interface KnowledgeBackendHealth {
  backend: KnowledgeBackendType;
  ok: boolean;
  degraded: boolean;
  checked_at: string;
  error?: string;
}

export interface KnowledgePort {
  readonly type: KnowledgeBackendType;
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult>;
  synthesize(input: KnowledgeSynthesisInput): Promise<SynthesisResult>;
  contextPack(input: ContextPackInput): Promise<ContextPack>;
  entity(input: { organization_id: string; project_id: string; id: string }): Promise<KnowledgeHit[]>;
  proposeMemory(input: MemoryCandidateInput): Promise<{ candidate_id: string; status: 'candidate'; content_hash: string }>;
  forget(input: { organization_id: string; project_id: string; id: string }): Promise<{ forgotten: boolean }>;
  health(): Promise<KnowledgeBackendHealth>;
}

export interface McpInvoker {
  call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

export interface WikiPageArtifact {
  id: string;
  organization_id: string;
  project_id: string;
  type: 'current_state' | 'decision' | 'milestone' | 'insight' | 'topic' | 'review' | 'source';
  slug: string;
  title: string;
  version: number;
  markdown: string;
  content_hash: string;
  source_invocation_ids: string[];
  source_artifact_ids: string[];
  status: 'candidate' | 'approved' | 'superseded' | 'rejected' | 'deleted';
  created_at: string;
}

export interface WikiCompileInput {
  organization_id: string;
  project_id: string;
  run_id: string;
  events: Array<{
    id?: string;
    invocation_id?: string;
    path?: string;
    type?: string;
    operation?: string;
    input?: unknown;
    output?: unknown;
    status?: string;
    timestamp?: string;
  }>;
}

export interface WikiCompileResult {
  idempotency_key: string;
  pages: WikiPageArtifact[];
  claims: KnowledgeClaim[];
  gaps: KnowledgeGap[];
}
