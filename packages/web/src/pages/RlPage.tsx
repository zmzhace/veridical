import { useState } from 'react';

const ECHO_SPEC = `name: rl-demo
version: 1.0.0
schema_version: 1
instruction: { system: you are a bot }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: echo
    access: allow
`;
const ECHO_SCENARIO = `name: pick-echo
spec: { name: rl-demo }
rules:
  - tool_called: echo
steps:
  - user: hello
`;
const ECHO_CANDIDATES = [
  JSON.stringify({ text: 'call echo', tool: { name: 'echo', args: { x: 1 } } }),
  JSON.stringify({ text: 'say hi', done: true }),
  JSON.stringify({ text: 'say bye', done: true }),
  JSON.stringify({ text: 'say nope', done: true }),
].join('\n');

const INSURANCE_SPEC = `name: insurance-advisor
version: 1.0.0
schema_version: 1
instruction:
  system: 你是资深保险顾问。面对客户的既有保单与疑虑，必须先查证、再对比、讲清利弊，合规促成，绝不硬推。
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: get_policy
    access: allow
  - name: compare_policy
    access: allow
  - name: explain_benefit
    access: allow
  - name: close
    access: allow
`;
const INSURANCE_SCENARIO = `name: persuade-switch-policy
spec: { name: insurance-advisor }
steps:
  - user: 张女士38岁，现保贵想换性价比高的。开场：我这份保险交了五年，每年保费太高了。
    expect_rules:
      - tool_called: compare_policy
  - user: 李先生45岁家庭支柱，担心保额不够。开场：我上有老下有小，现保保额总觉得不够。
    expect_rules:
      - tool_called: get_policy
  - user: 王大爷60岁，怕换保麻烦。开场：换保单是不是特别麻烦？我可不想跑来跑去。
    expect_rules:
      - tool_called: close
  - user: 小刘28岁预算有限刚需重疾。开场：我想买重疾但预算不多，有没有性价比高的？
    expect_rules:
      - tool_called: compare_policy
  - user: 陈先生50岁已有高端保障想加保。开场：我保障挺全的，还能升级什么权益？
    expect_rules:
      - tool_called: explain_benefit
  - user: 赵阿姨55岁被推销过，信任感低。开场：你们是不是就想骗我换单赚佣金？
    expect_rules:
      - tool_called: get_policy
`;
const INSURANCE_CANDIDATES = [
  JSON.stringify({ text: '先调取您的现有保单做诊断', tool: { name: 'get_policy', args: { customer: 'C001' } } }),
  JSON.stringify({ text: '我帮您对比新旧保单的费用与保障', tool: { name: 'compare_policy', args: { customer: 'C001' } } }),
  JSON.stringify({ text: '我为您讲解升级后的核心权益', tool: { name: 'explain_benefit', args: { customer: 'C001' } } }),
  JSON.stringify({ text: '为您安排专属顾问跟进，今天就能办', tool: { name: 'close', args: { customer: 'C001' } } }),
  JSON.stringify({ text: '别犹豫了，现在换最划算', done: true }),
  JSON.stringify({ text: '这个我也不太清楚，您自己决定吧', done: true }),
  JSON.stringify({ text: '直接换吧，肯定比您现在的好', done: true }),
].join('\n');

const TRANSFER_SPEC = `name: transfer-advisor
version: 1.0.0
schema_version: 1
instruction: { system: 你是转保顾问，必须按顺序核验健康、评估退保损失、核对保障连续性，再促成。 }
flow:
  mode: stage-gate
  max_steps: 4
  stages:
    - id: health_check
      gate: { tool_called: verify_health }
    - id: surrender_analysis
      gate: { tool_called: assess_surrender }
    - id: continuity_check
      gate: { tool_called: compare_benefits }
    - id: close
      gate: { tool_called: submit_transfer }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: verify_health
    access: allow
  - name: assess_surrender
    access: allow
  - name: compare_benefits
    access: allow
  - name: submit_transfer
    access: allow
`;
const TRANSFER_SCENARIO = `name: transfer-rl
spec: { name: transfer-advisor }
rules:
  - tool_called: submit_transfer
  - no_errors: true
steps:
  - user: 张先生40岁有慢性病想转保
  - user: 李女士35岁旧保单交了很多年想转保
`;
const TRANSFER_CANDIDATES = [
  JSON.stringify({ text: '', tool: { name: 'verify_health', args: {} } }),
  JSON.stringify({ text: '', tool: { name: 'assess_surrender', args: {} } }),
  JSON.stringify({ text: '', tool: { name: 'submit_transfer', args: {} } }),
  JSON.stringify({ text: '直接推客户转保，不核验', done: true }),
].join('\n');

