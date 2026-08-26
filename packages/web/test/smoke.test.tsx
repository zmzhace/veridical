import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '../src/App';

test('renders shell with nav and sessions heading', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><App /></QueryClientProvider>);
  expect(await screen.findByText('Veridical')).toBeInTheDocument();
  expect(await screen.findByText('会话')).toBeInTheDocument();
});