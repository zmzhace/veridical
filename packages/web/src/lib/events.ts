import type { TraceEvent } from '@veridical/schema';

export interface EventMeta {
  label: string;        // 中文标签
  icon: string;         // 简单字符图标（避免引依赖）
  tone: 'good' | 'warn' | 'bad' | 'neutral' | 'accent' | 'stage';
  desc: (e: TraceEvent) => string; // 人话描述
}

const p = (e: TraceEvent) => (e.payload as any) ?? {};

export function eventMeta(e: TraceEvent): EventMeta {
  const t = e.type;
  const toolName = () => String(p(e).name ?? '');
  const stageId = () => String(p(e).stage ?? '');
  const text = () => {
    const x = p(e).text;
    return typeof x === 'string' ? x.slice(0, 60) : '';
  };

  const base: Record<string, EventMeta> = {
    'spec/run/start': { label: '开始运行', icon: '▶', tone: 'accent', desc: () => `启动「${p(e).spec_name ?? 'spec'}@${p(e).spec_version ?? ''}」` },
    'spec/run/end': { label: '运行结束', icon: '■', tone: e.verb === 'error' ? 'bad' : 'good', desc: () => (e.verb === 'error' ? `出错：${p(e).message ?? ''}` : '运行完成') },
    'turn/start': { label: '新对话', icon: '●', tone: 'accent', desc: () => `用户发起：${p(e).prompt ?? ''}` },
    'turn/end': { label: '对话结束', icon: '✓', tone: 'good', desc: () => '本轮对话结束' },
    'step/start': { label: '步骤开始', icon: '◈', tone: 'neutral', desc: () => `第 ${p(e).step ?? ''} 步` },
    'step/end': { label: '步骤结束', icon: '✦', tone: e.verb === 'error' ? 'bad' : 'neutral', desc: () => (e.verb === 'error' ? '该步被阻止' : '') },
    'user.message': { label: '用户消息', icon: '人', tone: 'neutral', desc: () => text() || '用户输入' },
    'assistant.message': { label: '助手回复', icon: 'AI', tone: 'accent', desc: () => text() || '助手输出' },
    'llm.request': { label: '请求模型', icon: '脑', tone: 'neutral', desc: () => `调用 ${p(e).model ?? ''} · ${(p(e).messages ?? []).length} 条消息` },
    'llm.response': { label: '模型返回', icon: '↩', tone: e.verb === 'error' ? 'bad' : 'good', desc: () => (e.verb === 'error' ? `错误：${p(e).message ?? ''}` : text() || `返回结果`) },
    'tool.called': { label: '调用工具', icon: '⚙', tone: 'warn', desc: () => `${toolName()}(${JSON.stringify(p(e).args ?? {})})` },
    'tool.result': { label: '工具结果', icon: '⏎', tone: e.verb === 'error' ? 'bad' : 'good', desc: () => (e.verb === 'error' ? `${toolName()} 执行失败` : `${toolName()} 返回`) },
    'state.snapshot': { label: '状态快照', icon: '≋', tone: 'neutral', desc: () => '记录状态' },
    'agent.dispatch': { label: '派发专家', icon: '⇢', tone: 'accent', desc: () => `派给 ${p(e).delegate ?? ''}` },
    'agent.result': { label: '专家返回', icon: '⇠', tone: e.verb === 'error' ? 'bad' : 'good', desc: () => `${p(e).delegate ?? ''} ${e.verb === 'error' ? '失败' : '完成'}` },
    'stage/start': { label: '进入阶段', icon: '▣', tone: 'stage', desc: () => stageHuman(stageId()) },
    'stage/end': { label: '阶段结束', icon: '▣', tone: e.verb === 'error' ? 'bad' : 'stage', desc: () => (e.verb === 'error' ? `${stageHuman(stageId())} — 未通过关卡，流程终止` : stageHuman(stageId()) + ' 通过') },
    'memory.write': { label: '写入记忆', icon: '✦', tone: 'neutral', desc: () => `记忆：${p(e).key ?? ''}` },
    'memory.recalled': { label: '唤起记忆', icon: '❋', tone: 'neutral', desc: () => `查询「${p(e).query ?? ''}」命中 ${(p(e).hits ?? []).length} 条` },
    'eval/run/start': { label: '评估开始', icon: '▶', tone: 'accent', desc: () => `场景：${p(e).scenario ?? ''}` },
    'eval/step/end': { label: '评估步骤', icon: '✦', tone: p(e).passed ? 'good' : 'bad', desc: () => (p(e).passed ? '通过' : '未通过') },
  };

  const meta = base[t];
  if (meta) return meta;
  return { label: t, icon: '·', tone: 'neutral', desc: () => String(p(e).message ?? '') };
}

const STAGE_HUMAN: Record<string, string> = {
  health_check: '健康核验',
  surrender_analysis: '退保损失评估',
  continuity_check: '保障连续性核对',
  close: '促成签约',
  s1: '阶段一',
  s2: '阶段二',
  compare_policy: '保单对比',
  get_policy: '保单查询',
  explain_benefit: '权益讲解',
  submit_transfer: '提交转保',
  verify_health: '健康核验',
  assess_surrender: '退保评估',
  schedule_close: '促成预约',
};

export function stageHuman(id: string): string {
  return STAGE_HUMAN[id] ?? id;
}

export function toolHuman(name: string): string {
  const map: Record<string, string> = {
    echo: '回声',
    get_policy: '查询保单',
    compare_policy: '对比保单',
    explain_benefit: '讲解权益',
    close: '促成签约',
    submit_transfer: '提交转保',
    verify_health: '核验健康告知',
    assess_surrender: '评估退保损失',
    compare_benefits: '对比保障',
    query_claims: '查理赔记录',
    schedule_close: '安排促成',
  };
  return map[name] ?? name;
}

export function sessionHuman(id: string): string {
  if (id.startsWith('run_')) return `运行 · ${id.slice(4, 12)}`;
  if (id.startsWith('spec_')) return `规格演示 · ${id.slice(5, 12)}`;
  if (id.startsWith('s')) return `会话 ${id}`;
  return id;
}

export function toneClass(tone: EventMeta['tone']): string {
  switch (tone) {
    case 'good': return 'text-emerald-700 bg-emerald-50 border-emerald-200';
    case 'warn': return 'text-amber-700 bg-amber-50 border-amber-200';
    case 'bad': return 'text-red-700 bg-red-50 border-red-200';
    case 'accent': return 'text-indigo-700 bg-indigo-50 border-indigo-200';
    case 'stage': return 'text-teal-700 bg-teal-50 border-teal-200';
    default: return 'text-gray-600 bg-gray-50 border-gray-200';
  }
}