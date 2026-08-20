import { describe, it, expect } from 'vitest';
import { SESSION_EVENT_TYPES } from '../src/index';

describe('schema package', () => {
  it('exports the session event type set', () => {
    expect(SESSION_EVENT_TYPES).toBeDefined();
    expect(SESSION_EVENT_TYPES).toContain('llm.request');
  });
});