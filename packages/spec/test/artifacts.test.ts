import { describe, expect, it } from 'vitest';
import {
  artifactHash,
  buildAgentCapabilityManifest,
  createReleaseArtifact,
} from '../src/artifacts';
import { parseSpecYaml } from '../src/spec';

const spec = parseSpecYaml(`name: artifact-test
version: 1.0.0
schema_version: 1
instruction: { system: hello }
flow: { mode: single-loop, max_steps: 2 }
llm: { provider: mock, model: mock }
tools: []`);

describe('release artifacts', () => {
  it('creates a deterministic content hash', () => {
    const input = {
      kind: 'release' as const,
      name: spec.name,
      version: spec.version,
      status: 'approved' as const,
      spec,
      skills: spec.skills,
      tools: [],
      model: { provider: 'mock', model: 'mock' },
    };
    const a = createReleaseArtifact(input);
    const b = createReleaseArtifact(input);
    expect(a.content_hash).toHaveLength(64);
    expect(a.content_hash).toBe(b.content_hash);
    expect(artifactHash(a)).not.toBe(a.content_hash);
  });

  it('freezes tool, skill, MCP, memory and knowledge bindings into a manifest', () => {
    const bound = parseSpecYaml(`name: capability-release
version: 1.0.0
schema_version: 1
instruction: { system: hello }
flow: { mode: single-loop, max_steps: 2 }
llm: { provider: mock, model: mock }
capabilities:
  mcp_servers: [research@1]
  knowledge_backends: [project-docs]
  memory_scopes: [turn, task]
  bindings:
    - { capability_id: research@1, kind: mcp, version: '1', selected_children: [search] }
    - { capability_id: research, kind: skill, version: 1.2.0, activation: auto }
tools:
  - { name: research@1/search, access: allow }
skills:
  - { name: research, version: 1.2.0, content_hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa }
`);
    const manifest = buildAgentCapabilityManifest(bound, [
      { name: 'research@1/search', version: 'mcp-1', schema_hash: 'b'.repeat(64) },
    ]);
    expect(manifest.tools[0]).toMatchObject({ id: 'research@1/search', access: 'allow' });
    expect(manifest.skills[0]).toMatchObject({ id: 'research', activation: 'auto' });
    expect(manifest.mcp_servers[0]).toMatchObject({ id: 'research@1', tool_ids: ['search'] });
    expect(manifest.memory_policy_hash).toHaveLength(64);
    expect(manifest.knowledge_source_hashes[0]).toHaveLength(64);
  });
});
