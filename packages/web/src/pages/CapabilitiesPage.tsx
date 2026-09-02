import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  useCreateMcpServer,
  useCredentialStatus,
  useDiscoverMcpServer,
  useMcpServers,
  useModels,
  useKnowledgeBackends,
  useSkills,
  useTools,
} from '../api/queries';
import '../product.css';

type CapabilityView = 'overview' | 'models' | 'tools' | 'mcp' | 'skills' | 'knowledge';

const views: Array<{ id: CapabilityView; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'models', label: '模型' },
  { id: 'tools', label: '工具' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'knowledge', label: '知识' },
];

const sideEffectLabel = {
  none: '无副作用',
  read: '只读',
  write: '可写入',
  destructive: '高风险',
} as const;

const statusLabel: Record<string, string> = {
  approved: '已批准',
  configured: '已连接',
  draft: '草稿',
  deprecated: '已弃用',
  revoked: '已撤销',
};

function CapabilityGlyph({ kind }: { kind: 'model' | 'tool' | 'mcp' | 'skill' | 'context' }) {
  const paths = {
    model: <><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8 9h8M8 13h5" /></>,
    tool: <><path d="m14.5 5.5 4 4-8.7 8.7a2.8 2.8 0 0 1-4-4Z" /><path d="m12.5 7.5 4 4" /></>,
    mcp: <><circle cx="7" cy="12" r="3" /><circle cx="17" cy="7" r="3" /><circle cx="17" cy="17" r="3" /><path d="m9.7 10.7 4.6-2.4M9.7 13.3l4.6 2.4" /></>,
    skill: <><path d="M12 3v18M5 8h14M5 16h14" /><circle cx="12" cy="8" r="2.5" /><circle cx="12" cy="16" r="2.5" /></>,
    context: <><path d="M5 5h14v14H5z" /><path d="M8 9h8M8 13h6" /></>,
  };
  return <span className={`capability-glyph is-${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg></span>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`capability-status is-${status}`}>{statusLabel[status] ?? status}</span>;
}

export function CapabilitiesPage() {
  const tools = useTools();
  const skills = useSkills();
  const servers = useMcpServers();
  const models = useModels();
  const knowledge = useKnowledgeBackends();
  const credentials = useCredentialStatus();
  const create = useCreateMcpServer();
  const discover = useDiscoverMcpServer();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<CapabilityView>('overview');
  const [query, setQuery] = useState('');
  const [form, setForm] = useState({ name: '', transport: 'streamable-http', endpoint: '' });

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTools = useMemo(
    () => (tools.data ?? []).filter((tool) => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(normalizedQuery)),
    [normalizedQuery, tools.data],
  );
  const visibleSkills = useMemo(
    () => (skills.data ?? []).filter((skill) => `${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLocaleLowerCase().includes(normalizedQuery)),
    [normalizedQuery, skills.data],
  );
  const visibleServers = useMemo(
    () => (servers.data ?? []).filter((server) => server.name.toLocaleLowerCase().includes(normalizedQuery)),
    [normalizedQuery, servers.data],
  );
  const configuredModel = models.data?.[0];

  async function addServer(event: React.FormEvent) {
    event.preventDefault();
    await create.mutateAsync(form.transport === 'streamable-http'
      ? { name: form.name, transport: form.transport, url: form.endpoint }
      : { name: form.name, transport: form.transport, command: form.endpoint });
    setAdding(false);
    setForm({ name: '', transport: 'streamable-http', endpoint: '' });
    await client.invalidateQueries({ queryKey: ['mcp-servers'] });
  }

  async function discoverServer(id: string) {
    await discover.mutateAsync(id);
    await client.invalidateQueries({ queryKey: ['mcp-servers'] });
  }

  const show = (target: CapabilityView) => view === 'overview' || view === target;

  return <section className="capabilities-page">
    <header className="capability-heading">
      <div>
        <p className="product-kicker">Workspace capabilities</p>
        <h1>能力库</h1>
        <p>统一管理模型、工具、MCP 和 Skills，再按需装配给 Agent。</p>
      </div>
      <button className="button button-primary" onClick={() => setAdding(true)}>连接 MCP</button>
    </header>

    <div className="capability-guide">
      <div>
        <span className="capability-guide-index">01</span>
        <strong>在这里接入能力</strong>
        <p>连接、发现并确认它能访问的数据范围。</p>
      </div>
      <div>
        <span className="capability-guide-index">02</span>
        <strong>在 Studio 中装配</strong>
        <p>每个 Agent 只获得明确绑定的能力。</p>
      </div>
      <Link to="/agents">选择 Agent <span aria-hidden="true">→</span></Link>
    </div>

    <div className="capability-toolbar">
      <div className="capability-tabs" role="tablist" aria-label="能力类型">
        {views.map((item) => <button key={item.id} role="tab" aria-selected={view === item.id} onClick={() => setView(item.id)}>{item.label}<span>{item.id === 'models' ? models.data?.length ?? 0 : item.id === 'tools' ? tools.data?.length ?? 0 : item.id === 'mcp' ? servers.data?.length ?? 0 : item.id === 'skills' ? skills.data?.length ?? 0 : item.id === 'knowledge' ? knowledge.data?.length ?? 0 : ''}</span></button>)}
      </div>
      {view !== 'models' && <label className="capability-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
        <span className="sr-only">搜索能力</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或用途" />
      </label>}
    </div>

    {show('models') && <section className="capability-collection" aria-labelledby="models-heading">
      <header>
        <div><h2 id="models-heading">模型连接</h2><p>凭据由服务端托管，不会写入 Agent 配置或发送到浏览器。</p></div>
        <span>{credentials.data?.provider.configured ? '服务可用' : '等待配置'}</span>
      </header>
      {configuredModel ? <article className="capability-feature-row">
        <CapabilityGlyph kind="model" />
        <div className="capability-resource-copy"><strong>{configuredModel.model}</strong><p>{configuredModel.provider} · 当前工作区默认模型</p></div>
        <div className="capability-resource-meta"><StatusBadge status={configuredModel.status} /><small>凭据已托管</small></div>
      </article> : <div className="capability-empty"><CapabilityGlyph kind="model" /><div><strong>还没有可用模型</strong><p>在服务端环境中配置 Provider 后，这里会自动出现，不需要再次填写密钥。</p></div></div>}
    </section>}

    {show('knowledge') && <section className="capability-collection" aria-labelledby="knowledge-heading">
      <header><div><h2 id="knowledge-heading">知识 Backend</h2><p>统一检索、证据、缺口和记忆；Agent 只访问已绑定的知识范围。</p></div><span>{knowledge.data?.length ?? 0} 个 Backend</span></header>
      <div className="capability-resource-list">{(knowledge.data ?? []).map((backend) => <article className="capability-resource-row" key={backend.id}><CapabilityGlyph kind="context" /><div className="capability-resource-copy"><strong>{backend.name}</strong><p>{backend.type === 'gbrain' ? 'GBrain MCP · 外部知识脑' : backend.type === 'hybrid' ? 'Native + GBrain · 混合检索' : 'Native · 本地可回放索引'}</p><small>{(backend.capabilities ?? []).join(' · ') || '默认项目知识能力'}</small></div><div className="capability-resource-meta"><StatusBadge status={backend.status} /></div></article>)}</div>
    </section>}

    {show('mcp') && <section className="capability-collection" aria-labelledby="mcp-heading">
      <header>
        <div><h2 id="mcp-heading">MCP 连接</h2><p>从外部服务发现工具、资源和 Prompt；发布前仍需审批。</p></div>
        <span>{servers.data?.length ?? 0} 个连接</span>
      </header>
      <div className="capability-resource-list">
        {visibleServers.map((server) => <article className="capability-resource-row" key={server.id}>
          <CapabilityGlyph kind="mcp" />
          <div className="capability-resource-copy"><strong>{server.name}</strong><p>{server.transport === 'stdio' ? server.command : server.url}</p><small>{server.discovered_tools.length} 个工具 · {server.discovered_resources.length} 个资源 · {server.discovered_prompts.length} 个 Prompt</small>{server.last_error && <em>{server.last_error}</em>}</div>
          <div className="capability-resource-meta"><StatusBadge status={server.status} /><button className="button button-quiet" disabled={discover.isPending} onClick={() => discoverServer(server.id)}>重新发现</button></div>
        </article>)}
        {!visibleServers.length && <div className="capability-empty"><CapabilityGlyph kind="mcp" /><div><strong>{normalizedQuery ? '没有匹配的 MCP 连接' : '连接第一个 MCP Server'}</strong><p>{normalizedQuery ? '换一个关键词，或清空搜索。' : '连接后可以发现它提供的工具、资源与 Prompt。'}</p>{!normalizedQuery && <button className="button button-quiet" onClick={() => setAdding(true)}>添加连接 <span aria-hidden="true">→</span></button>}</div></div>}
      </div>
    </section>}

    {show('tools') && <section className="capability-collection" aria-labelledby="tools-heading">
      <header>
        <div><h2 id="tools-heading">工具</h2><p>每项工具都声明副作用和版本；Agent 不会自动获得权限。</p></div>
        <span>{visibleTools.length} 项可用</span>
      </header>
      <div className="capability-resource-list is-grid">
        {visibleTools.map((tool) => <article className="capability-resource-row" key={tool.id}>
          <CapabilityGlyph kind="tool" />
          <div className="capability-resource-copy"><strong>{tool.name}</strong><p>{tool.description}</p><small>{tool.source === 'builtin' ? '内置' : tool.source.toUpperCase()} · v{tool.version} · {sideEffectLabel[tool.side_effect]}</small></div>
          <div className="capability-resource-meta"><StatusBadge status={tool.status} /></div>
        </article>)}
      </div>
      {!visibleTools.length && <div className="capability-empty"><CapabilityGlyph kind="tool" /><div><strong>没有匹配的工具</strong><p>换一个关键词，或清空搜索。</p></div></div>}
    </section>}

    {show('skills') && <section className="capability-collection" aria-labelledby="skills-heading">
      <header>
        <div><h2 id="skills-heading">Skills</h2><p>版本化的方法、指令和资源；Skill 本身不会授予工具权限。</p></div>
        <span>{visibleSkills.length} 项已导入</span>
      </header>
      <div className="capability-resource-list">
        {visibleSkills.map((skill) => <article className="capability-resource-row" key={skill.key}>
          <CapabilityGlyph kind="skill" />
          <div className="capability-resource-copy"><strong>{skill.name}</strong><p>{skill.description || '版本化行为指引'}</p><small>{skill.source}{skill.tags.length ? ` · ${skill.tags.join(' · ')}` : ''}</small></div>
          <div className="capability-resource-meta"><StatusBadge status="approved" /></div>
        </article>)}
        {!visibleSkills.length && <div className="capability-empty"><CapabilityGlyph kind="skill" /><div><strong>{normalizedQuery ? '没有匹配的 Skill' : '还没有导入 Skill'}</strong><p>{normalizedQuery ? '换一个关键词，或清空搜索。' : 'Skill 将指令、参考资料和脚本固定为可追溯版本，之后可以在 Studio 中绑定。'}</p></div></div>}
      </div>
    </section>}

    {view === 'overview' && <Link className="capability-context-link" to="/context"><CapabilityGlyph kind="context" /><span><strong>记忆与项目知识</strong><small>管理 Agent 可以读取的记忆、文件和来源</small></span><span aria-hidden="true">→</span></Link>}

    {adding && <div className="sheet-backdrop" onMouseDown={() => setAdding(false)}><form className="product-sheet" onSubmit={addServer} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><p className="product-kicker">MCP connection</p><h2>连接 MCP Server</h2><p>保存后先执行能力发现，不会自动授予生产权限。</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setAdding(false)}>×</button></header>
      <label>连接名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：企业搜索" /></label>
      <label>连接方式<select value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value })}><option value="streamable-http">Streamable HTTP</option><option value="stdio">stdio（本地进程）</option></select></label>
      <label>{form.transport === 'stdio' ? '启动命令' : 'Server URL'}<input required value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} placeholder={form.transport === 'stdio' ? 'npx @example/mcp-server' : 'https://example.com/mcp'} /></label>
      {(create.error || discover.error) && <p className="form-error">{String(create.error ?? discover.error)}</p>}
      <footer><button type="button" className="button button-quiet" onClick={() => setAdding(false)}>取消</button><button className="button button-primary" disabled={create.isPending}>{create.isPending ? '正在连接…' : '保存并连接'}</button></footer>
    </form></div>}
  </section>;
}
