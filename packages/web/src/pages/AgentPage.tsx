import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { TraceEvent } from '@veridical/schema';
import { useAgent, useAgentTasks, useSession, useStartTurn, useApprovals, useDecideApproval } from '../api/queries';
import type { TurnFrame } from '../api/types';
import { buildChat } from './SessionPage';
import { ChatBubble } from '../components/ChatBubble';
import { ChatInput } from '../components/ChatInput';
import { visibleStreamText } from '../components/MessageContent';
import { eventMeta } from '../lib/events';
import '../product.css';

const textOf = (event: TraceEvent) =>
  typeof (event.payload as { text?: unknown })?.text === 'string'
    ? String((event.payload as { text: string }).text)
    : '';

function activityCopy(event: TraceEvent) {
  if (event.type === 'state.checkpoint')
    return { label: '已保存进度', detail: '可以从这里恢复运行' };
  if (event.type === 'llm.request')
    return {
      label: '请求模型',
      detail: `${String((event.payload as any)?.model ?? '已配置模型')} · ${String((event.payload as any)?.messages?.length ?? 0)} 条消息`,
    };
  if (event.type === 'llm.response')
    return {
      label: '模型已返回',
      detail: event.tokens
        ? `${event.tokens.total} tokens · ${event.duration_ms}ms`
        : `${event.duration_ms}ms`,
    };
  if (event.type === 'tool.called')
    return { label: '调用工具', detail: String((event.payload as any)?.name ?? '工具') };
  if (event.type === 'tool.result')
    return {
      label: event.verb === 'error' ? '工具执行失败' : '工具执行完成',
      detail: String((event.payload as any)?.name ?? '结果已记录'),
    };
  if (event.type === 'agent.dispatch')
    return {
      label: '委派子 Agent',
      detail: String((event.payload as any)?.delegate ?? '子任务已创建'),
    };
  const meta = eventMeta(event);
  return { label: meta.label, detail: meta.desc(event) };
}

function formatDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}

