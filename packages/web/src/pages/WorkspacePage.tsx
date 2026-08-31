import { useState, type PointerEvent } from 'react';
import { useAddSpec, useReplayExecution, useSessions, useSpecs } from '../api/queries';
import { readSseFrames } from '../api/readSse';
import { stringify } from 'yaml';

type CanvasNode = {
  id: string;
  label: string;
  title: string;
  meta: string;
  x: number;
  y: number;
  tone: string;
};
const seedNodes: CanvasNode[] = [
  {
    id: 'input',
    label: 'Chat Input',
    title: '用户输入',
    meta: '会话消息和任务入口',
    x: 12,
    y: 34,
    tone: 'blue',
  },
  {
    id: 'agent',
    label: 'Agent',
    title: '研究助手',
    meta: '负责理解任务并组织步骤',
    x: 44,
    y: 34,
    tone: 'blue',
  },
  {
    id: 'tools',
    label: '工具',
    title: '可用工具 3 个',
    meta: '搜索、计算、文件读取',
    x: 44,
    y: 60,
    tone: 'amber',
  },
  {
    id: 'output',
    label: 'Chat Output',
    title: '助手输出',
    meta: '返回最终回答和结构化结果',
    x: 78,
    y: 34,
    tone: 'green',
  },
];
const seedEdges = [
  ['input', 'agent'],
  ['agent', 'tools'],
  ['agent', 'output'],
];

