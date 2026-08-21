import { describe, it, expect } from 'vitest';
import { InMemoryTraceStore } from '@veridical/store';
import { Session, Recorder } from '@veridical/runtime';
import { Memory, MemoryStore, MEMORY_SESSION } from '../src/index';

function session(id: string, spec_version = '0.0.1'): Session {
  return new Session({ session_id: id, tenant_id: 't1', spec_version });
}

function longRecorder(store: InMemoryTraceStore): Recorder {
  return new Recorder(store, session(MEMORY_SESSION));
}

function makeMemory(store: InMemoryTraceStore, sid: string): Memory {
  return new Memory(new MemoryStore(), store, sid, new Recorder(store, session(sid)), longRecorder(store));
}

describe('Memory', () => {
  it('working memory is session-scoped', async () => {
    const store = new InMemoryTraceStore();
    const m = makeMemory(store, 's1');
    await m.remember('k', 'v');
    expect(await m.workingGet('k')).toBe('v');
    // A different session sees nothing
    const m2 = makeMemory(store, 's2');
    expect(await m2.workingGet('k')).toBeUndefined();
  });

  it('semantic memory persists across sessions via _memory', async () => {
    const store = new InMemoryTraceStore();
    await makeMemory(store, 's1').rememberSemantic('policy', 'P12345', ['claim']);
    const m2 = makeMemory(store, 's2');
    const hits = await m2.recall('claim policy');
    expect(hits.map(h => h.key)).toContain('policy');
  });

  it('recall matches tags and keywords, sorts by recency, respects limit', async () => {
    const store = new InMemoryTraceStore();
    const m = makeMemory(store, 's1');
    await m.rememberSemantic('a', 'first thing', ['x']);
    await m.rememberSemantic('b', 'second alpha', ['y']);
    await m.rememberSemantic('c', 'third alpha', ['z']);
    const hits = await m.recall('alpha');
    expect(hits.map(h => h.key)).toEqual(['c', 'b']);   // both contain 'alpha', newest-first (c written later)
    const limited = await m.recall('alpha', { limit: 1 });
    expect(limited.map(h => h.key)).toEqual(['c']);
    const byTag = await m.recall('', { tags: ['z'] });
    expect(byTag.map(h => h.key)).toEqual(['c']);
  });

  it('skills are listed and rememberable', async () => {
    const store = new InMemoryTraceStore();
    const m = makeMemory(store, 's1');
    await m.rememberSkill('echo_helper', { name: 'echo_helper', description: 'echo', procedure: 'return args' });
    const skills = await m.listSkills();
    expect(skills.map(s => s.value)).toContainEqual({ name: 'echo_helper', description: 'echo', procedure: 'return args' });
  });

  it('listSkills drops a forgotten skill', async () => {
    const store = new InMemoryTraceStore();
    const m = makeMemory(store, 's1');
    await m.rememberSkill('s', { name: 's', description: 's', procedure: 'proc' });
    await m.forget('skill:s', 'skill');
    expect(await m.listSkills()).toEqual([]);
  });

  it('forget removes a memory (undefined tombstone)', async () => {
    const store = new InMemoryTraceStore();
    const m = makeMemory(store, 's1');
    await m.remember('k', 'v');
    await m.forget('k', 'working');
    expect(await m.workingGet('k')).toBeUndefined();
  });

  it('recall records a memory.recalled event', async () => {
    const store = new InMemoryTraceStore();
    const m = makeMemory(store, 's2');
    await m.recall('nothing');
    const types = (await store.readBySession('s2')).map(e => e.type);
    expect(types).toContain('memory.recalled');
  });
});
