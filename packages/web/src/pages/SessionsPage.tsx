import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client';
import { Link, useNavigate } from 'react-router-dom';
import { useSessions, useSpecs } from '../api/queries';
import { SessionList } from '../components/SessionList';

export function SessionsPage() {
  const { data, isLoading, error, refetch } = useSessions();
  const { data: specs } = useSpecs();
  const nav = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const [selectedMode, setSelectedMode] = useState<'mock' | 'live' | null>(null);
  const modelProfile = useQuery({
    queryKey: ['model-profile'],
    queryFn: () => apiFetch<{ configured: boolean; model?: string }>('/api/model-profile'),
    enabled: showNew,
    retry: false,
  });
  const conversationMode = selectedMode ?? (modelProfile.data?.configured ? 'live' : 'mock');
  const [specName, setSpecName] = useState('');
  const [search, setSearch] = useState('');
  const visible = (items: typeof convs) =>
    items.filter((s) =>
      `${s.session_id} ${s.spec_name ?? ''} ${s.first_message ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );

  const convs = useMemo(() => (data ?? []).filter((s) => s.session_id.startsWith('conv_')), [data]);
  const runs = useMemo(() => (data ?? []).filter((s) => !s.session_id.startsWith('conv_')), [data]);

  const openNew = () => {
    if (specs && specs.length > 0 && !specName) setSpecName((specs[0] as any).name);
    setShowNew(true);
  };

  if (isLoading)
    return (
      <p className="loading-state" role="status">
        正在加载运行轨迹…
      </p>
    );
  if (error)
    return (
      <div className="console-error" role="alert">
        <strong>加载会话失败</strong>
        <p>暂时无法连接工作区，请确认本地服务已启动。</p>
        <button className="btn btn-ghost" onClick={() => refetch()}>
          重新加载
        </button>
      </div>
    );

  return (
    <div>
      <div className="sessions-heading">
        <div>
          <h2 className="page-title">对话</h2>
          <p className="page-desc">与 agent 连续对话，整段对话就是一条可逐帧回看的轨迹。</p>
        </div>
        <button className="btn btn-primary shrink-0" onClick={openNew}>
          ＋ 新对话
        </button>
      </div>

      {(data?.length ?? 0) > 0 && (
        <div className="sessions-toolbar">
          <div className="sessions-summary">
            <span>
              <strong>{convs.length}</strong>段对话
            </span>
            <span>
              <strong>{runs.length}</strong>次运行
            </span>
          </div>
          <input
            className="field session-search"
            aria-label="搜索会话"
            placeholder="搜索名称、会话 ID 或消息…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      {convs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-[13px] font-semibold text-[var(--muted)] mb-2">对话</h3>
          <SessionList
            kind="conv"
            sessions={visible(convs)}
            onSelect={(id) => nav(`/sessions/${id}`)}
          />
        </div>
      )}
      {runs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-[13px] font-semibold text-[var(--muted)] mb-2">运行</h3>
          <SessionList
            kind="run"
            sessions={visible(runs)}
            onSelect={(id) => nav(`/sessions/${id}`)}
          />
        </div>
      )}

      {convs.length === 0 && runs.length === 0 && (
        <>
          <section className="session-intro">
            <div className="session-intro-copy">
              <h3>从一次运行开始。</h3>
              <p>还没有任何对话。配置你的 agent，发起任务，在这里查看每一次模型决策与工具调用。</p>
              <div className="session-intro-actions">
                <Link className="btn btn-primary" to="/run">
                  运行第一个 agent
                </Link>
                <Link className="btn btn-ghost" to="/specs">
                  配置规格
                </Link>
              </div>
            </div>
            <figure className="trajectory-preview">
              <figcaption>轨迹结构示意 · 非实际运行数据</figcaption>
              <ol className="trajectory-diagram">
                {[
                  ['任务输入', '指令、上下文与运行规格'],
                  ['Agent 决策', '模型响应与子 Agent 委派'],
                  ['工具调用', '完整输入、输出与状态'],
                  ['结果与回放', '沿调用路径检查每一步'],
                ].map(([title, desc]) => (
                  <li key={title}>
                    <span className="trajectory-node" />
                    <div>
                      <strong>{title}</strong>
                      <small>{desc}</small>
                    </div>
                  </li>
                ))}
              </ol>
            </figure>
          </section>
          <div className="session-guidance">
            <span>模拟运行无需模型额度；真实运行使用服务端模型配置。</span>
            <Link to="/specs">管理 Agent 规格 →</Link>
          </div>
        </>
      )}
      {search && visible(convs).length + visible(runs).length === 0 && (
        <div className="empty">
          <p className="empty-title">没有匹配的会话</p>
          <button className="btn btn-ghost mt-3" onClick={() => setSearch('')}>
            清除搜索
          </button>
        </div>
      )}

      {showNew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setShowNew(false)}
        >
          <div
            className="card w-[28rem] max-w-[90vw] p-6 bg-white"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[15px] font-semibold mb-1">选择规格</h3>
            <p className="text-[12px] text-[var(--muted)] mb-4">
              新对话将使用选中的 agent 规格运行。
            </p>
            <label className="label">规格</label>
            <select
              className="field mb-3"
              value={specName}
              onChange={(e) => setSpecName(e.target.value)}
            >
              {(specs ?? []).map((s: any) => (
                <option key={s.name + s.version} value={s.name}>
                  {s.name}@{s.version}
                </option>
              ))}
            </select>
            <div className="run-modes mb-4">
              <button
                aria-pressed={conversationMode === 'mock'}
                onClick={() => setSelectedMode('mock')}
              >
                模拟运行<small>固定决策，不消耗模型额度</small>
              </button>
              <button
                disabled={!modelProfile.data?.configured}
                aria-pressed={conversationMode === 'live'}
                onClick={() => setSelectedMode('live')}
              >
                真实模型<small>{modelProfile.data?.model ?? '服务端模型未配置'}</small>
              </button>
            </div>
            <p className="text-xs text-[var(--muted)] mb-4">
              {conversationMode === 'live'
                ? '每次发送都会调用真实模型。历史消息会带入后续轮次。'
                : '模拟模式用于验证流程，不是真实模型回答。'}
            </p>
            <div className="flex gap-2 justify-end">
              <button className="btn btn-ghost" onClick={() => setShowNew(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={
                  !specName ||
                  modelProfile.isFetching ||
                  (conversationMode === 'live' && !modelProfile.data?.configured)
                }
                onClick={() =>
                  nav(`/sessions/new?spec=${encodeURIComponent(specName)}&mode=${conversationMode}`)
                }
              >
                开始对话
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
