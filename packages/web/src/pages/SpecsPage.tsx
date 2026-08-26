import { useState } from 'react';
import { useSpecs } from '../api/queries';
import { SpecForm } from '../components/SpecForm';
import { YAMLSpecForm } from '../components/YAMLSpecForm';

export function SpecsPage() {
  const { data, isLoading, refetch } = useSpecs();
  const [tab, setTab] = useState<'form' | 'yaml'>('form');

  return (
    <div>
      <div className="mb-5"><h2 className="page-title">规格</h2><p className="page-desc">已注册的 agent 规格——定义人设、工具与流程。</p></div>
      <div className="flex gap-1 mb-4">
        <button className={`tab ${tab === 'form' ? 'tab-active' : ''}`} onClick={() => setTab('form')}>表单</button>
        <button className={`tab ${tab === 'yaml' ? 'tab-active' : ''}`} onClick={() => setTab('yaml')}>粘贴 YAML</button>
      </div>
      {tab === 'form'
        ? <SpecForm onSaved={() => refetch()} />
        : <YAMLSpecForm onSaved={() => refetch()} />}
      <h3 className="text-[13px] font-semibold text-[var(--muted)] mb-2">已注册规格</h3>
      {isLoading ? <p className="text-[var(--muted)]">加载中…</p> : data && data.length ? (
        <div className="space-y-2">
          {data.map((s: any) => (
            <div key={s.name + s.version} className="card px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{s.name}</span>
                <span className="badge badge-neutral mono">v{s.version}</span>
                {s.flow?.mode && <span className="badge badge-accent">{flowLabel(s.flow.mode)}</span>}
              </div>
              {s.description && <p className="text-[12px] text-[var(--muted)] mt-1">{s.description}</p>}
              <p className="text-[11px] text-[var(--muted)] mt-1 mono">
                {s.tools?.length ?? 0} 个工具 · {(s.agents ?? []).length} 个专家{(s.flow?.stages?.length ?? 0) ? ` · ${s.flow.stages.length} 个阶段` : ''}
              </p>
            </div>
          ))}
        </div>
      ) : <div className="empty"><div className="empty-title">暂无已注册规格</div><div className="empty-desc">规格在服务启动时从 specs 目录加载。</div></div>}
    </div>
  );
}

function flowLabel(mode: string): string {
  const m: Record<string, string> = { 'single-loop': '单循环', supervisor: '主管编排', 'stage-gate': '合规状态机' };
  return m[mode] ?? mode;
}