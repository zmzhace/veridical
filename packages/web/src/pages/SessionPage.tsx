import { useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession, useReplay, useCheckpoints, useStartTurn } from '../api/queries';
import type { TurnFrame } from '../api/types';
import { ChatBubble } from '../components/ChatBubble';
import { ChatInput } from '../components/ChatInput';
import { TraceTimeline } from '../components/TraceTimeline';
import { EventDetail } from '../components/EventDetail';
import { ReplayControls } from '../components/ReplayControls';
import { eventMeta, toolHuman, sessionHuman, stageHuman } from '../lib/events';
import type { TraceEvent } from '@veridical/schema';

export interface ChatItem {
  kind: 'bubble' | 'stage';
  role?: 'user' | 'assistant';
  event: TraceEvent;
  tools: TraceEvent[];
  checkpoints: TraceEvent[];
  turn?: number;
}

const textOf = (e: TraceEvent) => {
  const t = (e.payload as any)?.text;
  return typeof t === 'string' ? t : '';
};

// 工具胶囊行：assistant/user 气泡共用（tool-first 轮次的胶囊挂在 user 气泡上）
const ToolPills = ({ tools, onSelect }: { tools: TraceEvent[]; onSelect: (e: TraceEvent) => void }) => (
  <div className="flex flex-wrap gap-1.5 pt-1">
    {tools.map((t) => (
      <button key={t.id} onClick={() => onSelect(t)}
        className="text-[11px] px-2 py-0.5 rounded-full border bg-white text-[#44403C] border-[#E7E5E4] hover:border-[#4338CA] hover:text-[#4338CA] transition-colors">
        ⚙ {toolHuman(String((t.payload as any)?.name ?? ''))}{t.type === 'tool.result' ? (t.verb === 'error' ? ' ✕' : ' ✓') : ''}
      </button>
    ))}
  </div>
);

// 检查点"回看"锚点行：靠左（assistant 侧）或靠右（user 侧）
const CheckpointRow = ({ checkpoints, align, onSelect }: { checkpoints: TraceEvent[]; align: 'left' | 'right'; onSelect: (e: TraceEvent) => void }) => (
  <div className={`flex flex-wrap gap-2 ${align === 'left' ? 'pl-11' : 'pr-11 justify-end'}`}>
    {checkpoints.map((cp) => (
      <button key={cp.id} onClick={() => onSelect(cp)}
        className="text-[11px] px-2 py-0.5 rounded-full border border-[#C7D2FE] bg-[#EEF2FF] text-[#3730A3] hover:bg-[#E0E7FF] transition-colors">
        ↺ 回看
      </button>
    ))}
  </div>
);

export function buildChat(events: TraceEvent[], checkpoints: TraceEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const seen = new Set<string>();
  const pushed = new Set<string>();           // 已在 events 流里挂到某气泡的 cp id
  const extra: TraceEvent[] = [];
  for (const cp of checkpoints) { if (!seen.has(cp.id)) { seen.add(cp.id); extra.push(cp); } }

  let turn = -1;
  let bufTools: TraceEvent[] = [];
  let bufCps: TraceEvent[] = [];
  let lastAssistantInTurn: ChatItem | null = null;
  let userBubbleInTurn: ChatItem | null = null;
  const closeTurn = () => {
    // 轮末统一挂载：该轮最后一个 assistant 气泡；无 assistant 则挂该轮 user 气泡（仍无则不挂）——不跨轮
    const target = lastAssistantInTurn ?? userBubbleInTurn;
    if (target) {
      for (const t of bufTools) target.tools.push(t);
      for (const c of bufCps) { target.checkpoints.push(c); pushed.add(c.id); }
    }
    bufTools = []; bufCps = []; lastAssistantInTurn = null; userBubbleInTurn = null;
  };
  const openTurn = () => { turn += 1; closeTurn(); };
  openTurn(); // 默认 turn 0，兼容无 turn/start 的旧数据

  for (const e of events) {
    if (e.type === 'turn/start') { openTurn(); items.push({ kind: 'stage', event: e, tools: [], checkpoints: [], turn }); continue; }
    if (e.type === 'turn/end') { closeTurn(); items.push({ kind: 'stage', event: e, tools: [], checkpoints: [], turn }); continue; }
    if (e.type === 'user.message') {
      if (userBubbleInTurn) continue; // 同轮重复 user.message 只保留一条
      const b: ChatItem = { kind: 'bubble', role: 'user', event: e, tools: [], checkpoints: [], turn };
      userBubbleInTurn = b; items.push(b); continue;
    }
    if (e.type === 'assistant.message') {
      const b: ChatItem = { kind: 'bubble', role: 'assistant', event: e, tools: [], checkpoints: [], turn };
      lastAssistantInTurn = b; items.push(b); continue;
    }
    if (e.type === 'tool.called' || e.type === 'tool.result') { bufTools.push(e); continue; }
    if (e.type === 'state.checkpoint') { bufCps.push(e); continue; }
    if (e.type === 'stage/start' || e.type === 'stage/end') { items.push({ kind: 'stage', event: e, tools: [], checkpoints: [], turn }); continue; }
  }
  closeTurn();

  // 列表独有的 cp：未被 events 流挂载的，按"最近 assistant（seq<=cp.seq）"补挂（保留既有 test 语义）
  for (const cp of extra) {
    if (pushed.has(cp.id)) continue;
    let best: ChatItem | null = null;
    for (const it of items) if (it.kind === 'bubble' && it.role === 'assistant' && it.event.seq <= cp.seq) best = it;
    if (best) { best.checkpoints.push(cp); pushed.add(cp.id); }
  }
  return items;
}

