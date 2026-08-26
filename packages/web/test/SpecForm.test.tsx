import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpecForm } from '../src/components/SpecForm';

test('SpecForm submits and clears on success', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ name: 'x', version: '1.0.0' }) }));
  const onSaved = vi.fn();
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><SpecForm onSaved={onSaved} /></QueryClientProvider>);
  fireEvent.change(screen.getByPlaceholderText('规格名称（如 insurance-check）'), { target: { value: 'x' } });
  fireEvent.change(screen.getByPlaceholderText('人设指令…'), { target: { value: 'hi' } });
  fireEvent.change(screen.getByPlaceholderText('provider（如 mock）'), { target: { value: 'mock' } });
  fireEvent.change(screen.getByPlaceholderText('model（如 deepseek-v4）'), { target: { value: 'm' } });
  fireEvent.click(screen.getByText('添加规格'));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect((screen.getByPlaceholderText('规格名称（如 insurance-check）') as HTMLInputElement).value).toBe('');
});

test('SpecForm shows server error on 400', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
    ok: false, status: 400,
    json: async () => ({ error: { code: 'invalid_spec', message: 'invalid yaml' } }),
  }));
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><SpecForm onSaved={() => {}} /></QueryClientProvider>);
  fireEvent.change(screen.getByPlaceholderText('规格名称（如 insurance-check）'), { target: { value: 'x' } });
  fireEvent.change(screen.getByPlaceholderText('人设指令…'), { target: { value: 'hi' } });
  fireEvent.change(screen.getByPlaceholderText('provider（如 mock）'), { target: { value: 'mock' } });
  fireEvent.change(screen.getByPlaceholderText('model（如 deepseek-v4）'), { target: { value: 'm' } });
  fireEvent.click(screen.getByText('添加规格'));
  await waitFor(() => expect(screen.getByTestId('spec-form-error')).toHaveTextContent('invalid yaml'));
});

test('SpecForm add/remove dynamic tool row', async () => {
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><SpecForm onSaved={() => {}} /></QueryClientProvider>);
  fireEvent.click(screen.getByText('+ 添加工具'));
  const toolInput = screen.getByPlaceholderText('工具名');
  fireEvent.change(toolInput, { target: { value: 't1' } });
  fireEvent.click(screen.getByText('删除'));
  await waitFor(() => expect(screen.queryByPlaceholderText('工具名')).not.toBeInTheDocument());
});