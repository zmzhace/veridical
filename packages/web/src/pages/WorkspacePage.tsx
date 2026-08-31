import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import { parse, stringify } from 'yaml';
import type { TraceEvent } from '@veridical/schema';
import {
  useAgent,
  useAgentDraft,
  useAgentTasks,
  usePublishAgent,
  useReplayExecution,
  useSaveAgentDraft,
} from '../api/queries';
import { readSseFrames } from '../api/readSse';
import { compileWorkspaceSpec, validateWorkspace } from '../workspace/graph/compiler';
import {
  simpleAgentGraph,
  type WorkspaceEdge,
  type WorkspaceGraph,
  type WorkspaceNode,
  type WorkspaceNodeType,
} from '../workspace/graph/model';
import { overlayFromEvents, overlayFromReplayResult } from '../workspace/graph/traceOverlay';
import '../studio.css';

const nodeCopy: Record<WorkspaceNodeType, { label: string; title: string; description: string }> = {
  input: { label: 'Input', title: '用户输入', description: '任务和多轮消息入口' },
  agent: { label: 'Agent', title: 'Agent', description: '理解任务并组织执行' },
  tool: { label: 'Tool', title: '新工具', description: '由 Agent 按需调用' },
  skill: { label: 'Skill', title: '新 Skill', description: '版本化的行为指令' },
  memory: { label: 'Memory', title: 'Memory', description: '读取和保存上下文' },
  condition: { label: 'Condition', title: '条件', description: '控制路径和门禁' },
  'child-agent': { label: 'Agent', title: '子 Agent', description: '接受主 Agent 委派' },
  output: { label: 'Output', title: '最终回复', description: '返回回答和产物' },
};
const capabilityTypes = new Set<WorkspaceNodeType>(['tool', 'skill', 'memory', 'child-agent']);
function edgeKind(
  source: WorkspaceNodeType,
  target: WorkspaceNodeType,
): WorkspaceEdge['kind'] | null {
  if (source === 'input' && target === 'agent') return 'message';
  if (source === 'agent' && target === 'output') return 'message';
  if (source === 'tool' && ['agent', 'child-agent'].includes(target)) return 'capability';
  if (source === 'skill' && ['agent', 'child-agent'].includes(target)) return 'instruction';
  if (source === 'memory' && ['agent', 'child-agent'].includes(target)) return 'memory';
  if (source === 'agent' && target === 'child-agent') return 'delegate';
  if (source === 'condition' || target === 'condition') return 'control';
  return null;
}
function cloneGraph(graph: WorkspaceGraph): WorkspaceGraph {
  return structuredClone(graph);
}
function graphFor(id: string, name: string, description: string, model: string): WorkspaceGraph {
  const graph = cloneGraph(simpleAgentGraph);
  graph.id = id;
  graph.name = name;
  const main = graph.nodes.find((node) => node.type === 'agent')!;
  main.title = name;
  main.description = description;
  main.config = { ...main.config, instruction: description, model };
  return graph;
}

