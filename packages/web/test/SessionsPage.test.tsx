import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SessionsPage } from '../src/pages/SessionsPage';

test('renders 新对话 button and splits conv/run groups', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [
      { session_id: 'conv_a', spec_version: '1.0.0', spec_name: '保险转保', turn_count: 2, first_message: '我要退保', event_count: 9, total_duration_ms: 1, first_seq: 0, last_seq: 8 },
      { session_id: 'run_b', spec_version: '1.0.0', event_count: 4, total_duration_ms: 1, first_seq: 0, last_seq: 3 },
    ] })
    .mockResolvedValueOnce({ ok: true, json: async () => [] }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><MemoryRouter><SessionsPage /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText('保险转保')).toBeInTheDocument());
  expect(screen.getByText('＋ 新对话')).toBeInTheDocument();
  // 页面标题与对话组标题均为"对话"，用 getAllByText
  expect(screen.getAllByText('对话').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('运行')).toBeInTheDocument();
  expect(screen.getByText('2 轮')).toBeInTheDocument();
});

test('新对话 opens spec picker modal', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'demo', version: '1.0.0' }] }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><MemoryRouter><SessionsPage /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByText('＋ 新对话'));
  await waitFor(() => expect(screen.getByText('选择规格')).toBeInTheDocument());
  expect(screen.getByText('demo@1.0.0')).toBeInTheDocument();
  expect(screen.getByText('模拟运行')).toBeInTheDocument();
});
