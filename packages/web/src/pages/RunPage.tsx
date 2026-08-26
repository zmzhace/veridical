import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRun } from '../api/queries';

const DEFAULT_SPEC = `name: demo
version: 1.0.0
schema_version: 1
instruction:
  system: you are a bot
flow:
  mode: single-loop
  max_steps: 2
llm:
  provider: mock
  model: m
  fallback: []
tools:
  - name: echo
    access: allow
`;

export function RunPage() {
  const [specYaml, setSpecYaml] = useState(DEFAULT_SPEC);
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [script, setScript] = useState(JSON.stringify({ text: 'done', done: true }));
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('gpt-4o-mini');
  const [apiKey, setApiKey] = useState('');
  const [progress, setProgress] = useState<string>('');
  const nav = useNavigate();
  const run = useRun();

  async function onRun() {
    setProgress('运行中…');
    const res = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mode === 'mock' ? { specYaml, mode, script: [script] } : { specYaml, mode, provider, model, apiKey }) });
    const reader = res.body!.getReader(); const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(trimmed.replace(/^data:\s*/, ''));
          if (msg.type === 'progress' || msg.type === 'event') {
            const c = msg.count ?? msg.event?.seq;
            setProgress(c != null && c !== '' ? `已产生 ${c} 个事件…` : '运行中…');
          }
          if (msg.type === 'done') { nav(`/sessions/${msg.session_id}`); return; }
          if (msg.type === 'error') setProgress(`出错：${msg.message}`);
        } catch { continue; }
      }
    }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h2 className="page-title">运行 agent</h2>
        <p className="page-desc">定义一份规格（人设 + 工具 + 流程），然后跑一次，系统会记录完整轨迹。</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(['mock', 'live'] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={`card p-4 text-left transition-all ${mode === m ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]' : 'hover:border-[var(--line)]'}`}>
            <div className="text-[13px] font-semibold">{m === 'mock' ? '模拟运行' : '接入真实模型'}</div>
            <div className="text-[11px] text-[var(--muted)] mt-0.5">{m === 'mock' ? '用脚本决策串模拟，快且免费' : '调用 OpenAI 兼容接口，需 API Key'}</div>
          </button>
        ))}
      </div>

      <div>
        <label className="label">规格 (Spec)</label>
        <textarea className="field h-44 mono text-[12px]" value={specYaml} onChange={(e) => setSpecYaml(e.target.value)} />
      </div>

      {mode === 'mock' ? (
        <div>
          <label className="label">模拟决策（每行一个 JSON）</label>
          <textarea className="field h-16 mono text-[12px]" value={script} onChange={(e) => setScript(e.target.value)} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <div><label className="label">Provider</label><input className="field" value={provider} onChange={(e) => setProvider(e.target.value)} /></div>
          <div><label className="label">Model</label><input className="field" value={model} onChange={(e) => setModel(e.target.value)} /></div>
          <div><label className="label">API Key</label><input className="field" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onRun} disabled={run.isPending} className="btn btn-primary">
          {run.isPending ? '运行中…' : '开始运行'}
        </button>
        {progress && <span className="text-[13px] text-[var(--muted)]">{progress}</span>}
      </div>
    </div>
  );
}