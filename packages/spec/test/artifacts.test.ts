import { describe, expect, it } from 'vitest';
import { artifactHash, createReleaseArtifact } from '../src/artifacts';
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
    const input = { kind: 'release' as const, name: spec.name, version: spec.version, status: 'approved' as const, spec, skills: spec.skills, tools: [], model: { provider: 'mock', model: 'mock' } };
    const a = createReleaseArtifact(input);
    const b = createReleaseArtifact(input);
    expect(a.content_hash).toHaveLength(64);
    expect(a.content_hash).toBe(b.content_hash);
    expect(artifactHash(a)).not.toBe(a.content_hash);
  });
});
