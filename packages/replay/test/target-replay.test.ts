import { describe, expect, it } from 'vitest';
import { resolveReplayTarget } from '../src/engine';

const nodes = [
  { invocation_id: 'root-1', path: 'root', operation: 'agent.run' },
  { invocation_id: 'child-1', path: 'root/delegate:researcher', operation: 'agent.dispatch' },
] as any;

describe('node replay target resolution', () => {
  it('resolves by stable invocation id', () => {
    expect(resolveReplayTarget(nodes, { target_invocation_id: 'child-1' })?.path).toBe(
      'root/delegate:researcher',
    );
  });
  it('resolves by explicit path', () => {
    expect(resolveReplayTarget(nodes, { target_path: 'root' })?.invocation_id).toBe('root-1');
  });
  it('rejects a missing path with a structured code', () => {
    expect(() => resolveReplayTarget(nodes, { target_path: 'root/missing' })).toThrowError(
      expect.objectContaining({ code: 'replay_path_mismatch' }),
    );
  });
});