export function AgentPage() {
  const { agentId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const agent = useAgent(agentId);
  const tasks = useAgentTasks(agentId);
  const taskId = params.get('task') ?? '';
  const session = useSession(taskId);
  const { run } = useStartTurn();
  const approvals = useApprovals();
  const decideApproval = useDecideApproval();
  const [sending, setSending] = useState(false);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);
  const liveRef = useRef<TraceEvent[]>([]);
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState('');
  const [rightOpen, setRightOpen] = useState(true);
  const [taskQuery, setTaskQuery] = useState('');
  const streamRef = useRef<HTMLElement>(null);
  const followOutput = useRef(true);
  const events = session.data ?? [];
  const visibleTasks = useMemo(
    () =>
      (tasks.data ?? []).filter((task) =>
        (task.first_message || '未命名任务').toLowerCase().includes(taskQuery.toLowerCase()),
      ),
    [tasks.data, taskQuery],
  );
  const merged = useMemo(() => [...events, ...liveEvents], [events, liveEvents]);
  const chat = useMemo(
    () => buildChat(merged, []).filter((item) => item.kind === 'bubble'),
    [merged],
  );
  const activities = merged
    .filter((event) =>
      [
        'llm.request',
        'llm.response',
        'tool.called',
        'tool.result',
        'agent.dispatch',
        'state.checkpoint',
      ].includes(event.type),
    )
    .slice(-8)
    .reverse();
  const hasFinalLiveMessage = liveEvents.some((event) => event.type === 'assistant.message');
  const visibleLiveText = useMemo(() => visibleStreamText(liveText), [liveText]);

  function scrollConversationToBottom(behavior: ScrollBehavior = 'auto') {
    const element = streamRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }

  useEffect(() => {
    followOutput.current = true;
    requestAnimationFrame(() => scrollConversationToBottom());
  }, [taskId, session.dataUpdatedAt]);

  useEffect(() => {
    if (!followOutput.current || (!sending && !liveEvents.length)) return;
    requestAnimationFrame(() => scrollConversationToBottom());
  }, [visibleLiveText, liveEvents.length, sending]);

  async function send(prompt: string) {
    if (!agent.data || sending) return;
    if (agent.data.status !== 'published') {
      navigate(`/agents/${agentId}/studio`);
      return;
    }
    setSending(true);
    setError('');
    setLiveText('');
    setLiveEvents([]);
    followOutput.current = true;
    liveRef.current = [];
    let currentTask = taskId;
    try {
      await run(
        {
          specName: agentId,
          conversationId: currentTask || undefined,
          prompt,
          mode: 'live',
          version: agent.data.version,
        },
        (frame: TurnFrame) => {
          if (frame.type === 'token') setLiveText((value) => value + frame.text);
          if (
            frame.type === 'event' &&
            !liveRef.current.some((event) => event.id === frame.event.id)
          ) {
            liveRef.current = [...liveRef.current, frame.event];
            setLiveEvents(liveRef.current);
          }
          if (frame.type === 'done' || frame.type === 'turn_end') currentTask = frame.session_id;
          if (frame.type === 'error') {
            setError(frame.message);
            if (frame.session_id) currentTask = frame.session_id;
          }
        },
      );
      const finalEvents = liveRef.current;
      client.setQueryData(
        ['session', currentTask],
        currentTask === taskId ? [...events, ...finalEvents] : finalEvents,
      );
      setLiveEvents([]);
      liveRef.current = [];
      setLiveText('');
      await client.invalidateQueries({ queryKey: ['agent-tasks', agentId] });
      if (currentTask && currentTask !== taskId)
        setParams({ task: currentTask }, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  if (agent.isLoading)
    return (
      <div className="agent-app-loading" role="status">
        正在打开 Agent…
      </div>
    );
  if (!agent.data)
    return (
      <div className="state-panel" role="alert">
        <strong>Agent 不存在</strong>
        <Link className="button" to="/agents">
          返回 Agents
        </Link>
      </div>
    );

  return (
    <div className={`agent-app${rightOpen ? '' : ' context-closed'}`}>
      <aside className="task-rail">
        <header>
          <Link to="/agents" className="back-link">
            ‹ Agents
          </Link>
          <h1>{agent.data.name}</h1>
          <span className={`status-label is-${agent.data.status}`}>
            {agent.data.status === 'published' ? `已发布 ${agent.data.version ?? ''}` : '草稿'}
          </span>
        </header>
        <button className="new-task-button" onClick={() => setParams({})}>
          ＋ 新建任务
        </button>
        <nav aria-label="任务列表">
          <div className="task-rail-heading">
            <p>最近任务</p>
            <span>{tasks.data?.length ?? 0}</span>
          </div>
          <label className="task-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="搜索任务"
              value={taskQuery}
              onChange={(event) => setTaskQuery(event.target.value)}
              placeholder="搜索任务"
            />
          </label>
          {visibleTasks.map((task) => (
            <button
              key={task.session_id}
              className={taskId === task.session_id ? 'is-active' : ''}
              title={`${task.first_message || '未命名任务'} · ${task.session_id}`}
              onClick={() => setParams({ task: task.session_id })}
            >
              <strong>{task.first_message || '未命名任务'}</strong>
              <small>
                {task.turn_count ?? 0} 轮 · {formatDuration(task.total_duration_ms)} · #{task.session_id.slice(-6)}
              </small>
            </button>
          ))}
          {!tasks.isLoading && !visibleTasks.length && (
            <span className="rail-empty">任务会在发送第一条消息后出现。</span>
          )}
        </nav>
        <footer>
          <Link to={`/agents/${agentId}/studio`}>编辑 Agent</Link>
          <span>
            {agent.data.model === 'server-default' ? '服务端模型已配置' : agent.data.model}
          </span>
        </footer>
      </aside>
      <main className="agent-conversation">
        <header className="conversation-header">
          <div>
            <h2>
              {taskId
                ? (tasks.data ?? []).find((task) => task.session_id === taskId)?.first_message ||
                  '任务'
                : '新任务'}
            </h2>
            <p>
              {sending
                ? 'Agent 正在工作'
                : taskId
                  ? `${chat.filter((item) => item.role === 'user').length} 轮对话`
                  : agent.data.description}
            </p>
          </div>
          <div>
            <button
              className="icon-button"
              aria-label="切换上下文面板"
              onClick={() => setRightOpen((value) => !value)}
            >
              ◫
            </button>
            {taskId && (
              <Link className="button button-quiet" to={`/tasks/${taskId}/trace`}>
                运行详情
              </Link>
            )}
          </div>
        </header>
        {approvals.data?.filter((item) => item.session_id === taskId).map((approval) => (
          <div className="approval-banner" key={approval.id} role="alert">
            <div><strong>需要确认：调用 {approval.tool}</strong><p>此操作可能产生 {approval.side_effect} 副作用。</p><pre>{JSON.stringify(approval.args, null, 2)}</pre></div>
            <div className="approval-actions"><button className="button button-quiet" onClick={() => decideApproval.mutate({ id: approval.id, decision: 'deny' })}>拒绝</button><button className="button button-primary" onClick={() => decideApproval.mutate({ id: approval.id, decision: 'allow' })}>允许一次</button></div>
          </div>
        ))}
        <section
          className="conversation-stream"
          aria-live="polite"
          ref={streamRef}
          onScroll={() => {
            const element = streamRef.current;
            if (element)
              followOutput.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 72;
          }}
        >
          {session.isLoading ? (
            <div className="conversation-placeholder">正在读取任务…</div>
          ) : chat.length || visibleLiveText ? (
            <div className="message-column">
              {chat.map((item) => (
                <ChatBubble key={item.event.id} role={item.role!} content={textOf(item.event)} />
              ))}
              {sending && visibleLiveText && !hasFinalLiveMessage && (
                <ChatBubble role="assistant" content={visibleLiveText} streaming />
              )}
              <div className="conversation-anchor" aria-hidden="true" />
            </div>
          ) : (
            <div className="agent-welcome">
              <span className="agent-mark large">{agent.data.name.slice(0, 1)}</span>
              <h2>把任务交给 {agent.data.name}</h2>
              <p>{agent.data.description}</p>
              <div className="prompt-suggestions">
                <button onClick={() => send('请介绍你的能力，以及你会如何记录执行过程。')}>
                  介绍你的能力
                </button>
                <button onClick={() => send('请帮我规划一个研究任务，并说明每一步。')}>
                  规划研究任务
                </button>
              </div>
            </div>
          )}
        </section>
        {error && (
          <div className="run-error" role="alert">
            <div>
              <strong>本轮执行失败</strong>
              <p>{error}</p>
            </div>
            <button onClick={() => setError('')}>关闭</button>
          </div>
        )}
        <ChatInput
          onSend={send}
          disabled={sending}
          loading={sending}
          placeholder={
            agent.data.status === 'published'
              ? '描述任务，或继续追问…'
              : '发布 Agent 后即可开始任务'
          }
        />
      </main>
      <aside className="context-rail">
        <header>
          <h2>上下文</h2>
          <button
            className="icon-button"
            aria-label="关闭上下文"
            onClick={() => setRightOpen(false)}
          >
            ×
          </button>
        </header>
        <section>
          <h3>运行概要</h3>
          <dl className="context-stats">
            <div>
              <dt>模型调用</dt>
              <dd>{merged.filter((event) => event.type === 'llm.request').length}</dd>
            </div>
            <div>
              <dt>工具调用</dt>
              <dd>{merged.filter((event) => event.type === 'tool.called').length}</dd>
            </div>
            <div>
              <dt>检查点</dt>
              <dd>{merged.filter((event) => event.type === 'state.checkpoint').length}</dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>产物</h3>
          <div className="context-empty">任务生成的文件、报告和引用会出现在这里。</div>
        </section>
        <section>
          <h3>已启用能力</h3>
          <div className="agent-capability-summary">
            <div><span>模型</span><strong>{agent.data.capabilities?.model.name ?? agent.data.model}</strong></div>
            <div><span>工具</span><strong>{agent.data.capabilities?.tools.length ?? 0}</strong></div>
            <div><span>MCP</span><strong>{agent.data.capabilities?.mcp_servers.length ?? 0}</strong></div>
            <div><span>Skills</span><strong>{agent.data.capabilities?.skills.length ?? 0}</strong></div>
            <div><span>Memory</span><strong>{agent.data.capabilities?.memory.enabled ? '任务' : '关闭'}</strong></div>
            <div><span>子 Agent</span><strong>{agent.data.capabilities?.child_agents.length ?? 0}</strong></div>
          </div>
          {agent.data.mock && <p className="mock-capability-note">此 Agent 使用本地 Mock 模型，仅用于开发验收。</p>}
        </section>
        <section className="activity-list">
          <h3>最近活动</h3>
          {activities.map((event) => (
            <div key={event.id}>
              <i className={event.verb === 'error' ? 'is-error' : ''} />
              <span>
                <strong>{activityCopy(event).label}</strong>
                <small>{activityCopy(event).detail}</small>
              </span>
              <code>#{event.seq}</code>
            </div>
          ))}
          {!activities.length && (
            <div className="context-empty">运行后显示模型、工具和子 Agent 活动。</div>
          )}
        </section>
      </aside>
    </div>
  );
}
