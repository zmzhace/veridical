import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCapabilityCatalog,
  useCreateMcpServer,
  useCreateSkillDraft,
  useCreateToolDraft,
  useCredentialStatus,
  useDiscoverMcpServer,
  useModels,
  type CapabilitySummary,
} from '../api/queries';
import { CapabilityDetail, CapabilityRow } from '../components/CapabilityCatalog';
import '../capabilities.css';
import '../product.css';

type View = 'all' | 'tool' | 'mcp' | 'skill' | 'knowledge' | 'model';
type AddMode = 'choose' | 'mcp' | 'tool' | 'skill' | null;

const viewLabels: Array<{ id: View; label: string }> = [
  { id: 'all', label: '全部能力' },
  { id: 'tool', label: '工具' },
  { id: 'mcp', label: 'MCP 连接' },
  { id: 'skill', label: 'Skills' },
  { id: 'knowledge', label: '知识' },
  { id: 'model', label: '模型' },
];

export function CapabilitiesPage() {
  const [view, setView] = useState<View>('all');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<CapabilitySummary['status'] | ''>('');
  const [risk, setRisk] = useState<CapabilitySummary['risk'] | ''>('');
  const [selected, setSelected] = useState<CapabilitySummary | null>(null);
  const [addMode, setAddMode] = useState<AddMode>(null);
  const kind = view === 'all' || view === 'model' ? undefined : view;
  const catalog = useCapabilityCatalog({
    kind,
    query,
    status: status || undefined,
    risk: risk || undefined,
  });
  const models = useModels();
  const credentials = useCredentialStatus();
  const items = catalog.data?.items ?? [];
  const counts = useMemo(() => {
    const value = { tool: 0, mcp: 0, skill: 0, knowledge: 0 };
    for (const item of items) if (item.kind in value) value[item.kind as keyof typeof value] += 1;
    return value;
  }, [items]);

  return (
    <section className="settings-page">
      <header className="settings-heading">
        <div>
          <h1>设置</h1>
          <p>管理 Agent 可以使用的模型、工具、工作方法和知识。安装、启用与生产批准彼此独立。</p>
        </div>
        <button className="button button-primary" onClick={() => setAddMode('choose')}>
          添加能力
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {viewLabels.map((item) => (
            <button
              key={item.id}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}
            >
              <span>{item.label}</span>
              {item.id === 'tool' && <small>{counts.tool}</small>}
              {item.id === 'mcp' && <small>{counts.mcp}</small>}
              {item.id === 'skill' && <small>{counts.skill}</small>}
              {item.id === 'knowledge' && <small>{counts.knowledge}</small>}
              {item.id === 'model' && <small>{models.data?.length ?? 0}</small>}
            </button>
          ))}
          <Link to="/context">记忆与知识</Link>
          <Link to="/audit">治理与审计</Link>
        </nav>
        <main className="capability-workspace">
          <div className="capability-health">
            <span className="capability-health-dot" />
            <strong>
              {credentials.data?.provider.configured ? '工作区能力可用' : '模型连接需要配置'}
            </strong>
            <span>{catalog.data?.total ?? 0} 项能力 · 凭据由服务端托管</span>
          </div>
          {view === 'model' ? (
            <section className="capability-list-shell" style={{ marginTop: 18 }}>
              <header className="capability-list-heading">
                <strong>模型连接</strong>
                <span>{models.data?.length ?? 0} 个</span>
              </header>
              {(models.data ?? []).map((model) => (
                <article className="capability-row" key={model.id}>
                  <div className="capability-row-main">
                    <span className="capability-kind">模型</span>
                    <span className="capability-row-copy">
                      <strong>{model.model}</strong>
                      <small>{model.provider} · 凭据不会发送到浏览器</small>
                    </span>
                    <span className="capability-row-facts">
                      <small>服务端配置</small>
                      <small>当前工作区</small>
                    </span>
                    <span
                      className={`capability-state is-${model.status === 'configured' ? 'approved' : 'unavailable'}`}
                    >
                      {model.status === 'configured' ? '可使用' : '不可用'}
                    </span>
                  </div>
                </article>
              ))}
              {!models.isLoading && !models.data?.length && (
                <EmptyState
                  title="还没有可用模型"
                  detail="在服务端配置 Provider 后会自动出现在这里，不需要再次填写 API Key。"
                />
              )}
            </section>
          ) : (
            <>
              <div className="capability-toolbar-v2">
                <label className="capability-search-v2">
                  <span className="sr-only">搜索能力</span>
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索名称、用途或标签"
                  />
                </label>
                <select
                  className="capability-filter"
                  aria-label="状态"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as typeof status)}
                >
                  <option value="">所有状态</option>
                  <option value="approved">可使用</option>
                  <option value="draft">待审批</option>
                  <option value="deprecated">将停用</option>
                  <option value="revoked">已撤销</option>
                  <option value="unavailable">不可用</option>
                </select>
                <select
                  className="capability-filter"
                  aria-label="权限"
                  value={risk}
                  onChange={(event) => setRisk(event.target.value as typeof risk)}
                >
                  <option value="">所有权限</option>
                  <option value="none">无副作用</option>
                  <option value="read">读取</option>
                  <option value="write">可修改</option>
                  <option value="destructive">高风险</option>
                </select>
              </div>
              <section className="capability-list-shell">
                <header className="capability-list-heading">
                  <strong>{viewLabels.find((item) => item.id === view)?.label}</strong>
                  <span>{catalog.data?.total ?? 0} 项</span>
                </header>
                {catalog.isLoading ? (
                  <CapabilitySkeleton />
                ) : items.length ? (
                  items.map((item) => (
                    <CapabilityRow
                      key={`${item.kind}:${item.id}`}
                      capability={item}
                      selected={selected?.id === item.id && selected.kind === item.kind}
                      onSelect={() => setSelected(item)}
                    />
                  ))
                ) : (
                  <EmptyState
                    title={query ? '没有匹配的能力' : '这里还没有能力'}
                    detail={
                      query
                        ? '换一个关键词或清除筛选条件。'
                        : '添加工具、MCP 或 Skill 后，可以在 Studio 中启用。'
                    }
                  />
                )}
              </section>
            </>
          )}
        </main>
      </div>
      {selected && <CapabilityDetail capability={selected} onClose={() => setSelected(null)} />}
      {addMode && (
        <AddCapabilitySheet mode={addMode} onMode={setAddMode} onClose={() => setAddMode(null)} />
      )}
    </section>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="capability-empty-v2">
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}
function CapabilitySkeleton() {
  return (
    <div aria-label="正在加载能力">
      {[0, 1, 2, 3].map((item) => (
        <div className="capability-row skeleton" key={item} />
      ))}
    </div>
  );
}

