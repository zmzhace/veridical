import type { KnowledgeClaim, KnowledgeGap, WikiCompileInput, WikiCompileResult, WikiPageArtifact } from './types.js';
import { sha256, shortId } from './hash.js';

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function safeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[\r\n#]/g, '').trim().slice(0, 120) || '未命名运行';
}

/** Deterministic compiler: raw Invocation Graph in, reviewable Wiki Candidates out. */
export function compileWikiCandidates(input: WikiCompileInput): WikiCompileResult {
  const relevant = input.events.filter((event) => text(event.output) || text(event.input));
  const idempotency_key = sha256({ organization_id: input.organization_id, project_id: input.project_id, run_id: input.run_id, events: relevant.map((event) => ({ id: event.id, invocation_id: event.invocation_id, path: event.path, type: event.type, input: event.input, output: event.output })) });
  const pages: WikiPageArtifact[] = [];
  const claims: KnowledgeClaim[] = [];
  const sourceInvocationIds = relevant.map((event) => event.invocation_id ?? event.id).filter((id): id is string => Boolean(id));
  const sourceArtifactIds = relevant.filter((event) => event.type?.includes('artifact')).map((event) => text(event.output)).filter(Boolean).map((value) => shortId(value));
  const facts = relevant.map((event) => {
    const output = text(event.output);
    const eventInput = text(event.input);
    const statement = output || eventInput;
    const claimHash = sha256({ statement, path: event.path, operation: event.operation });
    const citation = { source_type: 'invocation' as const, source_id: event.invocation_id ?? event.id ?? shortId(event), locator: { invocation_path: event.path, sequence: undefined }, excerpt_hash: sha256(statement), content_hash: sha256(event) };
    return { id: shortId({ claimHash, project: input.project_id }), organization_id: input.organization_id, project_id: input.project_id, text: statement.slice(0, 2000), kind: event.type?.includes('decision') ? 'decision' as const : 'fact' as const, confidence: event.status === 'success' ? 0.8 : 0.5, status: 'candidate' as const, citations: [citation], claim_hash: claimHash, created_at: event.timestamp ?? new Date().toISOString() };
  });
  const uniqueClaims = facts.filter((claim, index, all) => all.findIndex((candidate) => candidate.claim_hash === claim.claim_hash) === index);
  if (uniqueClaims.length) {
    const title = safeTitle(`运行 ${input.run_id.slice(0, 12)} 的工作记录`);
    const markdown = [`# ${title}`, '', `> 状态：候选 · 来源运行：${input.run_id}`, '', '## 记录', ...uniqueClaims.map((claim) => `- ${claim.text} [^${claim.id}]`), '', '## 来源', ...uniqueClaims.map((claim) => `[^${claim.id}]: invocation:${claim.citations[0].source_id}`)].join('\n');
    pages.push({ id: shortId({ idempotency_key, type: 'source' }), organization_id: input.organization_id, project_id: input.project_id, type: 'source', slug: `runs/${input.run_id}`, title, version: 1, markdown, content_hash: sha256(markdown), source_invocation_ids: sourceInvocationIds, source_artifact_ids: sourceArtifactIds, status: 'candidate', created_at: new Date().toISOString() });
  }
  claims.push(...uniqueClaims);
  const gaps: KnowledgeGap[] = relevant.length && !relevant.some((event) => event.type?.includes('assistant') || event.operation?.includes('final')) ? [{ id: shortId({ idempotency_key, gap: true }), organization_id: input.organization_id, project_id: input.project_id, description: '本次运行没有可识别的最终结论，需人工补充或重新编译。', related_page_ids: pages.map((page) => page.id), missing_sources: ['final_output'], severity: 'low', status: 'open' }] : [];
  return { idempotency_key, pages, claims, gaps };
}

export class WikiCompiler {
  compile(input: WikiCompileInput): WikiCompileResult { return compileWikiCandidates(input); }
}
