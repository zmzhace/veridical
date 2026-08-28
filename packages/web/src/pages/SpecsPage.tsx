import { useState } from 'react';
import { stringify } from 'yaml';
import { useSpecs } from '../api/queries';
import { SpecForm } from '../components/SpecForm';
import { nextVersion, type AgentSpec } from '../spec/editor';

export function SpecsPage() {
  const { data, isLoading, error, refetch, isFetching } = useSpecs();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AgentSpec>();
  const [initial, setInitial] = useState<AgentSpec>();
  const [editorKey, setEditorKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [notice, setNotice] = useState('');
  const specs = (data ?? []) as AgentSpec[];
  const filtered = specs.filter((s) =>
    `${s.name} ${s.version} ${s.description ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  function navigate(action: () => void) {
    if (busy) return;
    if (dirty) setPendingAction(() => action);
    else action();
  }
  function create(source?: AgentSpec) {
    setInitial(
      source
        ? {
            ...source,
            version: nextVersion(
              source.version,
              specs.filter((s) => s.name === source.name).map((s) => s.version),
            ),
          }
        : undefined,
    );
    setSelected(undefined);
    setEditorKey((k) => k + 1);
    setDirty(false);
    setNotice('');
  }

  return (
    <div className="spec-page">
      <header className="spec-page-heading">
        <div>
          <h2 className="page-title">Spec 配置</h2>
          <p className="page-desc">把 Agent 的行为约定，变成清晰、可复用的版本。</p>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => navigate(() => create())}
        >
          新建规格
        </button>
      </header>
      <div className="spec-workspace-note">
        <span>本地研究工作区</span>
        <p>此页面连接 /api 规格库。生产环境的评测、审批与发布需通过独立的 /v1 治理流程。</p>
      </div>
      {pendingAction && (
        <div className="spec-discard" role="alert">
          <div>
            <strong>当前草稿尚未保存</strong>
            <p>切换会丢弃这些修改，是否继续？</p>
          </div>
          <button className="btn btn-ghost" onClick={() => setPendingAction(null)}>
            继续编辑
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              pendingAction();
              setPendingAction(null);
              setDirty(false);
            }}
          >
            丢弃并切换
          </button>
        </div>
      )}
      {notice && (
        <p className="spec-page-notice" role="status">
          {notice}
        </p>
      )}
      <div className="spec-workspace">
        <aside className="spec-library" aria-label="规格库">
          <div className="spec-library-heading">
            <h3>
              规格库 <span>{isLoading ? '…' : specs.length}</span>
            </h3>
            <button className="spec-text-button" disabled={isFetching} onClick={() => refetch()}>
              {isFetching ? '加载中…' : '刷新'}
            </button>
          </div>
          <label className="sr-only" htmlFor="spec-search">
            搜索规格
          </label>
          <input
            id="spec-search"
            className="field spec-search"
            type="search"
            placeholder="搜索名称、版本或描述"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="spec-library-hint">选择版本查看，或基于它创建新版本。</p>
          {isLoading ? (
            <p role="status" className="spec-library-empty">
              正在加载规格…
            </p>
          ) : error ? (
            <div role="alert" className="spec-library-empty">
              <strong>规格库加载失败</strong>
              <p>{error instanceof Error ? error.message : '请检查服务连接。'}</p>
              <button className="btn btn-ghost" onClick={() => refetch()}>
                重试
              </button>
            </div>
          ) : filtered.length ? (
            <div className="spec-library-list">
              {filtered.map((s) => (
                <button
                  disabled={busy}
                  key={`${s.name}@${s.version}`}
                  className="spec-library-item"
                  aria-pressed={selected?.name === s.name && selected?.version === s.version}
                  onClick={() =>
                    navigate(() => {
                      setSelected(s);
                      setDirty(false);
                      setNotice('');
                    })
                  }
                >
                  <span className="spec-library-name">{s.name}</span>
                  <span className="spec-library-version mono">v{s.version}</span>
                  <span className="spec-library-description">
                    {s.description || '暂无用途描述'}
                  </span>
                  <span className="spec-library-meta">
                    {s.flow?.mode ?? '未指定流程'} · {s.tools?.length ?? 0} 个工具
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="spec-library-empty">
              <strong>{query ? '没有匹配的规格' : '还没有注册规格'}</strong>
              <p>{query ? '试试其他名称或版本。' : '从配置表单开始，创建第一份 Agent 配置。'}</p>
              {query && (
                <button className="spec-text-button" onClick={() => setQuery('')}>
                  清空搜索
                </button>
              )}
            </div>
          )}
        </aside>
        <div className="spec-workbench">
          {selected ? (
            <article className="spec-editor spec-inspect">
              <header className="spec-editor-heading">
                <div>
                  <h3>{selected.name}</h3>
                  <p className="mono">v{selected.version}</p>
                </div>
                <span className="spec-draft">已注册 · 只读</span>
              </header>
              <div className="spec-inspect-body">
                <h4>版本说明</h4>
                <p>{selected.description || '此版本尚未填写用途描述。'}</p>
                <dl className="spec-details">
                  <div>
                    <dt>模型</dt>
                    <dd>
                      {selected.llm?.provider ?? '—'} / {selected.llm?.model ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>运行方式</dt>
                    <dd>
                      {selected.flow?.mode ?? '—'} · 最多 {selected.flow?.max_steps ?? '—'} 步
                    </dd>
                  </div>
                  <div>
                    <dt>工具权限</dt>
                    <dd>{selected.tools?.length ?? 0} 个声明</dd>
                  </div>
                </dl>
                <div className="spec-subheading">
                  <h4>已注册 YAML</h4>
                  <span>不可覆盖</span>
                </div>
                <pre className="spec-yaml-readonly mono" tabIndex={0} aria-label="已注册 YAML">
                  {stringify(selected, { lineWidth: 0 })}
                </pre>
              </div>
              <footer className="spec-editor-footer">
                <p>修改配置时创建新版本，保留旧版本供引用。</p>
                <button className="btn btn-primary" onClick={() => create(selected)}>
                  基于此版本创建
                </button>
              </footer>
            </article>
          ) : (
            <SpecForm
              key={editorKey}
              initial={initial}
              onDirtyChange={setDirty}
              onBusyChange={setBusy}
              onSaved={(s) => {
                setPendingAction(null);
                setDirty(false);
                setBusy(false);
                setInitial(undefined);
                setEditorKey((k) => k + 1);
                if (s) setNotice(`${s.name} · v${s.version} 已注册到本地规格库。`);
                void refetch();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