function AddCapabilitySheet({
  mode,
  onMode,
  onClose,
}: {
  mode: Exclude<AddMode, null>;
  onMode: (mode: AddMode) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const createMcp = useCreateMcpServer();
  const discoverMcp = useDiscoverMcpServer();
  const createTool = useCreateToolDraft();
  const createSkill = useCreateSkillDraft();
  const [mcp, setMcp] = useState({
    name: '',
    transport: 'streamable-http',
    endpoint: '',
    credential_ref: '',
  });
  const [tool, setTool] = useState({
    name: '',
    display_name: '',
    description: '',
    side_effect: 'none' as 'none' | 'read' | 'write' | 'destructive',
  });
  const [skill, setSkill] = useState({
    name: '',
    version: '1.0.0',
    description: '',
    content: '',
    dependencies: '',
  });
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  async function submitMcp(event: React.FormEvent) {
    event.preventDefault();
    const created = await createMcp.mutateAsync({
      name: mcp.name,
      transport: mcp.transport,
      endpoint: mcp.endpoint,
      url: mcp.endpoint,
      command: mcp.endpoint,
      credential_ref: mcp.credential_ref || undefined,
    });
    try {
      await discoverMcp.mutateAsync(created.id);
      setNotice('连接成功，发现结果已保存为草稿。');
    } catch {
      setNotice('连接已保存；能力发现暂未完成，可稍后重试。');
    }
    await client.invalidateQueries({ queryKey: ['capability-catalog'] });
    await client.invalidateQueries({ queryKey: ['mcp-servers'] });
  }
  async function submitTool(event: React.FormEvent) {
    event.preventDefault();
    await createTool.mutateAsync(tool);
    await client.invalidateQueries({ queryKey: ['capability-catalog'] });
    setNotice('工具草稿已创建。完成隔离测试和审批后才能被 Agent 使用。');
  }
  async function submitSkill(event: React.FormEvent) {
    event.preventDefault();
    await createSkill.mutateAsync({
      name: skill.name,
      version: skill.version,
      description: skill.description,
      content: skill.content,
      tool_dependencies: skill.dependencies
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    });
    await client.invalidateQueries({ queryKey: ['capability-catalog'] });
    await client.invalidateQueries({ queryKey: ['skills'] });
    setNotice('Skill 草稿已导入。依赖检查和审批通过后才能添加到生产 Agent。');
  }
  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div
        className="capability-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="添加能力"
      >
        <header>
          <div>
            <p className="product-kicker">Workspace capability</p>
            <h2>
              {mode === 'choose'
                ? '添加能力'
                : mode === 'mcp'
                  ? '连接 MCP'
                  : mode === 'tool'
                    ? '创建工具草稿'
                    : '导入 Skill 草稿'}
            </h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {notice ? (
          <div className="state-panel">
            <strong>{notice}</strong>
            <button className="button button-primary" onClick={onClose}>
              完成
            </button>
          </div>
        ) : mode === 'choose' ? (
          <div className="add-capability-options">
            <button onClick={() => onMode('mcp')}>
              <strong>连接 MCP</strong>
              <span>连接外部工具、资源和 Prompt</span>
            </button>
            <button onClick={() => onMode('tool')}>
              <strong>创建工具草稿</strong>
              <span>描述一个动作并进入测试与审批</span>
            </button>
            <button onClick={() => onMode('skill')}>
              <strong>导入 Skill</strong>
              <span>添加方法、参考资料和依赖声明</span>
            </button>
          </div>
        ) : mode === 'mcp' ? (
          <form onSubmit={submitMcp} className="capability-form">
            <label>
              连接名称
              <input
                required
                value={mcp.name}
                onChange={(event) => setMcp({ ...mcp, name: event.target.value })}
                placeholder="例如：企业搜索"
              />
            </label>
            <label>
              连接方式
              <select
                value={mcp.transport}
                onChange={(event) => setMcp({ ...mcp, transport: event.target.value })}
              >
                <option value="streamable-http">Streamable HTTP</option>
                <option value="stdio">stdio（高级）</option>
              </select>
            </label>
            <label>
              {mcp.transport === 'stdio' ? '启动命令' : 'Server URL'}
              <input
                required
                value={mcp.endpoint}
                onChange={(event) => setMcp({ ...mcp, endpoint: event.target.value })}
                placeholder={
                  mcp.transport === 'stdio' ? 'npx @example/mcp-server' : 'https://example.com/mcp'
                }
              />
            </label>
            <label>
              凭据引用（可选）
              <input
                value={mcp.credential_ref}
                onChange={(event) => setMcp({ ...mcp, credential_ref: event.target.value })}
                placeholder="由服务端 Vault/KMS 提供"
              />
              <small>不会把密钥发送到浏览器。</small>
            </label>
            <SheetActions
              pending={createMcp.isPending || discoverMcp.isPending}
              onBack={() => onMode('choose')}
              label="保存并发现能力"
            />
          </form>
        ) : mode === 'tool' ? (
          <form onSubmit={submitTool} className="capability-form">
            <label>
              工具标识
              <input
                required
                value={tool.name}
                onChange={(event) => setTool({ ...tool, name: event.target.value })}
                placeholder="例如：project_search"
              />
            </label>
            <label>
              展示名称
              <input
                required
                value={tool.display_name}
                onChange={(event) => setTool({ ...tool, display_name: event.target.value })}
                placeholder="例如：项目搜索"
              />
            </label>
            <label>
              它解决什么问题？
              <textarea
                required
                value={tool.description}
                onChange={(event) => setTool({ ...tool, description: event.target.value })}
                placeholder="说明输入、结果和使用场景"
              />
            </label>
            <label>
              副作用
              <select
                value={tool.side_effect}
                onChange={(event) =>
                  setTool({ ...tool, side_effect: event.target.value as typeof tool.side_effect })
                }
              >
                <option value="none">无副作用</option>
                <option value="read">读取数据</option>
                <option value="write">修改数据</option>
                <option value="destructive">高风险操作</option>
              </select>
            </label>
            <SheetActions
              pending={createTool.isPending}
              onBack={() => onMode('choose')}
              label="创建草稿"
            />
          </form>
        ) : (
          <form onSubmit={submitSkill} className="capability-form">
            <label>
              Skill 名称
              <input
                required
                value={skill.name}
                onChange={(event) => setSkill({ ...skill, name: event.target.value })}
                placeholder="例如：research-review"
              />
            </label>
            <label>
              版本
              <input
                required
                value={skill.version}
                onChange={(event) => setSkill({ ...skill, version: event.target.value })}
              />
            </label>
            <label>
              什么时候使用？
              <textarea
                required
                value={skill.description}
                onChange={(event) => setSkill({ ...skill, description: event.target.value })}
                placeholder="描述触发场景和预期结果"
              />
            </label>
            <label>
              Skill 指令
              <textarea
                required
                value={skill.content}
                onChange={(event) => setSkill({ ...skill, content: event.target.value })}
                placeholder="粘贴 SKILL.md 的核心内容"
              />
            </label>
            <label>
              工具依赖
              <input
                value={skill.dependencies}
                onChange={(event) => setSkill({ ...skill, dependencies: event.target.value })}
                placeholder="用逗号分隔，例如 search, read"
              />
            </label>
            <SheetActions
              pending={createSkill.isPending}
              onBack={() => onMode('choose')}
              label="导入草稿"
            />
          </form>
        )}
      </div>
    </div>
  );
}

function SheetActions({
  pending,
  onBack,
  label,
}: {
  pending: boolean;
  onBack: () => void;
  label: string;
}) {
  return (
    <footer>
      <button type="button" className="button button-quiet" onClick={onBack}>
        返回
      </button>
      <button className="button button-primary" disabled={pending}>
        {pending ? '处理中…' : label}
      </button>
    </footer>
  );
}