export function WorkspacePage() {
  const { data: specs = [] } = useSpecs();
  const { data: sessions = [] } = useSessions();
  const addSpec = useAddSpec();
  const replay = useReplayExecution();
  const [agentName, setAgentName] = useState('研究助手');
  const [instruction, setInstruction] = useState(
    '帮助用户完成研究任务，引用可靠证据并说明不确定性。',
  );
  const [model, setModel] = useState('服务端默认模型');
  const [notice, setNotice] = useState('');
  const [nodes, setNodes] = useState<CanvasNode[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('veridical.canvas.nodes') ?? 'null') ?? seedNodes;
    } catch {
      return seedNodes;
    }
  });
  const [edges, setEdges] = useState<string[][]>(seedEdges);
  const [selected, setSelected] = useState('agent');
  const [drag, setDrag] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [linking, setLinking] = useState<string | null>(null);
  const [showSpec, setShowSpec] = useState(false);
  const [panel, setPanel] = useState<'run' | 'replay' | null>(null);
  const [prompt, setPrompt] = useState(''); const [runOutput, setRunOutput] = useState(''); const [running, setRunning] = useState(false); const [replaySession, setReplaySession] = useState('');
  async function runCanvas() { setRunning(true); setRunOutput(''); try { const response = await fetch('/api/run/turn', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ specName: agentName.toLowerCase().replace(/[^a-z0-9]+/g,'-') || 'research-agent', mode:'mock', prompt }) }); if (!response.ok) throw new Error((await response.text()) || response.statusText); await readSseFrames(response, (frame) => { if (frame.type === 'token') setRunOutput((v) => v + frame.text); if (frame.type === 'error') setRunOutput(`错误：${frame.message}`); }); } catch (e) { setRunOutput(e instanceof Error ? `错误：${e.message}` : '运行失败'); } finally { setRunning(false); } }
  const node = nodes.find((n) => n.id === selected) ?? nodes[0];
  function addNode(kind: '工具' | 'Skill' | 'Memory' | '条件' | '输出' = '工具') {
    const id = `${kind}-${nodes.length}`;
    const tone =
      kind === 'Skill'
        ? 'violet'
        : kind === 'Memory' || kind === '输出'
          ? 'green'
          : kind === '条件'
            ? 'blue'
            : 'amber';
    setNodes((all) => [
      ...all,
      { id, label: kind, title: `新${kind}节点`, meta: '点击右侧配置输入输出', x: 60, y: 78, tone },
    ]);
    setSelected(id);
  }
  function saveDraft() {
    localStorage.setItem('veridical.canvas.nodes', JSON.stringify(nodes));
    localStorage.setItem('veridical.canvas.edges', JSON.stringify(edges));
  }
  function updateNode(key: 'title' | 'meta', value: string) {
    setNodes((all) => all.map((n) => (n.id === selected ? { ...n, [key]: value } : n)));
  }
  function port(id: string) {
    if (!linking) {
      setLinking(id);
      return;
    }
    if (linking !== id && !edges.some(([a, b]) => a === linking && b === id))
      setEdges((all) => [...all, [linking, id]]);
    setLinking(null);
  }
  async function publishSpec() {
    const yaml = stringify({
      name:
        agentName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'research-agent',
      version: '1.0.0',
      schema_version: 1,
      instruction: { system: instruction },
      flow: {
        mode: 'single-loop',
        max_steps: 8,
        loop: { engine: 'orchestrator', strategy: 'direct' },
      },
      llm: { provider: 'local', model: 'configured', fallback: [] },
      tools: [],
      skills: [],
      agents: [],
    });
    try {
      await addSpec.mutateAsync(yaml);
      setNotice('已根据画布生成并注册 Spec · v1.0.0');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '注册失败');
    }
  }
  function move(event: PointerEvent, id: string) {
    if (drag !== id) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.max(4, Math.min(96, ((event.clientX - box.left) / box.width) * 100));
    const y = Math.max(8, Math.min(92, ((event.clientY - box.top) / box.height) * 100));
    setNodes((all) => all.map((n) => (n.id === id ? { ...n, x, y } : n)));
  }
  return (
    <div className="agent-workspace">
      <header className="workspace-heading">
        <div>
          <div className="eyebrow">AGENT STUDIO / 工作区</div>
          <h1 className="page-title">研究助手</h1>
          <p className="page-desc">在画布上组织 Agent 的能力，直接运行或回放当前流程。</p>
        </div>
        <div className="workspace-actions">
          <button className="btn btn-ghost" onClick={() => setShowSpec(true)}>
            规格设置
          </button>
          <button className="btn btn-ghost" onClick={() => setPanel('replay')}>
            回放
          </button>
          <button className="btn btn-primary" onClick={() => setPanel('run')}>
            运行测试
          </button>
        </div>
      </header>
      <div className="workspace-toolbar">
        <span className="workspace-status">
          <i />
          草稿 · 未发布
        </span>
        <span>{specs.length} 个 Spec 可用</span>
        <button onClick={saveDraft}>保存草稿</button>
        <button className="toolbar-publish" onClick={publishSpec} disabled={addSpec.isPending}>
          {addSpec.isPending ? '生成中…' : '生成 Spec 并注册'}
        </button>
      </div>
      {notice && (
        <p className="workspace-notice" role="status">
          {notice}
        </p>
      )}
      <div className="canvas-layout">
        <section
          className="agent-canvas"
          aria-label="Agent 画布"
          onWheel={(e) => {
            e.preventDefault();
            setZoom((z) => Math.max(0.6, Math.min(1.5, z - (e.deltaY > 0 ? 0.05 : -0.05))));
          }}
          onPointerMove={(e) => drag && move(e, drag)}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="canvas-palette">
            <span>添加节点</span>
            <button onClick={() => addNode('工具')}>⚙ 工具</button>
            <button onClick={() => addNode('Skill')}>✦ Skill</button>
            <button onClick={() => addNode('Memory')}>◌ Memory</button>
            <button onClick={() => addNode('条件')}>◇ 条件</button>
            <button onClick={() => addNode('输出')}>↗ 输出</button>
          </div>
          <div className="canvas-content" style={{ transform: `scale(${zoom})` }}>
            <svg
              className="canvas-lines"
              viewBox="0 0 1000 600"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {edges.map(([a, b]) => {
                const from = nodes.find((n) => n.id === a);
                const to = nodes.find((n) => n.id === b);
                return from && to ? (
                  <path
                    key={`${a}-${b}`}
                    d={`M${from.x * 10} ${from.y * 6} C${(from.x + to.x) * 5} ${from.y * 6} ${(from.x + to.x) * 5} ${to.y * 6} ${to.x * 10} ${to.y * 6}`}
                  />
                ) : null;
              })}
            </svg>
            {nodes.map((n) => (
              <div
                key={n.id}
                className={`canvas-node node-${n.tone} ${selected === n.id ? 'is-selected' : ''}`}
                style={{ left: `${n.x}%`, top: `${n.y}%` }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag(n.id);
                  setSelected(n.id);
                }}
                onClick={() => setSelected(n.id)}
              >
                <span
                  className="node-port node-port-in"
                  onClick={(e) => {
                    e.stopPropagation();
                    port(n.id);
                  }}
                />
                <span className="canvas-node-kicker">{n.label}</span>
                <strong>{n.title}</strong>
                <small>{n.meta}</small>
                <span
                  className="node-port node-port-out"
                  onClick={(e) => {
                    e.stopPropagation();
                    port(n.id);
                  }}
                />
              </div>
            ))}
          </div>
          <div className="canvas-zoom">
            <button onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))}>−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}>＋</button>
          </div>
          {linking && <div className="canvas-linking-hint">正在连接：请点击另一个节点端口</div>}
        </section>
        <aside className="node-inspector">
          <div className="inspector-kicker">节点配置</div>
          {node.id === 'agent' && (
            <>
              <label>
                Agent 名称
                <input
                  className="field"
                  value={agentName}
                  onChange={(e) => {
                    setAgentName(e.target.value);
                    updateNode('title', e.target.value);
                  }}
                />
              </label>
              <label>
                任务目标
                <textarea
                  className="field"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                />
              </label>
              <label>
                使用模型
                <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option>服务端默认模型</option><option>Qwen 3.8 Flash</option><option>自定义模型配置</option>
                </select>
                <small className="field-hint">模型属于 Agent 配置，不需要单独连线。</small>
              </label>
            </>
          )}
          <input
            className="field inspector-title-input"
            value={node.title}
            onChange={(e) => updateNode('title', e.target.value)}
          />
          <textarea
            className="field inspector-meta-input"
            value={node.meta}
            onChange={(e) => updateNode('meta', e.target.value)}
          />
          <div className="inspector-rule" />
          <div className="inspector-section-title">运行行为</div>
          <label>
            节点类型<span>{node.label}</span>
          </label>
          <label>
            执行模式
            <select className="field inspector-select"><option>顺序执行</option><option>允许重试</option><option>等待人工确认</option></select>
          </label>
          <div className="inspector-section-title">治理</div>
          <label>
            状态<span className="inspector-ok">● 已连接</span>
          </label>
          <label>
            输入与输出<span>{linking ? '请选择目标节点端口' : '完整记录'}</span>
          </label>
          <button className="btn btn-ghost inspector-edit" onClick={saveDraft}>
            保存节点配置
          </button>
          <button className="inspector-link" onClick={() => setShowSpec(true)}>
            打开规格设置
          </button>
        </aside>
      </div>
      {showSpec && (
        <div className="spec-float-backdrop" onClick={() => setShowSpec(false)}>
          <section className="spec-float" onClick={(e) => e.stopPropagation()}>
            <div className="inspector-kicker">SPEC / 规格设置</div>
            <h2>让系统补齐复杂配置</h2>
            <p>只需要填写任务目标，其余字段使用安全默认值。</p>
            <label>
              Agent 名称
              <input
                className="field"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              />
            </label>
            <label>
              任务目标
              <textarea
                className="field"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            <div className="spec-float-actions">
              <button className="btn btn-ghost" onClick={() => setShowSpec(false)}>
                返回画布
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setShowSpec(false);
                  publishSpec();
                }}
              >
                生成并注册 Spec
              </button>
            </div>
          </section>
        </div>
      )}
      {panel && (
        <div className="canvas-panel-backdrop" onClick={() => setPanel(null)}>
          <section className="canvas-panel" onClick={(e) => e.stopPropagation()}>
            <button className="canvas-panel-close" onClick={() => setPanel(null)}>
              ×
            </button>
            <div className="inspector-kicker">
              {panel === 'run' ? 'RUN / 运行' : 'REPLAY / 回放'}
            </div>
            <h2>{panel === 'run' ? '运行当前画布' : '回放当前画布'}</h2>
            <p>
              {panel === 'run'
                ? '使用当前节点和规格启动一次测试运行。'
                : '选择历史运行，在当前工作区内重建调用路径。'}
            </p>
            {panel === 'run' ? (
              <>
                <label>
                  输入任务
                  <textarea className="field" placeholder="告诉 Agent 需要完成什么…" value={prompt} onChange={(e)=>setPrompt(e.target.value)} />
                </label>
                <button className="btn btn-primary panel-action" disabled={!prompt.trim()||running} onClick={runCanvas}>{running?'运行中…':'开始运行'}</button>{runOutput&&<pre className="panel-output">{runOutput}</pre>}
              </>
            ) : (
              <>
                <label>
                  源运行
                  <select className="field" value={replaySession} onChange={(e)=>setReplaySession(e.target.value)}>
                    <option value="">选择一条运行…</option>{sessions.map((s)=><option key={s.session_id} value={s.session_id}>{s.spec_name??s.session_id} · {s.event_count} 事件</option>)}
                  </select>
                </label>
                <div className="panel-mode-row">
                  <button className="is-selected">严格回放</button>
                  <button>固定数据</button>
                  <button>行为验证</button>
                </div>
                <button className="btn btn-primary panel-action" disabled={!replaySession||replay.isPending} onClick={()=>replay.mutate({id:replaySession,body:{mode:'strict'}})}>{replay.isPending?'回放中…':'开始回放'}</button>{replay.data&&<pre className="panel-output">{replay.data.identical?'严格一致':'完成，需审阅差异'}</pre>}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
