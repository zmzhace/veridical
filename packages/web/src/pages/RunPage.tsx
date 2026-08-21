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
    setProgress('running…');
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
            setProgress(c != null && c !== '' ? `events: ${c}` : 'events');
          }
          if (msg.type === 'done') { nav(`/sessions/${msg.session_id}`); return; }
          if (msg.type === 'error') setProgress(`error: ${msg.message}`);
        } catch { continue; }
      }
    }
  }

  return (
    <div className="space-y-3 max-w-3xl">
      <h2 className="text-xl font-semibold">Run agent</h2>
      <textarea className="w-full h-48 border font-mono text-sm p-2" value={specYaml} onChange={(e) => setSpecYaml(e.target.value)} />
      <div className="flex gap-4 items-center">
        <label><input type="radio" checked={mode === 'mock'} onChange={() => setMode('mock')} /> Mock</label>
        <label><input type="radio" checked={mode === 'live'} onChange={() => setMode('live')} /> Live</label>
      </div>
      {mode === 'mock'
        ? <textarea className="w-full h-20 border font-mono text-sm p-2" value={script} onChange={(e) => setScript(e.target.value)} placeholder="JSON decision string" />
        : (<div className="grid grid-cols-3 gap-2">
            <input className="border p-2" placeholder="provider" value={provider} onChange={(e) => setProvider(e.target.value)} />
            <input className="border p-2" placeholder="model" value={model} onChange={(e) => setModel(e.target.value)} />
            <input className="border p-2" placeholder="apiKey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>)}
      <button onClick={onRun} disabled={run.isPending} className="bg-black text-white px-4 py-2 rounded disabled:opacity-50">Run</button>
      <p className="text-sm text-gray-600">{progress}</p>
    </div>
  );
}