export function SessionPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const isNew = id === 'new';
  // 只有新会话与对话（conv_*）允许继续发轮次；run_/step_ 轨迹会话禁止追加，保护 'conv_ 前缀 = 对话' 的分组不变量
  const canChat = isNew || id.startsWith('conv_');
  const newSpec = params.get('spec') ?? '';
  // 对话页 mock-only：旧链接里的 ?mode= 仍可安全打开，但一律按 mock 运行（真实模型请到运行页）
  const newMode = 'mock' as const;

  // isNew 时 id 传 '' → useSession/useCheckpoints/useReplay 的 enabled:!!id 为 false，不查询
  const { data, isLoading } = useSession(isNew ? '' : id);
  const cps = useCheckpoints(isNew ? '' : id);
  const [view, setView] = useState<'chat' | 'timeline'>('chat');
  const [seq, setSeq] = useState(0);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const replay = useReplay(isNew ? '' : id, seq);
  const { run: runTurn } = useStartTurn();

  // 非空会话：从首条 spec/run/start 事件取本次对话的 spec_name；否则用 ?spec= 参数
  const specName = useMemo(() => {
    if (isNew) return newSpec;
    const start = (data ?? []).find((e) => e.type === 'spec/run/start');
    return (start?.payload as any)?.spec_name ?? newSpec;
  }, [isNew, newSpec, data]);

  const [sending, setSending] = useState(false);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);
  const [liveText, setLiveText] = useState('');
  const [turnError, setTurnError] = useState('');
  const liveEventsRef = useRef<TraceEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  const events = data ?? [];
  const checkpoints = cps.data ?? [];
  const maxSeq = events.length;
  const shown = seq > 0 && replay.data ? replay.data.events : events;
  const merged = useMemo(() => [...events, ...liveEvents], [events, liveEvents]);
  const items = useMemo(() => buildChat(merged, checkpoints), [merged, checkpoints]);

  const scrollToBottom = () => {
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }));
  };

  async function onSend(prompt: string) {
    if (!canChat) return; // 纵深防御：非对话会话不允许发轮次（输入框也已禁用）
    if (sending || !prompt.trim()) return;
    setSending(true);
    setTurnError('');
    setLiveText('');
    setLiveEvents([]);
    liveEventsRef.current = [];
    let convId = isNew ? '' : id;
    try {
      await runTurn({ specName, prompt, mode: newMode, conversationId: convId || undefined }, (f: TurnFrame) => {
        if (f.type === 'token') { setLiveText((t) => t + (f.text ?? '')); scrollToBottom(); }
        else if (f.type === 'event') {
          // 按 id 去重：防 poll interval 与 done 前收尾 flush 竞态重复推送（M-3）
          if (liveEventsRef.current.some((x) => x.id === f.event.id)) return;
          // 累积事件（含 checkpoint/assistant.message）——既是流式渲染源，也是 done 后缓存种子
          const evs = [...liveEventsRef.current, f.event];
          liveEventsRef.current = evs;
          setLiveEvents(evs);
          scrollToBottom();
        }
        else if (f.type === 'done') { convId = f.session_id; }
        else if (f.type === 'error') {
          // error 帧若带 session_id 且尚未拿到（新会话首轮就失败），捕获之——
          // 避免 done 后 setQueryData(['session','']) 污染缓存（M-2）
          if (!convId && f.session_id) convId = f.session_id;
          setTurnError(f.message);
        }
      });
      // done 后把流式累积事件原子落进 react-query 缓存（setQueryData，不 refetch），并清空流式态
      const finalEvents = liveEventsRef.current;
      const newCps = finalEvents.filter((e) => e.type === 'state.checkpoint');
      qc.setQueryData(['session', convId], isNew ? finalEvents : [...events, ...finalEvents]);
      qc.setQueryData(['checkpoints', convId], isNew ? newCps : [...checkpoints, ...newCps]);
      setLiveEvents([]);
      liveEventsRef.current = [];
      if (convId && convId !== id) nav(`/sessions/${convId}`, { replace: true });
    } catch (e) {
      setTurnError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      setLiveText('');
    }
  }

  if (isLoading) return <p className="text-[var(--muted)]">加载中…</p>;
  return (
    <div className="relative">
      <div className="mb-4">
        <h2 className="page-title">{isNew ? newSpec : sessionHuman(id)}</h2>
        <p className="page-desc mono text-[12px]">{isNew ? '新对话' : `${id} · ${view === 'chat' ? '对话视图' : '点击任意事件查看详情'}`}</p>
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex gap-1 bg-[#f1efe9] rounded-lg p-1">
          <button className={`btn ${view === 'chat' ? 'btn-primary' : 'btn-ghost'} px-3 py-1.5 text-[13px]`} onClick={() => setView('chat')}>对话</button>
          <button className={`btn ${view === 'timeline' ? 'btn-primary' : 'btn-ghost'} px-3 py-1.5 text-[13px]`} onClick={() => setView('timeline')}>时间线</button>
        </div>
        <div className="flex items-center gap-2" title="逐步执行控制即将上线">
          <button className="btn btn-ghost px-3 py-1.5 text-[13px]" disabled>▶ 继续</button>
          <button className="btn btn-ghost px-3 py-1.5 text-[13px]" disabled>⏸</button>
          <button className="btn btn-ghost px-3 py-1.5 text-[13px]" disabled>⏹</button>
        </div>
      </div>

      {view === 'chat' ? (
        <div className="h-[calc(100vh-15rem)] flex flex-col rounded-2xl border border-[var(--line)] bg-white overflow-hidden">
          <div className="flex-1 min-h-0 overflow-auto p-6">
            {items.length || liveText ? (
              <div className="space-y-4">
                {items.map((it, i) => {
                  if (it.kind === 'stage') {
                    // 对话轮边界：turn/start 渲染为轮分隔条，turn/end 不渲染（下一条 turn/start 提供分隔）
                    if (it.event.type === 'turn/start') {
                      return (
                        <div key={it.event.id ?? i} className="flex justify-center">
                          <span className="text-[11px] text-[var(--muted)] px-2 py-0.5">— 新对话轮次 —</span>
                        </div>
                      );
                    }
                    if (it.event.type === 'turn/end') return null;
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
                    // tool-first 轮次（如 stage-gate）：本轮无 assistant 气泡，胶囊挂在 user 气泡上，也要渲染
                    if (!it.tools.length && !it.checkpoints.length) {
                      return <ChatBubble key={it.event.id ?? i} role="user" content={textOf(it.event)} />;
                    }
                    return (
                      <div key={it.event.id ?? i} className="space-y-1.5">
                        <ChatBubble role="user" content={textOf(it.event)}>
                          {it.tools.length > 0 && <ToolPills tools={it.tools} onSelect={setSelected} />}
                        </ChatBubble>
                        {it.checkpoints.length > 0 && <CheckpointRow checkpoints={it.checkpoints} align="right" onSelect={setSelected} />}
                      </div>
                    );
                  }
                  return (
                    <div key={it.event.id ?? i} className="space-y-1.5">
                      <ChatBubble role="assistant" content={textOf(it.event)}>
                        {it.tools.length > 0 && <ToolPills tools={it.tools} onSelect={setSelected} />}
                      </ChatBubble>
                      {it.checkpoints.length > 0 && <CheckpointRow checkpoints={it.checkpoints} align="left" onSelect={setSelected} />}
                    </div>
                  );
                })}
                {sending && liveText && (
                  <ChatBubble role="assistant" content={liveText} streaming />
                )}
                <div ref={bottomRef} />
              </div>
            ) : (
              <div className="h-full flex items-center justify-center">
                {isNew ? (
                  <div className="empty"><div className="empty-title">开始新对话</div><div className="empty-desc">输入消息即可运行，回复将实时流式显示在这里。</div></div>
                ) : (
                  <div className="empty"><div className="empty-title">该会话没有对话内容</div><div className="empty-desc">切换到时间线视图查看事件轨迹。</div></div>
                )}
              </div>
            )}
          </div>
          {turnError && <div className="mx-4 mt-2 px-3 py-2 rounded-lg text-[12px] bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]">本轮执行失败：{turnError}</div>}
          <ChatInput onSend={onSend} disabled={!canChat || sending} loading={sending} placeholder={canChat ? '输入消息…' : '单次运行轨迹不支持继续对话'} />
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