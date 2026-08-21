import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TraceTimeline } from '../src/components/TraceTimeline';
import type { TraceEvent } from '@veridical/schema';

const events: TraceEvent[] = [
  { id: '1', tenant_id: 't1', session_id: 's1', span_id: 'a', parent_span_id: null, seq: 1, type: 'llm.request', verb: 'request', attempt: 1, duration_ms: 5, payload: {}, spec_version: '1.0.0' },
  { id: '2', tenant_id: 't1', session_id: 's1', span_id: 'b', parent_span_id: 'a', seq: 2, type: 'llm.response', verb: 'response', attempt: 1, duration_ms: 10, payload: { text: 'hi' }, spec_version: '1.0.0' },
];

test('renders one row per event and shows seq + type', () => {
  render(<TraceTimeline events={events} onSelect={() => {}} />);
  expect(screen.getByText('seq 1')).toBeInTheDocument();
  expect(screen.getByText('llm.request')).toBeInTheDocument();
  expect(screen.getByText('llm.response')).toBeInTheDocument();
});
