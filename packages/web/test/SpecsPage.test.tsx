import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpecsPage } from '../src/pages/SpecsPage';

test('SpecsPage form tab adds a spec', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ name: 'x', version: '1.0.0' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'x', version: '1.0.0' }] }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><SpecsPage /></QueryClientProvider>);
  fireEvent.change(screen.getByPlaceholderText('规格名称（如 insurance-check）'), { target: { value: 'x' } });
  fireEvent.change(screen.getByPlaceholderText('人设指令…'), { target: { value: 'hi' } });
  fireEvent.change(screen.getByPlaceholderText('provider（如 mock）'), { target: { value: 'mock' } });
  fireEvent.change(screen.getByPlaceholderText('model（如 deepseek-v4）'), { target: { value: 'm' } });
  fireEvent.click(screen.getByText('添加规格'));
  await waitFor(() => expect(screen.getByText('x')).toBeInTheDocument());
});

test('SpecsPage yaml tab still submits YAML', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [] })
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ name: 'n', version: '1.0.0' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [{ name: 'n', version: '1.0.0' }] }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><SpecsPage /></QueryClientProvider>);
  fireEvent.click(screen.getByText('粘贴 YAML'));
  const ta = await screen.findByPlaceholderText('粘贴 YAML…');
  fireEvent.change(ta, { target: { value: 'name: n\nversion: 1.0.0\nschema_version: 1\ninstruction: { system: hi }\nflow: { mode: single-loop, max_steps: 1 }\nllm: { provider: mock, model: m, fallback: [] }\ntools: []\n' } });
  fireEvent.click(screen.getByText('添加规格'));
  await waitFor(() => expect(screen.getByText('n')).toBeInTheDocument());
});