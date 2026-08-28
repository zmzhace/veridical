import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import { SpecForm } from '../src/components/SpecForm';
import { SpecsPage } from '../src/pages/SpecsPage';
import { blankSpec, formToSpec } from '../src/spec/editor';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const fixture = () => ({
  ...blankSpec(),
  name: 'review-agent',
  version: '1.0.0',
  system: 'Review the task.',
  llmProvider: 'mock',
  llmModel: 'mock-v1',
});
const spec = () => formToSpec(fixture());
function renderWithQuery(child: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
        })
      }
    >
      {child}
    </QueryClientProvider>,
  );
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });

test('form → YAML → form shares edits and preserves unsupported flow sections', () => {
  renderWithQuery(<SpecForm initial={spec()} onSaved={() => {}} />);
  change('用途描述', 'Updated purpose');
  fireEvent.click(screen.getByRole('button', { name: '粘贴 YAML' }));
  const text = screen.getByLabelText('规格 YAML') as HTMLTextAreaElement;
  expect(text.value).toContain('Updated purpose');
  fireEvent.change(text, { target: { value: text.value.replace('mock-v1', 'changed-model') } });
  fireEvent.click(screen.getByRole('button', { name: '表单配置' }));
  fireEvent.click(screen.getByRole('button', { name: '模型与指令' }));
  expect(screen.getByLabelText('模型 *')).toHaveValue('changed-model');
  expect(screen.getByLabelText('系统指令 *')).toHaveValue('Review the task.');
});

test('an unchanged incomplete form can switch to YAML and back without trapping the user', () => {
  renderWithQuery(<SpecForm onSaved={() => {}} />);
  change('规格名称 *', 'unfinished');
  fireEvent.click(screen.getByRole('button', { name: '粘贴 YAML' }));
  fireEvent.click(screen.getByRole('button', { name: '表单配置' }));
  expect(screen.getByLabelText('规格名称 *')).toHaveValue('unfinished');
});

test('invalid YAML stays editable and never submits or discards its contents', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderWithQuery(<SpecForm initial={spec()} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '粘贴 YAML' }));
  change('规格 YAML', 'name: [broken');
  fireEvent.click(screen.getByRole('button', { name: '表单配置' }));
  expect(screen.getByRole('alert')).toHaveTextContent('YAML 格式错误');
  expect(screen.getByLabelText('规格 YAML')).toHaveValue('name: [broken');
  fireEvent.click(screen.getByRole('button', { name: '注册新版本' }));
  expect(fetch).not.toHaveBeenCalled();
});

test('zero steps are rejected instead of silently changed to one', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderWithQuery(<SpecForm initial={spec()} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '运行流程' }));
  change('最大步数 *', '0');
  fireEvent.click(screen.getByRole('button', { name: '注册新版本' }));
  expect(screen.getByLabelText('最大步数 *')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('最大步数 *')).toHaveValue(0);
  expect(fetch).not.toHaveBeenCalled();
});

test('new tools default to deny and incomplete rows cannot disappear during save', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  renderWithQuery(<SpecForm initial={spec()} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '工具权限' }));
  fireEvent.click(screen.getByRole('button', { name: '+ 添加工具' }));
  expect(screen.getByLabelText('调用权限')).toHaveValue('deny');
  fireEvent.click(screen.getByRole('button', { name: '注册新版本' }));
  expect(screen.getByLabelText('工具 1 · 名称')).toHaveAttribute('aria-invalid', 'true');
  expect(fetch).not.toHaveBeenCalled();
});

test('duplicate version errors preserve the complete draft', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'duplicate_spec', message: 'Version already exists' },
      }),
    }),
  );
  renderWithQuery(<SpecForm initial={spec()} onSaved={() => {}} />);
  change('用途描述', 'Do not lose this');
  fireEvent.click(screen.getByRole('button', { name: '注册新版本' }));
  await screen.findByText('Version already exists');
  expect(screen.getByLabelText('用途描述')).toHaveValue('Do not lose this');
  expect(screen.getByLabelText('版本 *')).toHaveValue('1.0.0');
});

