import { describe, it, expect } from 'vitest';
import { runOrchestrationDemo } from '../src/orchestration-demo';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('orchestration demo', () => {
  it('supervisor dispatches to compare-agent with nested spans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-orch-'));
    const { store, result } = await runOrchestrationDemo(dir);
    const events = await store.readBySession('orch_s1');
    const types = events.map(e => e.type);
    expect(types).toContain('agent.dispatch');
    expect(types).toContain('agent.result');
    const dispatchEvt = events.find(e => e.type === 'agent.dispatch')!;
    const expertStart = events.find(e => e.type === 'spec/run/start' && e.span_id === 'compare-agent')!;
    expect(expertStart.parent_span_id).toBe(dispatchEvt.id);
    expect(result.events.length).toBe(events.length);
    expect(new Set(events.map(e => e.id)).size).toBe(events.length);
  });
});
