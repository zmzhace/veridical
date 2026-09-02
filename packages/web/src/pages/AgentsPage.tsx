import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAgents,
  useArchiveAgent,
  useCreateAgent,
  useDuplicateAgent,
  useModelProfile,
  useSessions,
} from '../api/queries';
import type { AgentSummary } from '../api/types';
import '../product.css';
import '../agents.css';

function AgentMark({ agent }: { agent: AgentSummary }) {
  return (
    <span className="agent-mark" aria-hidden="true">
      {agent.name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AgentsPage() {
  const agents = useAgents();
  const sessions = useSessions();
  const create = useCreateAgent();
  const modelProfile = useModelProfile();
  const duplicate = useDuplicateAgent();
  const archive = useArchiveAgent();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'draft' | 'published'>('all');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', model: 'server-default' });
  const rows = useMemo(
    () =>
      (agents.data ?? []).filter((agent) => {
        const matches = `${agent.name} ${agent.description}`
          .toLowerCase()
          .includes(query.toLowerCase());
        return matches && (status === 'all' || agent.status === status);
      }),
    [agents.data, query, status],
  );
  const groups = useMemo(
    () =>
      [
        {
          key: 'published',
          label: '已发布',
          items: rows.filter((agent) => agent.status === 'published'),
        },
        { key: 'draft', label: '草稿', items: rows.filter((agent) => agent.status === 'draft') },
      ].filter((group) => group.items.length),
    [rows],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const agent = await create.mutateAsync(form);
    await client.invalidateQueries({ queryKey: ['agents'] });
    setCreating(false);
    navigate(`/agents/${agent.id}/studio`);
  }
  async function duplicateAgent(id: string) {
    const copy = await duplicate.mutateAsync(id);
    await client.invalidateQueries({ queryKey: ['agents'] });
    navigate(`/agents/${copy.id}/studio`);
  }
  async function archiveAgent(id: string) {
    if (!window.confirm('归档后将从 Agent 列表隐藏，已有运行记录仍会保留。')) return;
    await archive.mutateAsync(id);
    await client.invalidateQueries({ queryKey: ['agents'] });
  }

  return (
    <section className="agents-page">
      <header className="product-heading">
        <div>
          <p className="product-kicker">Agent workspace</p>
          <h1>Agents</h1>
          <p>创建、运行和治理能够持续工作的 Agent。</p>
        </div>
        <button className="button button-primary" onClick={() => setCreating(true)}>
          新建 Agent
        </button>
      </header>
      <div className="agents-controls">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="搜索 Agent"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Agent"
          />
        </label>
        <div className="segmented" aria-label="状态筛选">
          {(
            [
              ['all', '全部'],
              ['published', '已发布'],
              ['draft', '草稿'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {agents.isLoading ? (
        <div className="agent-list-v2" aria-label="正在加载">
          {[1, 2, 3].map((n) => (
            <div className="agent-row-v2 skeleton" key={n} />
          ))}
        </div>
      ) : agents.error ? (
        <div className="state-panel" role="alert">
          <strong>无法加载 Agent</strong>
          <p>请确认研究服务正在运行。</p>
          <button className="button" onClick={() => agents.refetch()}>
            重试
          </button>
        </div>
      ) : rows.length ? (
        <div className="agent-groups-v2">
          {groups.map((group) => (
            <section key={group.key} className="agent-group-v2">
              <header>
                <strong>{group.label}</strong>
                <span>{group.items.length}</span>
              </header>
              <div className="agent-list-v2">
                {group.items.map((agent) => {
                  const tasks = (sessions.data ?? []).filter(
                    (session) => session.spec_name === agent.id,
                  );
                  const model =
                    agent.model === 'server-default'
                      ? (modelProfile.data?.model ?? '服务端默认模型')
                      : agent.model;
                  const destination =
                    agent.status === 'published'
                      ? `/agents/${agent.id}`
                      : `/agents/${agent.id}/studio`;
                  return (
                    <article className="agent-row-v2" key={agent.id}>
                      <AgentMark agent={agent} />
                      <Link className="agent-row-main" to={destination}>
                        <span>
                          <strong>{agent.name}</strong>
                          {agent.mock && <em>开发示例</em>}
                        </span>
                        <small>{agent.description || '尚未填写职责'}</small>
                      </Link>
                      <div className="agent-row-meta">
                        <span>{model}</span>
                        <span>{agent.version ?? '未发布'}</span>
                        <span>{tasks.length} 个任务</span>
                      </div>
                      <Link className="agent-row-open" to={destination}>
                        {agent.status === 'published' ? '打开' : '继续配置'}
                      </Link>
                      <details className="agent-menu">
                        <summary aria-label={`${agent.name} 更多操作`}>•••</summary>
                        <div>
                          <Link to={`/agents/${agent.id}/studio`}>编辑</Link>
                          <button onClick={() => duplicateAgent(agent.id)}>复制</button>
                          <button onClick={() => archiveAgent(agent.id)}>归档</button>
                        </div>
                      </details>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="state-panel">
          <span className="state-monogram">V</span>
          <strong>{query ? '没有匹配的 Agent' : '创建第一个 Agent'}</strong>
          <p>
            {query
              ? '尝试调整搜索词或筛选条件。'
              : '只需填写职责和模型，系统会补齐安全的运行配置。'}
          </p>
          {!query && (
            <button className="button button-primary" onClick={() => setCreating(true)}>
              新建 Agent
            </button>
          )}
        </div>
      )}
      {creating && (
        <div className="sheet-backdrop" onMouseDown={() => setCreating(false)}>
          <form
            className="product-sheet"
            onSubmit={submit}
            onMouseDown={(event) => event.stopPropagation()}
            aria-label="新建 Agent"
          >
            <header>
              <div>
                <p className="product-kicker">New agent</p>
                <h2>新建 Agent</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={() => setCreating(false)}
              >
                ×
              </button>
            </header>
            <label>
              名称
              <input
                required
                autoFocus
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="例如：研究助手"
              />
            </label>
            <label>
              职责
              <textarea
                required
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="说明它负责什么、怎样判断完成"
              />
            </label>
            <label>
              模型
              <select
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
              >
                <option value="server-default">服务端默认模型</option>
                <option value="qwen3.8-flash">Qwen 3.8 Flash</option>
              </select>
              <small>凭据由服务端读取，不会要求你重复填写 API Key。</small>
            </label>
            {create.error && (
              <p className="inline-error" role="alert">
                {create.error.message}
              </p>
            )}
            <footer>
              <button type="button" className="button" onClick={() => setCreating(false)}>
                取消
              </button>
              <button className="button button-primary" disabled={create.isPending}>
                {create.isPending ? '创建中…' : '创建并编辑'}
              </button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
