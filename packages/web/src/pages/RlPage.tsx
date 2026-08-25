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

const PRESETS: Record<string, { spec: string; scenario: string; candidates: string; label: string }> = {
  insurance: { label: '换保单案例', spec: INSURANCE_SPEC, scenario: INSURANCE_SCENARIO, candidates: INSURANCE_CANDIDATES },
  echo: { label: 'echo demo', spec: ECHO_SPEC, scenario: ECHO_SCENARIO, candidates: ECHO_CANDIDATES },
};
const DEFAULT_PRESET = 'insurance';

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
    setRows([]); setPolicy(null); setStatus('training…');
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
            setStatus(`iteration ${msg.iteration}`);
          } else if (msg.type === 'done') setStatus(`done (${msg.iterations} iters, mean ${msg.final_mean_reward.toFixed(3)})`);
          else if (msg.type === 'error') setStatus(`error: ${msg.message}`);
        } catch { continue; }
      }
    }
  }

  const maxR = rows.length ? Math.max(...rows.map((r) => r.mean_reward), 1) : 1;

  return (
    <div className="space-y-4 max-w-4xl">
      <h2 className="text-xl font-semibold">RL train (GRPO)</h2>
      <select value={preset} onChange={(e) => onPreset(e.target.value)} className="border p-1 text-sm">
        {Object.entries(PRESETS).map(([k, p]) => (
          <option key={k} value={k}>{p.label}</option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="text-sm font-medium">Spec YAML</label><textarea className="w-full h-40 border font-mono text-sm p-2" value={specYaml} onChange={(e) => setSpecYaml(e.target.value)} /></div>
        <div><label className="text-sm font-medium">Scenario YAML</label><textarea className="w-full h-40 border font-mono text-sm p-2" value={scenarioYaml} onChange={(e) => setScenarioYaml(e.target.value)} /></div>
      </div>
      <div><label className="text-sm font-medium">Candidates (one JSON decision per line)</label><textarea className="w-full h-28 border font-mono text-sm p-2" value={candidates} onChange={(e) => setCandidates(e.target.value)} /></div>
      <div className="flex gap-4">
        <label className="text-sm">iterations <input className="border p-1 w-20" value={iterations} onChange={(e) => setIterations(e.target.value)} /></label>
        <label className="text-sm">groupSize <input className="border p-1 w-20" value={groupSize} onChange={(e) => setGroupSize(e.target.value)} /></label>
        <label className="text-sm">lr <input className="border p-1 w-20" value={lr} onChange={(e) => setLr(e.target.value)} /></label>
        <button onClick={onRun} className="bg-black text-white px-4 py-2 rounded">Train</button>
      </div>
      <p className="text-sm text-gray-600">{status}</p>

      {rows.length > 0 && (
        <div>
          <h3 className="font-semibold mb-1">mean_reward per iteration</h3>
          <div className="flex items-end gap-[2px] h-24 border">
            {rows.map((r, i) => (
              <div key={i} className="flex-1 bg-blue-500" style={{ height: `${(r.mean_reward / maxR) * 100}%` }} title={`iter ${r.iteration}: ${r.mean_reward.toFixed(3)}`} />
            ))}
          </div>
        </div>
      )}

      {policy && (
        <div>
          <h3 className="font-semibold mb-1">Policy</h3>
          {Object.entries(policy).map(([fp, st]) => (
            <div key={fp} className="mb-2 border p-2">
              <p className="text-xs font-mono text-gray-500">fp: {fp}</p>
              {st.options.map((o, i) => (
                <div key={i} className="flex justify-between text-sm font-mono">
                  <span>{o.text}</span>
                  <span>logit {o.logit.toFixed(2)} · prob {(o.prob * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
