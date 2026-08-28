import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import { readSseFrames } from '../api/readSse';

const DEFAULT_SPEC = `name: demo
version: 1.0.0
schema_version: 1
instruction:
  system: >-
    You are a helpful agent. Return a JSON object with text and done: true
    when finished, or text and tool: {name, args} to call a permitted tool.
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: mock
  model: m
  fallback: []
tools:
  - name: echo
    access: allow
`;

export function RunPage() {
  const [specYaml, setSpecYaml] = useState(DEFAULT_SPEC);
  const [selectedMode, setMode] = useState<'mock' | 'live' | null>(null);
  const [script, setScript] = useState(JSON.stringify({ text: 'done', done: true }));
  const [prompt, setPrompt] = useState('你好，请介绍一下你能做什么。');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const nav = useNavigate();
  const profile = useQuery({
    queryKey: ['model-profile'],
    queryFn: () =>
      apiFetch<{ configured: boolean; model?: string; provider?: string; error?: string }>(
        '/api/model-profile',
      ),
    retry: 1,
  });
  const mode = selectedMode ?? (profile.data?.configured ? 'live' : 'mock');

  async function onRun() {
    if (pending) return;
    setPending(true);
    setError('');
    setProgress('正在创建运行…');
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specYaml,
          mode,
          prompt,
          ...(mode === 'mock' ? { script: script.split('\n').filter((s) => s.trim()) } : {}),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message ?? `运行请求失败 (${response.status})`);
      }
      if (!response.body) throw new Error('服务未返回运行数据');
      let completed = false;
      let failure = '';
      await readSseFrames(response, (frame) => {
        if (frame.type === 'event')
          setProgress(`已记录 ${frame.count ?? frame.event?.seq ?? 0} 个事件…`);
        if (frame.type === 'done') {
          completed = true;
          nav(`/sessions/${frame.session_id}`);
        }
        if (frame.type === 'error') failure = frame.message ?? '运行失败';
      });
      if (failure) throw new Error(failure);
      if (!completed) throw new Error('连接已结束，但未收到完成结果。请到会话页检查轨迹后再重试。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '运行失败，请重试');
    } finally {
      setPending(false);
      setProgress('');
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="page-title">运行 agent</h2>
        <p className="page-desc">定义任务，选择运行方式。每一步决策与工具调用都会进入轨迹。</p>
      </div>
      <div className="run-layout">
        <div className="run-form space-y-5">
          <div className="run-modes">
            {(['live', 'mock'] as const).map((m) => (
              <button
                key={m}
                disabled={pending || profile.isLoading}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {m === 'live' ? '真实模型' : '模拟运行'}
                <small>
                  {m === 'live' ? '使用服务端已配置的模型' : '使用固定决策，不消耗模型额度'}
                </small>
              </button>
            ))}
          </div>
          {mode === 'live' && (
            <div className="model-profile">
              <div>
                <strong>{profile.data?.model ?? '尚未配置模型'}</strong>
                <p>
                  {profile.data?.configured
                    ? '凭据由服务端管理，无需再次填写。'
                    : (profile.data?.error ?? '请在服务端 .env.local 配置模型并重启。')}
                </p>
              </div>
              <span className={`badge ${profile.data?.configured ? 'badge-good' : 'badge-warn'}`}>
                {profile.data?.configured ? '已配置' : '未配置'}
              </span>
            </div>
          )}
          {profile.isError && (
            <div role="alert" className="console-error">
              无法读取模型配置。
              <button className="btn btn-ghost" onClick={() => profile.refetch()}>
                重试
              </button>
            </div>
          )}
          <div>
            <label className="label" htmlFor="run-prompt">
              任务输入
            </label>
            <textarea
              id="run-prompt"
              className="field h-24"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={pending}
            />
          </div>
          <details>
            <summary className="text-[13px] font-semibold cursor-pointer py-2">
              运行规格 · YAML
            </summary>
            <p className="text-xs text-[var(--muted)] my-2">
              真实运行会使用服务端模型覆盖此规格中的模型字段，并记录实际配置。
            </p>
            <label className="label" htmlFor="run-spec">
              规格 (Spec)
            </label>
            <textarea
              id="run-spec"
              className="field h-64 mono"
              value={specYaml}
              onChange={(e) => setSpecYaml(e.target.value)}
              disabled={pending}
            />
          </details>
          {mode === 'mock' && (
            <div>
              <label className="label" htmlFor="run-script">
                模拟决策（每行一个 JSON）
              </label>
              <textarea
                id="run-script"
                className="field h-24 mono"
                value={script}
                onChange={(e) => setScript(e.target.value)}
                disabled={pending}
              />
            </div>
          )}
          {error && (
            <p className="console-error" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={onRun}
              disabled={
                pending ||
                profile.isLoading ||
                !prompt.trim() ||
                (mode === 'live' && !profile.data?.configured)
              }
              className="btn btn-primary"
            >
              {pending ? '运行中…' : '开始运行'}
            </button>
            <span role="status" className="text-xs text-[var(--muted)]">
              {progress ||
                (mode === 'live'
                  ? '点击后将调用真实模型，消耗模型额度。'
                  : '仅在本地模拟，不调用外部模型。')}
            </span>
          </div>
        </div>
        <aside className="run-aside">
          <h3>从输入，到可回放的结果</h3>
          <p>模型与工具的输入、输出会保留在本次会话中。完成后自动进入轨迹详情。</p>
          <p>先用模拟运行验证流程，再切换真实模型。当前工作区是研究环境，不是生产发布入口。</p>
          <p>
            需要调整职责、技能或子 Agent？
            <br />
            <Link className="text-[var(--accent)] underline underline-offset-4" to="/specs">
              前往规格配置
            </Link>
          </p>
        </aside>
      </div>
    </div>
  );
}
