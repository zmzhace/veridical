import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessions, useSpecs } from '../api/queries';
import { SessionList } from '../components/SessionList';

export function SessionsPage() {
  const { data, isLoading, error } = useSessions();
  const { data: specs } = useSpecs();
  const nav = useNavigate();
  const [showNew, setShowNew] = useState(false);
  const [specName, setSpecName] = useState('');

  const convs = useMemo(() => (data ?? []).filter((s) => s.session_id.startsWith('conv_')), [data]);
  const runs = useMemo(() => (data ?? []).filter((s) => !s.session_id.startsWith('conv_')), [data]);

  const openNew = () => {
    if (specs && specs.length > 0 && !specName) setSpecName((specs[0] as any).name);
    setShowNew(true);
  };

  if (isLoading) return <p className="text-[var(--muted)]">加载中…</p>;
  if (error) return <p className="text-red-600">加载会话失败。</p>;

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="page-title">对话</h2>
          <p className="page-desc">与 agent 连续对话，整段对话就是一条可逐帧回看的轨迹。</p>
        </div>
        <button className="btn btn-primary shrink-0" onClick={openNew}>＋ 新对话</button>
      </div>

      {convs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-[13px] font-semibold text-[var(--muted)] mb-2">对话</h3>
          <SessionList kind="conv" sessions={convs} onSelect={(id) => nav(`/sessions/${id}`)} />
        </div>
      )}
      {runs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-[13px] font-semibold text-[var(--muted)] mb-2">运行</h3>
          <SessionList kind="run" sessions={runs} onSelect={(id) => nav(`/sessions/${id}`)} />
        </div>
      )}

      {(convs.length === 0 && runs.length === 0) && (
        <div className="empty">
          <div className="empty-title">还没有任何对话</div>
          <div className="empty-desc">点「＋ 新对话」选择规格开始，或去「运行」页跑一个 agent。</div>
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowNew(false)}>
          <div className="card w-[28rem] max-w-[90vw] p-6 bg-white" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[15px] font-semibold mb-1">选择规格</h3>
            <p className="text-[12px] text-[var(--muted)] mb-4">新对话将使用选中的 agent 规格运行。</p>
            <label className="label">规格</label>
            <select className="field mb-3" value={specName} onChange={(e) => setSpecName(e.target.value)}>
              {(specs ?? []).map((s: any) => <option key={s.name + s.version} value={s.name}>{s.name}@{s.version}</option>)}
            </select>
            {/* mock-only：对话页固定走 mock 决策，live 卡禁用并指引到运行页 */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              <div className="card p-3 text-left border-[var(--accent)] ring-2 ring-[var(--accent-soft)]">
                <div className="text-[13px] font-semibold">模拟运行</div>
                <div className="text-[11px] text-[var(--muted)] mt-0.5">mock 决策，快且免费</div>
              </div>
              <div className="card p-3 text-left opacity-50" aria-disabled="true" title="真实模型请到运行页">
                <div className="text-[13px] font-semibold">接入真实模型</div>
                <div className="text-[11px] text-[var(--muted)] mt-0.5">真实模型请到运行页</div>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button className="btn btn-ghost" onClick={() => setShowNew(false)}>取消</button>
              <button className="btn btn-primary" disabled={!specName} onClick={() => nav(`/sessions/new?spec=${encodeURIComponent(specName)}&mode=mock`)}>开始对话</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
