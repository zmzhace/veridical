import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../src/App';

test('renders shell with nav and sessions heading', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><App /></QueryClientProvider>);
  expect(await screen.findByText('Veridical')).toBeInTheDocument();
  expect(await screen.findByRole('link', { name: '会话', exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /RL 训练/ })).not.toBeInTheDocument();
});
