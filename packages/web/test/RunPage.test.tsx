import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RunPage } from '../src/pages/RunPage';

afterEach(() => vi.unstubAllGlobals());
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <RunPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
test('uses configured model without requesting browser credentials and handles failures', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, model: 'qwen-test' }),
    })
    .mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: '测试运行失败' } }),
    });
  vi.stubGlobal('fetch', fetch);
  mount();
  expect(await screen.findByText('qwen-test')).toBeInTheDocument();
  expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '开始运行' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('测试运行失败');
  const payload = JSON.parse(fetch.mock.calls[1][1].body);
  expect(payload.mode).toBe('live');
  expect(payload.apiKey).toBeUndefined();
  expect(payload.model).toBeUndefined();
  await waitFor(() => expect(screen.getByRole('button', { name: '开始运行' })).toBeEnabled());
});
test('unconfigured live model cannot run; mock remains available', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ configured: false }) }),
  );
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: '开始运行' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /真实模型/ }));
  expect(screen.getByRole('button', { name: '开始运行' })).toBeDisabled();
});
