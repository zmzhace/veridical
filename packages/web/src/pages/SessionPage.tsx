import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSession, useReplay, useCheckpoints } from '../api/queries';
import { ChatBubble } from '../components/ChatBubble';
import { ChatInput } from '../components/ChatInput';
import { TraceTimeline } from '../components/TraceTimeline';
import { EventDetail } from '../components/EventDetail';
import { ReplayControls } from '../components/ReplayControls';
import { eventMeta, toolHuman, sessionHuman, stageHuman } from '../lib/events';
import type { TraceEvent } from '@veridical/schema';

interface ChatItem {
  kind: 'bubble' | 'stage';
  role?: 'user' | 'assistant';
  event: TraceEvent;
  tools: TraceEvent[];
  checkpoints: TraceEvent[];
}

const textOf = (e: TraceEvent) => {
  const t = (e.payload as any)?.text;
  return typeof t === 'string' ? t : '';
};

function buildChat(events: TraceEvent[], checkpoints: TraceEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const seen = new Set<string>();
  let lastAi: ChatItem | null = null;
  const extra: TraceEvent[] = [];
  for (const cp of checkpoints) {
    if (!seen.has(cp.id)) {
      seen.add(cp.id);
      extra.push(cp);
    }
  }
  for (const e of events) {
    if (e.type === 'user.message' || e.type === 'assistant.message') {
      lastAi = { kind: 'bubble', role: e.type === 'user.message' ? 'user' : 'assistant', event: e, tools: [], checkpoints: [] };
      items.push(lastAi);
    } else if ((e.type === 'tool.called' || e.type === 'tool.result') && lastAi?.role === 'assistant') {
      lastAi.tools.push(e);
    } else if (e.type === 'state.checkpoint') {
      seen.add(e.id);
      if (lastAi?.role === 'assistant') lastAi.checkpoints.push(e);
    } else if (e.type === 'stage/start' || e.type === 'stage/end') {
      items.push({ kind: 'stage', event: e, tools: [], checkpoints: [] });
    }
  }
  for (const cp of extra) {
    let best: ChatItem | null = null;
    for (const it of items) {
      if (it.kind === 'bubble' && it.role === 'assistant' && it.event.seq <= cp.seq) best = it;
    }
    if (best) best.checkpoints.push(cp);
  }
  return items;
}

export function SessionPage() {
  const { id = '' } = useParams();
  const { data, isLoading } = useSession(id);
  const cps = useCheckpoints(id);
  const [view, setView] = useState<'chat' | 'timeline'>('chat');
  const [seq, setSeq] = useState(0);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const [note, setNote] = useState('');
  const replay = useReplay(id, seq);

  const events = data ?? [];
  const maxSeq = events.length;
  const shown = seq > 0 && replay.data ? replay.data.events : events;
  const items = useMemo(() => buildChat(events, cps.data ?? []), [events, cps.data]);

  if (isLoading) return <p className="text-[var(--muted)]">加载中…</p>;
  return (
    <div className="relative">
      <div className="mb-4">
        <h2 className="page-title">{sessionHuman(id)}</h2>
        <p className="page-desc mono text-[12px]">{id} · {view === 'chat' ? '对话视图' : '点击任意事件查看详情'}</p>
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex gap-1 bg-[#f1efe9] rounded-lg p-1">
          <button className={`btn ${view === 'chat' ? 'btn-primary' : 'btn-ghost'} px-3 py-1.5 text-[13px]`} onClick={() => setView('chat')}>对话</button>
          <button className={`btn ${view === 'timeline' ? 'btn-primary' : 'btn-ghost'} px-3 py-1.5 text-[13px]`} onClick={() => setView('timeline')}>时间线</button>
        </div>
        <div className="flex items-center gap-2" title="逐步执行请到运行页发起，此处仅作状态展示">
          <button className="btn btn-ghost px-3 py-1.5 text-[13px]" disabled>▶ 继续</button>
          <button className="btn btn-ghost px-3 py-1.5 text-[13px]" disabled>⏸</button>
          <button className="btn btn-ghost px-3 py-1.5 text-[13px]" disabled>⏹</button>
        </div>
      </div>

      {view === 'chat' ? (
        <div className="h-[calc(100vh-15rem)] flex flex-col rounded-2xl border border-[var(--line)] bg-white overflow-hidden">
          <div className="flex-1 min-h-0 overflow-auto p-6">
            {items.length ? (
              <div className="space-y-4">
                {items.map((it, i) => {
                  if (it.kind === 'stage') {
                    const meta = eventMeta(it.event);
                    return (
                      <div key={it.event.id ?? i} className="flex justify-center">
                        <button onClick={() => setSelected(it.event)} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-[#EDE9FE] text-[#4338CA] border border-[#C7D2FE] hover:bg-[#DDD6FE] transition-colors">
                          {meta.icon} {it.event.type === 'stage/start' ? '进入阶段' : '结束阶段'} · {stageHuman(String((it.event.payload as any)?.stage ?? ''))}
                        </button>
                      </div>
                    );
                  }
                  if (it.role === 'user') {
                    return <ChatBubble key={it.event.id ?? i} role="user" content={textOf(it.event)} />;
                  }
                  return (
                    <div key={it.event.id ?? i} className="space-y-1.5">
                      <ChatBubble role="assistant" content={textOf(it.event)}>
                        {it.tools.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {it.tools.map((t) => (
                              <button key={t.id} onClick={() => setSelected(t)}
                                className="text-[11px] px-2 py-0.5 rounded-full border bg-white text-[#44403C] border-[#E7E5E4] hover:border-[#4338CA] hover:text-[#4338CA] transition-colors">
                                ⚙ {toolHuman(String((t.payload as any)?.name ?? ''))}{t.type === 'tool.result' ? ' ✓' : ''}
                              </button>
                            ))}
                          </div>
                        )}
                      </ChatBubble>
                      {it.checkpoints.length > 0 && (
                        <div className="flex flex-wrap gap-2 pl-11">
                          {it.checkpoints.map((cp) => (
                            <button key={cp.id} onClick={() => setSelected(cp)}
                              className="text-[11px] px-2 py-0.5 rounded-full border border-[#C7D2FE] bg-[#EEF2FF] text-[#3730A3] hover:bg-[#E0E7FF] transition-colors">
                              ↺ 回看
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center">
                <div className="empty"><div className="empty-title">该会话没有对话内容</div><div className="empty-desc">切换到时间线视图查看事件轨迹。</div></div>
              </div>
            )}
          </div>
          {note && <div className="px-4 pt-2 text-[12px] text-[#4338CA]">{note}</div>}
          <ChatInput onSend={() => setNote('请到运行页发起逐步执行。')} placeholder="发送新消息（逐步执行请到运行页）" />
        </div>
      ) : (
        <div>
          <ReplayControls maxSeq={maxSeq} value={seq} onScrub={setSeq} />
          {shown.length ? <TraceTimeline events={shown} onSelect={setSelected} /> : <div className="empty"><div className="empty-title">该会话没有事件</div></div>}
        </div>
      )}

      {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}