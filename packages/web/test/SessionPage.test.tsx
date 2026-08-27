import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionPage } from '../src/pages/SessionPage';

// jsdom 未实现 scrollIntoView，流式滚动会报 Not-implemented 错误
Element.prototype.scrollIntoView = function () {};

function sseResponse(frames: unknown[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('sends a message and renders token + assistant bubble', async () => {
  vi.stubGlobal('fetch', vi.fn()
    // useSession /api/sessions/conv_a
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    // useCheckpoints /api/sessions/conv_a/checkpoints
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    // POST /api/run/turn → SSE
    .mockResolvedValueOnce(sseResponse([
      { type: 'token', session_id: 'conv_a', text: '你' },
      { type: 'token', session_id: 'conv_a', text: '好' },
      { type: 'event', event: { id: 'e1', type: 'assistant.message', role: 'assistant', seq: 1, payload: { text: '你好' }, span_id: 'loop', parent_span_id: null, verb: 'response', attempt: 1, duration_ms: 0, session_id: 'conv_a', tenant_id: 't1', spec_version: '1.0.0' } },
      { type: 'turn_end', session_id: 'conv_a' },
      { type: 'done', session_id: 'conv_a', event_count: 1 },
    ])));
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/sessions/conv_a']}>
        <Routes><Route path="/sessions/:id" element={<SessionPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const ta = await screen.findByPlaceholderText('输入消息…');
  fireEvent.change(ta, { target: { value: 'hi' } });
  fireEvent.keyDown(ta, { key: 'Enter' });
  await waitFor(() => expect(screen.getAllByText('你好').length).toBeGreaterThan(0));
  // 不得在 done 后发起第 4 个 fetch（setQueryData 而非 invalidateQueries）
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('disables chat input on run trace sessions', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/sessions/run_abc']}>
        <Routes><Route path="/sessions/:id" element={<SessionPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const ta = await screen.findByPlaceholderText('单次运行轨迹不支持继续对话');
  expect(ta).toBeDisabled();
});

test('renders empty state for id=new', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/sessions/new?spec=demo&mode=mock']}>
        <Routes><Route path="/sessions/:id" element={<SessionPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/demo/)).toBeInTheDocument();
});
