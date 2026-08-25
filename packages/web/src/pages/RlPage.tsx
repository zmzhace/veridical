import { useState } from 'react';

const DEFAULT_SPEC = `name: rl-demo
version: 1.0.0
schema_version: 1
instruction: { system: you are a bot }
flow: { mode: single-loop, max_steps: 1 }
llm: { provider: mock, model: m, fallback: [] }
tools:
  - name: echo
    access: allow
`;
const DEFAULT_SCENARIO = `name: pick-echo
spec: { name: rl-demo }
rules:
  - tool_called: echo
steps:
  - user: hello
`;
const DEFAULT_CANDIDATES = [
  JSON.stringify({ text: 'call echo', tool: { name: 'echo', args: { x: 1 } } }),
  JSON.stringify({ text: 'say hi', done: true }),
  JSON.stringify({ text: 'say bye', done: true }),
  JSON.stringify({ text: 'say nope', done: true }),
].join('\n');

export function RlPage() {
  const [specYaml, setSpecYaml] = useState(DEFAULT_SPEC);
  const [scenarioYaml, setScenarioYaml] = useState(DEFAULT_SCENARIO);
  const [candidates, setCandidates] = useState(DEFAULT_CANDIDATES);
  const [iterations, setIterations] = useState('20');
  const [groupSize, setGroupSize] = useState('8');
  const [lr, setLr] = useState('0.5');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<{ iteration: number; mean_reward: number; best_option: string }[]>([]);
  const [policy, setPolicy] = useState<Record<string, { options: { text: string; logit: number; prob: number }[] }> | null>(null);

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
