import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDeleteMemory, useDecideMemory, useKnowledgeFiles, useMemories } from '../api/queries';
import '../product.css';

export function ContextPage() {
  const [organization, setOrganization] = useState('local'); const [project, setProject] = useState('default');
  const memories = useMemories(organization, project); const files = useKnowledgeFiles(organization, project);
  const decide = useDecideMemory(); const remove = useDeleteMemory(); const client = useQueryClient();
  const active = useMemo(() => (memories.data ?? []).filter((item) => item.status === 'active'), [memories.data]);
  async function refresh() { await client.invalidateQueries({ queryKey: ['memories', organization, project] }); }
  return <section className="context-page">
    <header className="product-heading"><div><p className="product-kicker">Context</p><h1>记忆与知识</h1><p>管理 Agent 在当前项目中可以使用的记忆和文件。</p></div><div className="context-scope"><input aria-label="组织" value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="组织" /><input aria-label="项目" value={project} onChange={(e) => setProject(e.target.value)} placeholder="项目" /></div></header>
    <section className="capability-section"><header><div><p className="product-kicker">Memory</p><h2>已保存的记忆</h2></div><span>{active.length} 条有效记忆</span></header><div className="memory-list">
      {(memories.data ?? []).map((memory) => <article key={memory.id}><div className="memory-status">{memory.status === 'candidate' ? '?' : memory.status === 'active' ? '✓' : '×'}</div><div className="capability-copy"><strong>{memory.summary || String(memory.content).slice(0, 120)}</strong><span>{memory.scope} · {memory.kind} · {memory.sensitivity}</span><small>{memory.status} · {memory.content_hash.slice(0, 12)}</small></div><div className="memory-actions">{memory.status === 'candidate' && <><button className="button button-quiet" onClick={async () => { await decide.mutateAsync({ id: memory.id, status: 'rejected' }); await refresh(); }}>拒绝</button><button className="button button-primary" onClick={async () => { await decide.mutateAsync({ id: memory.id, status: 'active' }); await refresh(); }}>保存</button></>}<button className="button button-quiet" onClick={async () => { await remove.mutateAsync(memory.id); await refresh(); }}>删除</button></div></article>)}
      {!memories.data?.length && <div className="context-empty">这个项目还没有记忆。</div>}
    </div></section>
    <section className="capability-section"><header><div><p className="product-kicker">Knowledge</p><h2>项目文件</h2></div><span>{files.data?.length ?? 0} 个文件</span></header><div className="capability-list">{(files.data ?? []).map((file) => <article key={file.id}><div className="capability-icon">F</div><div className="capability-copy"><strong>{file.name}</strong><span>{file.mime_type} · {(file.size / 1024).toFixed(1)} KB</span><small>{file.status} · {file.content_hash.slice(0, 12)}</small></div></article>)}{!files.data?.length && <div className="context-empty">这个项目还没有知识文件。</div>}</div></section>
  </section>;
}
