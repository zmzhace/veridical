import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpecsPage } from '../src/pages/SpecsPage';

test('SpecsPage submits new spec', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ name: 'n', version: '1.0.0' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'n', version: '1.0.0' }] }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><SpecsPage /></QueryClientProvider>);
  const ta = await screen.findByPlaceholderText('粘贴 YAML…');
  fireEvent.change(ta, { target: { value: 'name: n\nversion: 1.0.0\nschema_version: 1\ninstruction: { system: hi }\nflow: { mode: single-loop, max_steps: 1 }\nllm: { provider: mock, model: m, fallback: [] }\ntools: []\n' } });
  fireEvent.click(screen.getByText('添加规格'));
  await waitFor(() => expect(screen.getByText('n')).toBeInTheDocument());
});