export function WorkspacePage() {
  const { agentId = '' } = useParams();
  const agent = useAgent(agentId);
  const draft = useAgentDraft(agentId);
  const tasks = useAgentTasks(agentId);
  const save = useSaveAgentDraft(agentId);
  const publish = usePublishAgent(agentId);
  const replay = useReplayExecution();
  const [graph, setGraph] = useState<WorkspaceGraph>(() => cloneGraph(simpleAgentGraph));
  const [past, setPast] = useState<WorkspaceGraph[]>([]);
  const [future, setFuture] = useState<WorkspaceGraph[]>([]);
  const [selected, setSelected] = useState('agent');
  const [mode, setMode] = useState<'build' | 'run' | 'replay' | 'publish'>('build');
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [replayId, setReplayId] = useState('');
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current || !agent.data) return;
    const stored = draft.data?.graph as WorkspaceGraph | undefined;
    setGraph(
      stored?.nodes
        ? stored
        : graphFor(agentId, agent.data.name, agent.data.description, agent.data.model),
    );
    loaded.current = true;
  }, [agent.data, agentId, draft.data]);
  const node = graph.nodes.find((item) => item.id === selected) ?? graph.nodes[0];
  const errors = validateWorkspace(graph);
  const releaseVersion = agent.data?.version
    ? agent.data.version.replace(/(\d+)$/, (value) => String(Number(value) + 1))
    : '1.0.0';
  const yaml = useMemo(() => compileWorkspaceSpec(graph, releaseVersion), [graph, releaseVersion]);
  const overlay =
    mode === 'replay' ? overlayFromReplayResult(replay.data) : overlayFromEvents(events);
  function commit(update: (next: WorkspaceGraph) => void) {
    setPast((items) => [...items.slice(-39), cloneGraph(graph)]);
    setFuture([]);
    setGraph((current) => {
      const next = cloneGraph(current);
      update(next);
      return next;
    });
  }
  function undo() {
    const previous = past.at(-1);
    if (!previous) return;
    setFuture((items) => [cloneGraph(graph), ...items]);
    setPast((items) => items.slice(0, -1));
    setGraph(previous);
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setPast((items) => [...items, cloneGraph(graph)]);
    setFuture((items) => items.slice(1));
    setGraph(next);
  }
  function updateNode(update: Partial<WorkspaceNode>) {
    commit((next) => {
      const target = next.nodes.find((item) => item.id === selected);
      if (target) Object.assign(target, update);
    });
  }
  function addNode(type: WorkspaceNodeType) {
    const meta = nodeCopy[type];
    const id = `${type}-${crypto.randomUUID().slice(0, 6)}`;
    commit((next) =>
      next.nodes.push({
        id,
        type,
        ...meta,
        position: { x: 55, y: capabilityTypes.has(type) ? 70 : 50 },
        config: type === 'tool' ? { access: 'ask' } : {},
      }),
    );
    setSelected(id);
  }
  function removeNode() {
    if (['input', 'agent', 'output'].includes(node.id))
      return setNotice('基础输入、主 Agent 和输出节点不能删除。');
    commit((next) => {
      next.nodes = next.nodes.filter((item) => item.id !== node.id);
      next.edges = next.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
    });
    setSelected('agent');
  }
  function connect(id: string) {
    if (!linking) {
      setLinking(id);
      setNotice('请选择目标节点的连接点。');
      return;
    }
    const source = graph.nodes.find((item) => item.id === linking);
    const target = graph.nodes.find((item) => item.id === id);
    const kind = source && target ? edgeKind(source.type, target.type) : null;
    if (!kind) setNotice('这两个节点的方向或能力类型不兼容。');
    else if (!graph.edges.some((edge) => edge.source === linking && edge.target === id))
      commit((next) =>
        next.edges.push({ id: `${linking}-${id}`, source: linking, target: id, kind }),
      );
    setLinking(null);
  }
  function autoLayout() {
    commit((next) => {
      const input = next.nodes.find((item) => item.type === 'input');
      const main = next.nodes.find((item) => item.type === 'agent');
      const result = next.nodes.find((item) => item.type === 'output');
      if (input) input.position = { x: 16, y: 42 };
      if (main) main.position = { x: 49, y: 42 };
      if (result) result.position = { x: 82, y: 42 };
      const capabilities = next.nodes.filter((item) => capabilityTypes.has(item.type));
      capabilities.forEach(
        (item, index) =>
          (item.position = {
            x: capabilities.length === 1 ? 49 : 30 + index * (40 / (capabilities.length - 1)),
            y: 72,
          }),
      );
    });
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    if (!drag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(7, Math.min(93, ((event.clientX - bounds.left) / bounds.width) * 100));
    const y = Math.max(10, Math.min(90, ((event.clientY - bounds.top) / bounds.height) * 100));
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === drag ? { ...item, position: { x, y } } : item,
      ),
    }));
  }
  async function saveDraft() {
    try {
      await save.mutateAsync({ graph, yaml });
      setNotice('草稿已保存到工作区。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    }
  }
  async function publishRelease() {
    if (errors.length) return setNotice(errors[0]);
    try {
      await saveDraft();
      await publish.mutateAsync({ graph, yaml });
      setNotice('验证通过，Release 已发布。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '发布失败');
    }
  }
  async function runDraft() {
    if (!prompt.trim() || errors.length) return setNotice(errors[0] ?? '请输入测试任务。');
    setRunning(true);
    setOutput('');
    setEvents([]);
    try {
      const version = `0.0.0-dev.${Date.now()}`;
      const spec = parse(yaml);
      spec.version = version;
      const registered = await fetch('/api/specs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: stringify(spec) }),
      });
      if (!registered.ok)
        throw new Error(
          (await registered.json().catch(() => ({})))?.error?.message ?? '无法准备测试规格',
        );
      const response = await fetch('/api/run/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specName: graph.id, version, prompt, mode: 'live' }),
      });
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => ({})))?.error?.message ?? response.statusText,
        );
      await readSseFrames(response, (frame) => {
        if (frame.type === 'token') setOutput((value) => value + frame.text);
        if (frame.type === 'event')
          setEvents((items) =>
            items.some((item) => item.id === frame.event.id) ? items : [...items, frame.event],
          );
        if (frame.type === 'error') setNotice(frame.message);
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '运行失败');
    } finally {
      setRunning(false);
    }
  }
  async function replayTask() {
    if (!replayId) return;
    try {
      await replay.mutateAsync({ id: replayId, body: { mode: 'strict' } });
    } catch {
      /* mutation state renders error */
    }
  }
  if (agent.isLoading) return <div className="state-panel">正在加载 Studio…</div>;
  if (!agent.data)
    return (
      <div className="state-panel">
        <strong>请先选择 Agent</strong>
        <Link className="button" to="/agents">
          返回 Agents
        </Link>
      </div>
    );
  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div>
          <Link className="back-link" to={`/agents/${agentId}`}>
            ‹ {agent.data.name}
          </Link>
          <div className="studio-title">
            <h1>Agent Studio</h1>
            <span className="status-label is-draft">草稿 r{draft.data?.revision ?? 0}</span>
          </div>
        </div>
        <nav aria-label="Studio 模式">
          {(
            [
              ['build', '构建'],
              ['run', '运行'],
              ['replay', '回放'],
              ['publish', '发布'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="studio-actions">
          <button className="button" onClick={saveDraft} disabled={save.isPending}>
            {save.isPending ? '保存中…' : '保存'}
          </button>
          <button className="button button-primary" onClick={() => setMode('run')}>
            运行
          </button>
        </div>
      </header>
      {notice && (
        <div className="studio-notice" role="status">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
      <div className="studio-body">
        <aside className="studio-palette">
          <p>能力</p>
          {(['tool', 'skill', 'memory', 'child-agent', 'condition'] as WorkspaceNodeType[]).map(
            (type) => (
              <button key={type} onClick={() => addNode(type)}>
                <span>{type === 'child-agent' ? 'A' : type.slice(0, 1).toUpperCase()}</span>
                {nodeCopy[type].title}
              </button>
            ),
          )}
          <p>编辑</p>
          <button onClick={undo} disabled={!past.length}>
            <span>↶</span>撤销
          </button>
          <button onClick={redo} disabled={!future.length}>
            <span>↷</span>重做
          </button>
          <button onClick={autoLayout}>
            <span>⌗</span>自动布局
          </button>
        </aside>
        <section
          className="studio-canvas"
          aria-label="Agent 画布"
          onPointerMove={move}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
          onWheel={(event) => {
            event.preventDefault();
            setZoom((value) =>
              Math.max(0.65, Math.min(1.35, value - (event.deltaY > 0 ? 0.05 : -0.05))),
            );
          }}
        >
          <div className="studio-canvas-inner" style={{ transform: `scale(${zoom})` }}>
            <svg viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
              {graph.edges.map((edge) => {
                const from = graph.nodes.find((item) => item.id === edge.source);
                const to = graph.nodes.find((item) => item.id === edge.target);
                return from && to ? (
                  <path
                    key={edge.id}
                    className={`edge-${edge.kind}`}
                    d={`M${from.position.x * 10} ${from.position.y * 6} C${(from.position.x + to.position.x) * 5} ${from.position.y * 6} ${(from.position.x + to.position.x) * 5} ${to.position.y * 6} ${to.position.x * 10} ${to.position.y * 6}`}
                  />
                ) : null;
              })}
            </svg>
            {graph.nodes.map((item) => (
              <article
                key={item.id}
                className={`studio-node type-${item.type} ${selected === item.id ? 'is-selected' : ''} runtime-${overlay[item.id] ?? 'idle'}`}
                style={{ left: `${item.position.x}%`, top: `${item.position.y}%` }}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).classList.contains('studio-port')) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setPast((items) => [...items.slice(-39), cloneGraph(graph)]);
                  setDrag(item.id);
                  setSelected(item.id);
                }}
              >
                <button
                  className="studio-port is-in"
                  aria-label={`连接到 ${item.title}`}
                  onClick={() => connect(item.id)}
                />
                <span>{item.label}</span>
                <strong>{item.title}</strong>
                <small>{item.description}</small>
                <button
                  className="studio-port is-out"
                  aria-label={`从 ${item.title} 连接`}
                  onClick={() => connect(item.id)}
                />
              </article>
            ))}
          </div>
          <div className="studio-zoom">
            <button onClick={() => setZoom((value) => Math.max(0.65, value - 0.1))}>−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((value) => Math.min(1.35, value + 0.1))}>＋</button>
          </div>
          {linking && <div className="link-hint">选择兼容的目标节点</div>}
        </section>
        <aside className="studio-inspector">
          <header>
            <div>
              <p>{node.label}</p>
              <h2>{node.title}</h2>
            </div>
            {!['input', 'agent', 'output'].includes(node.id) && (
              <button className="icon-button" aria-label="删除节点" onClick={removeNode}>
                ×
              </button>
            )}
          </header>
          <label>
            名称
            <input
              value={node.title}
              onChange={(event) => updateNode({ title: event.target.value })}
            />
          </label>
          <label>
            说明
            <textarea
              value={node.description}
              onChange={(event) => updateNode({ description: event.target.value })}
            />
          </label>
          {node.type === 'agent' && (
            <>
              <label>
                系统指令
                <textarea
                  className="instruction-field"
                  value={String(node.config.instruction ?? '')}
                  onChange={(event) =>
                    updateNode({ config: { ...node.config, instruction: event.target.value } })
                  }
                />
              </label>
              <label>
                模型
                <select
                  value={String(node.config.model ?? 'server-default')}
                  onChange={(event) =>
                    updateNode({ config: { ...node.config, model: event.target.value } })
                  }
                >
                  <option value="server-default">服务端默认模型</option>
                  <option value="qwen3.8-flash">Qwen 3.8 Flash</option>
                </select>
                <small>密钥由服务端环境读取。</small>
              </label>
              <button
                className="advanced-toggle"
                aria-expanded={advanced}
                onClick={() => setAdvanced((value) => !value)}
              >
                高级设置 <span>{advanced ? '−' : '＋'}</span>
              </button>
              {advanced && (
                <div className="advanced-settings">
                  <label>
                    Loop 策略
                    <select
                      value={String(node.config.strategy ?? 'direct')}
                      onChange={(event) =>
                        updateNode({ config: { ...node.config, strategy: event.target.value } })
                      }
                    >
                      <option value="direct">Direct</option>
                      <option value="supervisor">Supervisor</option>
                      <option value="stage-gate">Stage Gate</option>
                    </select>
                  </label>
                  <label>
                    最大步骤
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={Number(node.config.maxSteps ?? 8)}
                      onChange={(event) =>
                        updateNode({
                          config: { ...node.config, maxSteps: Number(event.target.value) },
                        })
                      }
                    />
                  </label>
                  <label>
                    工具权限
                    <select>
                      <option>按节点配置</option>
                      <option>全部需要确认</option>
                    </select>
                  </label>
                </div>
              )}
            </>
          )}
          {node.type === 'tool' && (
            <label>
              权限
              <select
                value={String(node.config.access ?? 'ask')}
                onChange={(event) =>
                  updateNode({ config: { ...node.config, access: event.target.value } })
                }
              >
                <option value="ask">每次确认</option>
                <option value="allow">允许</option>
                <option value="deny">禁止</option>
              </select>
            </label>
          )}
          <div className="inspector-footer">
            <span>
              {
                graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id)
                  .length
              }{' '}
              条连接
            </span>
            <button onClick={() => setYamlOpen(true)}>查看生成的 YAML</button>
          </div>
        </aside>
      </div>
      {mode !== 'build' && (
        <aside className="studio-drawer">
          <header>
            <div>
              <p className="product-kicker">{mode}</p>
              <h2>
                {mode === 'run'
                  ? '运行当前草稿'
                  : mode === 'replay'
                    ? '回放历史任务'
                    : '发布 Release'}
              </h2>
            </div>
            <button className="icon-button" onClick={() => setMode('build')}>
              ×
            </button>
          </header>
          {mode === 'run' && (
            <>
              <p>使用服务端已配置的真实模型运行，不需要再次填写密钥。</p>
              <label>
                测试任务
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="输入一个真实任务…"
                />
              </label>
              <button className="button button-primary wide" disabled={running} onClick={runDraft}>
                {running ? '运行中…' : '开始运行'}
              </button>
              {output && <pre className="studio-output">{output}</pre>}
            </>
          )}
          {mode === 'replay' && (
            <>
              <p>严格回放会校验版本、路径、工具参数和响应指纹。</p>
              <label>
                历史任务
                <select value={replayId} onChange={(event) => setReplayId(event.target.value)}>
                  <option value="">选择任务</option>
                  {(tasks.data ?? []).map((task) => (
                    <option key={task.session_id} value={task.session_id}>
                      {task.first_message || task.session_id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button button-primary wide"
                disabled={!replayId || replay.isPending}
                onClick={replayTask}
              >
                {replay.isPending ? '回放中…' : '严格回放'}
              </button>
              {replay.data && (
                <div
                  className={`drawer-result ${replay.data.identical ? 'is-success' : 'is-difference'}`}
                >
                  <strong>{replay.data.identical ? '路径与响应完全一致' : '发现差异'}</strong>
                  <pre>{JSON.stringify(replay.data, null, 2)}</pre>
                </div>
              )}
              {replay.error && <p className="inline-error">{replay.error.message}</p>}
            </>
          )}
          {mode === 'publish' && (
            <>
              <p>发布会固定 Spec、模型、工具和 Loop 配置，生产只能执行已发布版本。</p>
              <div className="publish-checks">
                <span className={errors.length ? 'is-error' : 'is-ok'}>
                  {errors.length ? '×' : '✓'} 画布结构
                </span>
                <span className="is-ok">✓ 模型凭据引用</span>
                <span className="is-ok">✓ 工具权限声明</span>
                {errors.map((error) => (
                  <small key={error}>{error}</small>
                ))}
              </div>
              <button
                className="button button-primary wide"
                disabled={publish.isPending || !!errors.length}
                onClick={publishRelease}
              >
                {publish.isPending ? '发布中…' : '验证并发布'}
              </button>
            </>
          )}
        </aside>
      )}
      {yamlOpen && (
        <div className="sheet-backdrop" onMouseDown={() => setYamlOpen(false)}>
          <section
            className="product-sheet yaml-sheet"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="product-kicker">Generated spec</p>
                <h2>生成的 YAML</h2>
              </div>
              <button className="icon-button" onClick={() => setYamlOpen(false)}>
                ×
              </button>
            </header>
            <p>这是画布的编译结果。日常配置无需直接编辑。</p>
            <pre>{yaml}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