test('pending registration disables editing and duplicate submission', async () => {
  let resolve!: (v: unknown) => void;
  const fetch = vi.fn().mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const saved = vi.fn();
  renderWithQuery(<SpecForm initial={spec()} onSaved={saved} />);
  fireEvent.click(screen.getByRole('button', { name: '注册新版本' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '注册中…' })).toBeDisabled());
  expect(screen.getByLabelText('用途描述')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '注册中…' }));
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve({ ok: true, json: async () => spec() });
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
});

test('library search, immutable inspection and next-version creation work together', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [spec(), { ...spec(), version: '1.0.1' }] }),
  );
  renderWithQuery(<SpecsPage />);
  const version = await screen.findByRole('button', { name: /review-agent v1.0.0/ });
  fireEvent.click(version);
  expect(screen.getByLabelText('已注册 YAML')).toHaveTextContent('version: 1.0.0');
  expect(screen.queryByLabelText('规格名称 *')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '基于此版本创建' }));
  expect(screen.getByLabelText('版本 *')).toHaveValue('1.0.2');
  expect(screen.getByLabelText('规格名称 *')).toHaveValue('review-agent');
  change('搜索规格', 'no-such-spec');
  expect(screen.getByText('没有匹配的规格')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
  expect(screen.getByRole('button', { name: /review-agent v1.0.0/ })).toBeInTheDocument();
});

test('switching an unsaved draft requires explicit discard and cancel keeps edits', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [spec()] }));
  renderWithQuery(<SpecsPage />);
  await screen.findByRole('button', { name: /review-agent v1.0.0/ });
  change('规格名称 *', 'unsaved');
  fireEvent.click(screen.getByRole('button', { name: /review-agent v1.0.0/ }));
  expect(screen.getByText('当前草稿尚未保存')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.getByLabelText('规格名称 *')).toHaveValue('unsaved');
  fireEvent.click(screen.getByRole('button', { name: /review-agent v1.0.0/ }));
  fireEvent.click(screen.getByRole('button', { name: '丢弃并切换' }));
  expect(screen.getByLabelText('已注册 YAML')).toBeInTheDocument();
});

test('library failures offer retry without clearing the draft', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
  vi.stubGlobal('fetch', fetch);
  renderWithQuery(<SpecsPage />);
  change('规格名称 *', 'keep-me');
  await screen.findByText('规格库加载失败');
  fetch.mockResolvedValue({ ok: true, json: async () => [spec()] });
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByRole('button', { name: /review-agent v1.0.0/ });
  expect(screen.getByLabelText('规格名称 *')).toHaveValue('keep-me');
});

test('route navigation is blocked while a draft is unsaved', async () => {
  const router = createMemoryRouter(
    [
      {
        path: '/specs',
        element: (
          <>
            <Link to="/other">其他页面</Link>
            <SpecForm onSaved={() => {}} />
          </>
        ),
      },
      { path: '/other', element: <p>已离开</p> },
    ],
    { initialEntries: ['/specs'] },
  );
  renderWithQuery(<RouterProvider router={router} />);
  change('规格名称 *', 'unsaved');
  fireEvent.click(screen.getByRole('link', { name: '其他页面' }));
  await screen.findByText('离开前要保留这份草稿吗？');
  fireEvent.click(screen.getByRole('button', { name: '留在此页' }));
  expect(screen.getByLabelText('规格名称 *')).toHaveValue('unsaved');
  fireEvent.click(screen.getByRole('link', { name: '其他页面' }));
  fireEvent.click(screen.getByRole('button', { name: '丢弃并离开' }));
  await screen.findByText('已离开');
  router.dispose();
});

test('copy failures provide a manual recovery path', async () => {
  renderWithQuery(<SpecForm initial={spec()} onSaved={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '复制 YAML' }));
  await screen.findByText('复制不可用，请切换到 YAML 后手动复制。');
});

test('quick setup can suggest tools from the task description', () => {
  renderWithQuery(<SpecForm onSaved={() => {}} />);
  change('用途描述', '查询订单并计算金额');
  fireEvent.click(screen.getByRole('button', { name: '根据任务自动添加' }));
  expect(
    screen.getAllByPlaceholderText('工具名').map((element) => (element as HTMLInputElement).value),
  ).toEqual(['search', 'calculator', 'finish']);
  expect(
    screen.getByText('已根据任务添加 search、calculator、finish。请确认权限。'),
  ).toBeInTheDocument();
});
