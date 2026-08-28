import { test, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TraceTimeline } from '../src/components/TraceTimeline';
import type { TraceEvent } from '@veridical/schema';

const events: TraceEvent[] = [
  {
    id: '1',
    tenant_id: 't1',
    session_id: 's1',
    span_id: 'a',
    parent_span_id: null,
    seq: 1,
    type: 'llm.request',
    verb: 'request',
    attempt: 1,
    duration_ms: 5,
    payload: {},
    spec_version: '1.0.0',
  },
  {
    id: '2',
    tenant_id: 't1',
    session_id: 's1',
    span_id: 'b',
    parent_span_id: 'a',
    seq: 2,
    type: 'llm.response',
    verb: 'response',
    attempt: 1,
    duration_ms: 10,
    payload: { text: 'hi' },
    spec_version: '1.0.0',
  },
];

test('renders one row per event with a human label and seq', () => {
  render(<TraceTimeline events={events} onSelect={() => {}} />);
  expect(screen.getAllByText('请求模型').length).toBeGreaterThan(0);
  expect(screen.getByText('模型返回')).toBeInTheDocument();
  expect(screen.getAllByText('1').length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: /2 模型返回/ })).toBeInTheDocument();
});

test('pairs explicit child input/output and filters call types', () => {
  const invocation = (
    id: string,
    parent: string | undefined,
    seq: number,
    actor: string,
    operation: string,
    input: unknown,
  ): TraceEvent => ({
    ...events[0],
    id,
    seq,
    invocation_id: id,
    parent_invocation_id: parent,
    path: `root/${id}`,
    type: 'invocation.start',
    payload: {
      invocation_id: id,
      parent_invocation_id: parent,
      path: `root/${id}`,
      actor,
      operation,
      input,
    },
  });
  const root = invocation('root', undefined, 1, 'agent', 'run', {});
  const child = invocation('child', 'root', 2, 'tool', 'search', { query: 'test input' });
  const end: TraceEvent = {
    ...child,
    id: 'child-end',
    seq: 3,
    type: 'invocation.end',
    payload: { ...(child.payload as object), status: 'success', output: { result: 'test output' } },
  };
  render(<TraceTimeline events={[root, child, end]} onSelect={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /search.*root\/child/ }));
  expect(screen.getByText(/test input/)).toBeInTheDocument();
  expect(screen.getByText(/test output/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('调用类型'), { target: { value: 'llm' } });
  expect(screen.getByText('没有匹配的记录，请调整筛选条件。')).toBeInTheDocument();
});