const PRESETS: Record<string, { spec: string; scenario: string; candidates: string; label: string; desc: string }> = {
  transfer: { label: '转保案例', desc: '合规状态机 · 强制先核验再促成', spec: TRANSFER_SPEC, scenario: TRANSFER_SCENARIO, candidates: TRANSFER_CANDIDATES },
  insurance: { label: '换保单案例', desc: '六类客户 · 学会对画像选打法', spec: INSURANCE_SPEC, scenario: INSURANCE_SCENARIO, candidates: INSURANCE_CANDIDATES },
  echo: { label: 'echo demo', desc: '最小示例 · 入门用', spec: ECHO_SPEC, scenario: ECHO_SCENARIO, candidates: ECHO_CANDIDATES },
};
const DEFAULT_PRESET = 'transfer';

function actionText(text: string): { main: string; sub?: string } {
  try {
    const o = JSON.parse(text);
    if (o.tool) return { main: o.text || '调用工具', sub: `工具 ${o.tool.name}` };
    if (o.delegate) return { main: o.text || '派发专家', sub: `专家 ${o.delegate}` };
    if (o.done) return { main: o.text || '直接结束', sub: '无工具调用' };
    return { main: o.text || text };
  } catch {
    return { main: text };
  }
}

export function RlPage() {
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [specYaml, setSpecYaml] = useState(PRESETS[DEFAULT_PRESET].spec);
  const [scenarioYaml, setScenarioYaml] = useState(PRESETS[DEFAULT_PRESET].scenario);
  const [candidates, setCandidates] = useState(PRESETS[DEFAULT_PRESET].candidates);
  const [iterations, setIterations] = useState('20');
  const [groupSize, setGroupSize] = useState('8');
  const [lr, setLr] = useState('0.5');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<{ iteration: number; mean_reward: number; best_option: string }[]>([]);
  const [policy, setPolicy] = useState<Record<string, { options: { text: string; logit: number; prob: number }[] }> | null>(null);

  function onPreset(name: string) {
    const p = PRESETS[name];
    setPreset(name);
    setSpecYaml(p.spec);
    setScenarioYaml(p.scenario);
    setCandidates(p.candidates);
    setRows([]); setPolicy(null); setStatus('');
  }

  async function onRun() {
    setRows([]); setPolicy(null); setStatus('训练中…');
    const body = {
      specYaml, scenarioYaml,
      candidates: candidates.split('\n').map((s) => s.trim()).filter(Boolean),
      iterations: Number(iterations), groupSize: Number(groupSize), lr: Number(lr),
    };
    const res = await fetch('/api/rl/train', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
      for (const part of parts) {
        const t = part.trim(); if (!t.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(t.replace(/^data:\s*/, ''));
          if (msg.type === 'iteration') {
            setRows((r) => [...r, { iteration: msg.iteration, mean_reward: msg.mean_reward, best_option: msg.best_option }]);
            setPolicy(msg.policy);
            setStatus(`训练中 · 第 ${msg.iteration} 轮`);
          } else if (msg.type === 'done') setStatus(`完成 · ${msg.iterations} 轮 · 平均奖励 ${msg.final_mean_reward.toFixed(3)}`);
          else if (msg.type === 'error') setStatus(`出错：${msg.message}`);
        } catch { continue; }
      }
    }
  }

  const maxR = rows.length ? Math.max(...rows.map((r) => r.mean_reward), 1) : 1;
  const stateNames: Record<string, string> = {
    'health_check': '阶段 · 健康核验', 'surrender_analysis': '阶段 · 退保评估', 'continuity_check': '阶段 · 保障核对', 'close': '阶段 · 促成',
    's1': '阶段一', 's2': '阶段二',
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="page-title">RL 训练</h2>
        <p className="page-desc">GRPO 分组优势训练：agent 对不同客户/阶段学会选正确的动作。选一个案例，调整参数，点训练。</p>
      </div>

      <div className="grid gap-2">
        {Object.entries(PRESETS).map(([k, p]) => (
          <button key={k} onClick={() => onPreset(k)}
            className={`card p-3.5 text-left transition-all ${preset === k ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]' : 'hover:border-[var(--line)]'}`}>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold">{p.label}</span>
              {preset === k && <span className="badge badge-neutral">已选</span>}
            </div>
            <div className="text-[11px] text-[var(--muted)] mt-0.5">{p.desc}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div><label className="label">规格 (Spec)</label><textarea className="field h-48 mono text-[12px]" value={specYaml} onChange={(e) => setSpecYaml(e.target.value)} /></div>
        <div><label className="label">场景 (Scenario)</label><textarea className="field h-48 mono text-[12px]" value={scenarioYaml} onChange={(e) => setScenarioYaml(e.target.value)} /></div>
      </div>
      <div><label className="label">候选动作（每行一个 JSON 决策）</label><textarea className="field h-24 mono text-[12px]" value={candidates} onChange={(e) => setCandidates(e.target.value)} /></div>

      <div className="flex flex-wrap items-end gap-4">
        {(['iterations', 'groupSize', 'lr'] as const).map((k) => (
          <div key={k} className="w-24">
            <label className="label">{k}</label>
            <input className="field" value={k === 'iterations' ? iterations : k === 'groupSize' ? groupSize : lr}
              onChange={(e) => k === 'iterations' ? setIterations(e.target.value) : k === 'groupSize' ? setGroupSize(e.target.value) : setLr(e.target.value)} />
          </div>
        ))}
        <button onClick={onRun} className="btn btn-primary">开始训练</button>
        {status && <span className="text-[13px] text-[var(--muted)]">{status}</span>}
      </div>

      {rows.length > 0 && (
        <div className="card p-4">
          <h3 className="text-[13px] font-semibold mb-3">平均奖励 / 轮</h3>
          <div className="flex items-end gap-[2px] h-28">
            {rows.map((r, i) => (
              <div key={i} className="flex-1 rounded-t-sm bg-[var(--accent)] transition-all"
                style={{ height: `${Math.max((r.mean_reward / maxR) * 100, 2)}%`, opacity: 0.35 + 0.65 * (i / Math.max(rows.length - 1, 1)) }}
                title={`第 ${r.iteration} 轮：${r.mean_reward.toFixed(3)}`} />
            ))}
          </div>
        </div>
      )}

      {policy && (
        <div className="card p-4">
          <h3 className="text-[13px] font-semibold mb-3">学到的策略</h3>
          <div className="space-y-4">
            {Object.entries(policy).map(([fp, st]) => {
              const best = [...st.options].sort((a, b) => b.prob - a.prob)[0];
              const name = stateNames[fp] ?? '状态 ' + fp.slice(0, 8);
              return (
                <div key={fp}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[12px] font-semibold">{name}</span>
                    <span className="text-[11px] text-[var(--muted)]">首选：{(best && actionText(best.text).main) || '-'} {(best ? best.prob * 100 : 0).toFixed(0)}%</span>
                  </div>
                  <div className="space-y-1.5">
                    {st.options.map((o, i) => {
                      const at = actionText(o.text);
                      return (
                        <div key={i} className="flex items-center gap-3">
                          <div className="w-40 shrink-0 truncate text-[12px]" title={o.text}>{at.main}{at.sub && <span className="text-[var(--muted)]"> · {at.sub}</span>}</div>
                          <div className="flex-1 h-2 rounded-full bg-[#f1efe9] overflow-hidden">
                            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${o.prob * 100}%` }} />
                          </div>
                          <div className="w-12 text-right text-[11px] tnum shrink-0">{(o.prob * 100).toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}