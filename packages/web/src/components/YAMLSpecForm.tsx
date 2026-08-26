import { useState } from 'react';
import { useAddSpec } from '../api/queries';

export function YAMLSpecForm({ onSaved }: { onSaved: () => void }) {
  const add = useAddSpec();
  const [yaml, setYaml] = useState('');
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    try { await add.mutateAsync(yaml); setYaml(''); onSaved(); }
    catch (e: any) { setErr(e?.message ?? '添加失败'); }
  }

  return (
    <div className="card p-4 mb-6 space-y-3">
      <label className="label">添加规格（粘贴 YAML）</label>
      <textarea className="field h-32 mono text-[12px]" value={yaml} onChange={e => setYaml(e.target.value)} placeholder="粘贴 YAML…" />
      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={submit} disabled={!yaml.trim() || add.isPending}>{add.isPending ? '添加中…' : '添加规格'}</button>
        {err && <span className="text-[12px] text-red-600">{err}</span>}
      </div>
    </div>
  );
}