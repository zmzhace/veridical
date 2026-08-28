import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReplayExecution, useSession, useSessions } from '../api/queries';
import { sessionHuman } from '../lib/events';
import { TraceTimeline } from '../components/TraceTimeline';

const modes = [
  { id: 'strict', title: '严格回放', note: '验证每一次调用是否都能原样重建。', icon: '01' },
  { id: 'fixture', title: '固定数据回放', note: '外部服务不可用时，使用已保存的结果。', icon: '02' },
  { id: 'semantic', title: '行为回放', note: '允许路径变化，只验证最终行为是否达标。', icon: '03' },
] as const;

export function ReplayPage() {
  const [params] = useSearchParams(); const { data: sessions = [] } = useSessions();
  const [id, setId] = useState(params.get('session') ?? ''); const [mode, setMode] = useState<(typeof modes)[number]['id']>('strict'); const [seq, setSeq] = useState(Number(params.get('seq') ?? 0));
  const session = useSession(id); const replay = useReplayExecution(); const maxSeq = session.data?.reduce((m, e) => Math.max(m, e.seq), 0) ?? 0; const target = seq || maxSeq;
  return <div className="replay-page"><header className="replay-header"><div><div className="eyebrow">RUN ANALYSIS / 回放工作台</div><h1 className="page-title">把一次运行，重新走一遍</h1><p className="page-desc">这里专门做重建和核对。时间线只看事实，回放在这里执行。</p></div><div className="replay-header-mark"><span>RE</span><small>REPLAY<br/>ENGINE</small></div></header>
    <section className="replay-step card"><div className="replay-step-head"><span className="replay-step-number">1</span><div><h2>选择一次运行</h2><p>从已有的完整轨迹开始，不会重新调用线上模型。</p></div></div><select aria-label="选择源运行" className="field replay-session-select" value={id} onChange={e=>{setId(e.target.value);setSeq(0)}}><option value="">请选择一条运行…</option>{sessions.map(s=><option key={s.session_id} value={s.session_id}>{sessionHuman(s.session_id)} · {s.spec_name ?? '未命名'} · {s.event_count} 个事件</option>)}</select></section>
    <section className="replay-step card"><div className="replay-step-head"><span className="replay-step-number">2</span><div><h2>选择回放方式</h2><p>不同方式代表不同的“相同”：严格一致，或行为一致。</p></div></div><div className="replay-mode-grid">{modes.map(m=><button type="button" key={m.id} className={`replay-mode ${mode===m.id?'is-selected':''}`} onClick={()=>setMode(m.id)}><span className="replay-mode-icon">{m.icon}</span><span><strong>{m.title}</strong><small>{m.note}</small></span>{mode===m.id&&<i>✓</i>}</button>)}</div></section>
    <section className="replay-step card"><div className="replay-step-head"><span className="replay-step-number">3</span><div><h2>执行并查看结果</h2><p>可以先拖到某个事件截面，快速定位分叉点。</p></div></div><div className="replay-execute-row"><label className="replay-scrub-label">查看到第 <strong>#{target || '—'}</strong> 个事件<input aria-label="事件截面" className="replay-range" type="range" min="0" max={maxSeq||1} value={Math.min(target,maxSeq||1)} onChange={e=>setSeq(Number(e.target.value))} disabled={!id||!maxSeq}/></label><button className="btn btn-primary replay-run" disabled={!id||replay.isPending} onClick={()=>replay.mutate({id,body:{mode,...(mode==='semantic'?{semantic:{}}:{})}})}>{replay.isPending?'正在重建…':'开始回放'}</button></div></section>
    {replay.isError&&<div className="replay-result replay-error"><strong>回放没有完成</strong><span>{(replay.error as Error).message}</span></div>}{replay.data&&<div className={`replay-result ${replay.data.identical?'is-good':'is-warn'}`}><strong>{replay.data.identical?'严格一致':replay.data.passed?'行为通过，但路径不同':'回放完成，需要人工审阅'}</strong><span className="mono">{replay.data.mode}</span>{replay.data.degraded&&<span>已降级</span>}</div>}
    <section className="replay-output"><div className="replay-output-head"><div><div className="section-kicker">CALL GRAPH / 调用路径</div><h2>{id ? sessionHuman(id) : '等待选择运行'}</h2></div>{session.data&&<div className="replay-stats"><span><b>{session.data.length}</b>事件</span><span><b>{session.data.filter(e=>e.type==='invocation.start').length}</b>调用</span></div>}</div>{session.data?<TraceTimeline events={session.data.filter(e=>e.seq<=target)} onSelect={()=>{}}/>:<div className="replay-empty"><span>↳</span><p>选择运行后，这里会显示主 Agent、子 Agent、模型和工具的完整调用路径。</p></div>}</section>
  </div>;
}
