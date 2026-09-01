import { describe, expect, it } from 'vitest';
import { SkillRouter } from '../src/skill-router.js';

describe('SkillRouter', () => {
  it('selects relevant skills from summaries and caps active skills', () => {
    const router = new SkillRouter([
      { id: 'research', name: 'Research', description: 'search sources and cite evidence', tags: ['research'], version: '1.0.0', status: 'approved' },
      { id: 'coding', name: 'Coding', description: 'edit files and run tests', tags: ['code'], version: '1.0.0', status: 'approved' },
      { id: 'old', name: 'Old', description: 'research', status: 'deprecated' },
    ]);
    const route = router.route('research sources and cite evidence', { max_active: 1, threshold: 0.1 });
    expect(route.selected.map((skill) => skill.id)).toEqual(['research']);
    expect(route.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honours explicit and fixed skills before automatic candidates', () => {
    const router = new SkillRouter([{ id: 'fixed', name: 'Fixed', status: 'approved' }, { id: 'other', name: 'Other', status: 'approved' }]);
    expect(router.route('unrelated task', { fixed: ['fixed'], max_active: 1 }).selected.map((skill) => skill.id)).toEqual(['fixed']);
  });
});
