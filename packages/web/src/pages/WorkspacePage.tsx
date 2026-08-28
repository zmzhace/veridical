import { useState } from 'react';
import { useSpecs } from '../api/queries';

const nodes = [
  { id: 'agent', label: 'Agent', title: '研究助手', meta: '负责理解任务并组织步骤', x: '8%', y: '34%', tone: 'blue' },
  { id: 'model', label: '模型', title: 'Qwen · 服务端配置', meta: '生成决策与下一步动作', x: '39%', y: '14%', tone: 'violet' },
  { id: 'tools', label: '工具', title: '可用工具 3 个', meta: '搜索、计算、文件读取', x: '39%', y: '58%', tone: 'amber' },
  { id: 'review', label: '运行与回放', title: '可追溯轨迹', meta: '每个输入输出都被记录', x: '72%', y: '34%', tone: 'green' },
] as const;

export function WorkspacePage() {
  const { data: specs = [] } = useSpecs();
  const [selected, setSelected] = useState('agent');
  const node = nodes.find((n) => n.id === selected) ?? nodes[0];
  return <div className="agent-workspace"><header className="workspace-heading"><div><div className="eyebrow">AGENT STUDIO / 工作区</div><h1 className="page-title">研究助手</h1><p className="page-desc">在画布上组织 Agent 的能力，运行后再到回放工作台检查每一步。</p></div><div className="workspace-actions"><button className="btn btn-ghost">保存草稿</button><button className="btn btn-primary">运行测试</button></div></header>
    <div className="workspace-toolbar"><span className="workspace-status"><i/>草稿 · 未发布</span><span>{specs.length} 个 Spec 可用</span><button>＋ 添加节点</button><button>⌘K 快速操作</button></div>
    <div className="canvas-layout"><section className="agent-canvas" aria-label="Agent 画布"><svg className="canvas-lines" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true"><path d="M190 300 C300 300 320 170 420 170"/><path d="M190 300 C300 300 320 430 420 430"/><path d="M580 170 C680 170 700 300 810 300"/><path d="M580 430 C680 430 700 300 810 300"/></svg>{nodes.map(n=><button type="button" key={n.id} className={`canvas-node node-${n.tone} ${selected===n.id?'is-selected':''}`} style={{left:n.x,top:n.y}} onClick={()=>setSelected(n.id)}><span className="canvas-node-kicker">{n.label}</span><strong>{n.title}</strong><small>{n.meta}</small></button>)}<div className="canvas-zoom"><button>−</button><span>100%</span><button>＋</button></div></section><aside className="node-inspector"><div className="inspector-kicker">SELECTED NODE</div><h2>{node.title}</h2><p>{node.meta}</p><div className="inspector-rule"/><label>节点类型<span>{node.label}</span></label><label>状态<span className="inspector-ok">● 已连接</span></label><label>输入与输出<span>完整记录</span></label><button className="btn btn-ghost inspector-edit">编辑节点配置</button><a className="inspector-link" href="/specs">打开高级 Spec 编辑 →</a></aside></div>
  </div>;
}
