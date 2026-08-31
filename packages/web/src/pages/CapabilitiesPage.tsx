import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateMcpServer, useDiscoverMcpServer, useMcpServers, useSkills, useTools } from '../api/queries';
import '../product.css';

export function CapabilitiesPage() {
  const tools = useTools();
  const skills = useSkills();
  const servers = useMcpServers();
  const create = useCreateMcpServer();
  const discover = useDiscoverMcpServer();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', transport: 'streamable-http', endpoint: '' });

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

  return <section className="capabilities-page">
    <header className="product-heading">
      <div><p className="product-kicker">Capability registry</p><h1>能力中心</h1><p>管理 Agent 可以使用的工具、MCP Server 和版本化 Skill。</p></div>
      <button className="button button-primary" onClick={() => setAdding(true)}>添加 MCP Server</button>
    </header>
    <div className="capability-metrics">
      <div><b>{tools.data?.length ?? 0}</b><span>工具</span></div>
      <div><b>{servers.data?.length ?? 0}</b><span>MCP Server</span></div>
      <div><b>{skills.data?.length ?? 0}</b><span>Skills</span></div>
    </div>
    <section className="capability-section">
      <header><div><p className="product-kicker">MCP servers</p><h2>外部能力</h2></div><span>发现后仍需审批才能进入生产</span></header>
      <div className="capability-list">
        {(servers.data ?? []).map((server) => <article key={server.id}>
          <div className="capability-icon">M</div>
          <div className="capability-copy"><strong>{server.name}</strong><span>{server.transport === 'stdio' ? server.command : server.url}</span><small>{server.discovered_tools.length} 个工具 · {server.status === 'approved' ? '已审批' : '草稿'}</small>{server.last_error && <em>{server.last_error}</em>}</div>
          <button className="button button-quiet" disabled={discover.isPending} onClick={() => discoverServer(server.id)}>发现能力</button>
        </article>)}
        {!servers.data?.length && <div className="context-empty">还没有 MCP Server。添加后可发现其工具、资源与 Prompt。</div>}
      </div>
    </section>
    <section className="capability-section">
      <header><div><p className="product-kicker">Tools</p><h2>工具目录</h2></div></header>
      <div className="capability-list">
        {(tools.data ?? []).map((tool) => <article key={tool.id}><div className="capability-icon">T</div><div className="capability-copy"><strong>{tool.name}</strong><span>{tool.description}</span><small>{tool.source} · v{tool.version} · {tool.side_effect} · {tool.status}</small></div></article>)}
      </div>
    </section>
    <section className="capability-section">
      <header><div><p className="product-kicker">Skills</p><h2>方法与指令</h2></div></header>
      <div className="capability-list">
        {(skills.data ?? []).map((skill) => <article key={skill.key}><div className="capability-icon">S</div><div className="capability-copy"><strong>{skill.name}</strong><span>{skill.description || '版本化行为指引'}</span><small>{skill.source}</small></div></article>)}
        {!skills.data?.length && <div className="context-empty">尚未导入 Skill。</div>}
      </div>
    </section>
    {adding && <div className="sheet-backdrop" onMouseDown={() => setAdding(false)}><form className="product-sheet" onSubmit={addServer} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><p className="product-kicker">New MCP server</p><h2>连接 MCP Server</h2></div><button type="button" className="icon-button" onClick={() => setAdding(false)}>×</button></header>
      <label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：企业搜索" /></label>
      <label>传输方式<select value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value })}><option value="streamable-http">Streamable HTTP</option><option value="stdio">stdio</option></select></label>
      <label>{form.transport === 'stdio' ? '启动命令' : 'Server URL'}<input required value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} placeholder={form.transport === 'stdio' ? 'npx @example/mcp-server' : 'https://example.com/mcp'} /></label>
      {(create.error || discover.error) && <p className="form-error">{String(create.error ?? discover.error)}</p>}
      <footer><button type="button" className="button button-quiet" onClick={() => setAdding(false)}>取消</button><button className="button button-primary" disabled={create.isPending}>保存连接</button></footer>
    </form></div>}
  </section>;
}
