import { describe, expect, it } from 'vitest';
import { GBrainMcpAdapter, HybridKnowledgeAdapter, NativeKnowledgeAdapter, compileWikiCandidates, sha256 } from '../src/index.js';

const citation = { source_type: 'file' as const, source_id: 'brief.md', excerpt_hash: sha256('brief'), content_hash: sha256('brief') };

describe('knowledge adapters', () => {
  it('returns deterministic native search and a bounded context pack', async () => {
    const native = new NativeKnowledgeAdapter([{ id: 'p1', organization_id: 'o1', project_id: 'p1', title: 'Release decision', text: 'Ship after replay passes.', source: citation }]);
    const result = await native.search({ organization_id: 'o1', project_id: 'p1', query: 'replay', limit: 5 });
    expect(result.hits[0]).toMatchObject({ id: 'p1', title: 'Release decision' });
    const pack = await native.contextPack({ organization_id: 'o1', project_id: 'p1', query: 'replay', max_tokens: 100 });
    expect(pack.claims[0].citations[0].source_id).toBe('brief.md');
    expect(pack.token_estimate).toBeGreaterThan(0);
  });

  it('merges hybrid evidence without duplicate claims', async () => {
    const left = new NativeKnowledgeAdapter([{ id: 'p1', organization_id: 'o1', project_id: 'p1', title: 'A', text: 'same fact', source: citation }]);
    const right = new NativeKnowledgeAdapter([{ id: 'p2', organization_id: 'o1', project_id: 'p1', title: 'B', text: 'other fact', source: { ...citation, source_id: 'b.md' } }]);
    const hybrid = new HybridKnowledgeAdapter(left, right);
    const result = await hybrid.search({ organization_id: 'o1', project_id: 'p1', query: 'fact' });
    expect(result.backend).toBe('hybrid');
    expect(result.hits).toHaveLength(2);
  });

  it('normalizes the GBrain verb surface and records a stable snapshot', async () => {
    const calls: string[] = [];
    const brain = new GBrainMcpAdapter({ call: async (name) => { calls.push(name); return { results: [{ id: 'g1', title: 'Brain page', content: 'Known fact', score: 0.9 }] }; } });
    const result = await brain.search({ organization_id: 'o1', project_id: 'p1', query: 'fact' });
    expect(result.hits[0].source.source_type).toBe('gbrain');
    expect(calls).toEqual(['gbrain.search']);
  });
});

describe('wiki compiler', () => {
  it('creates idempotent, reviewable candidates grounded in invocation records', () => {
    const input = { organization_id: 'o1', project_id: 'p1', run_id: 'run-123', events: [{ id: 'e1', invocation_id: 'i1', path: 'root/tool:search#1', type: 'tool.result', output: 'Found a source', status: 'success' }] };
    const first = compileWikiCandidates(input);
    const second = compileWikiCandidates(input);
    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.pages[0].status).toBe('candidate');
    expect(first.pages[0].markdown).toContain('invocation:i1');
    expect(first.claims[0].citations[0].locator?.invocation_path).toBe('root/tool:search#1');
  });
});
