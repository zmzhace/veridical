import { useState } from 'react';
import { useAddSpec } from '../api/queries';
import { formToYaml, type SpecFormState } from '../spec/formToYaml';

function blank(): SpecFormState {
  return {
    name: '', version: '0.1.0', schemaVersion: 1, description: '',
    system: '', llmProvider: '', llmModel: '', fallbacks: [],
    mode: 'single-loop', maxSteps: 10, stages: [], agents: [], tools: [],
  };
}

const ACCESS: Array<SpecFormState['tools'][number]['access']> = ['allow', 'deny', 'ask'];

export function SpecForm({ onSaved }: { onSaved: () => void }) {
  const add = useAddSpec();
  const [f, setF] = useState<SpecFormState>(blank);
  const [err, setErr] = useState('');
  const set = <K extends keyof SpecFormState>(k: K, v: SpecFormState[K]) => setF(p => ({ ...p, [k]: v }));

  const canSubmit = f.name.trim() && f.system.trim() && f.llmProvider.trim() && f.llmModel.trim();

  async function submit() {
    setErr('');
    try {
      await add.mutateAsync(formToYaml(f));
      setF(blank());
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? '添加失败');
    }
  }

  return (
    <div className="card p-4 mb-6 space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">名称 *</label>
          <input className="field" placeholder="规格名称（如 insurance-check）" value={f.name} onChange={e => set('name', e.target.value)} />
        </div>
        <div>
          <label className="label">版本</label>
          <input className="field mono" value={f.version} onChange={e => set('version', e.target.value)} />
        </div>
        <div>
          <label className="label">描述</label>
          <input className="field" placeholder="一句话描述" value={f.description} onChange={e => set('description', e.target.value)} />
        </div>
      </div>

      <div>
        <label className="label">人设指令 *</label>
        <textarea className="field h-24" placeholder="人设指令…" value={f.system} onChange={e => set('system', e.target.value)} />
      </div>

      <div className="space-y-3">
        <label className="label">LLM</label>
        <div className="grid grid-cols-2 gap-3">
          <input className="field" placeholder="provider（如 mock）" value={f.llmProvider} onChange={e => set('llmProvider', e.target.value)} />
          <input className="field" placeholder="model（如 deepseek-v4）" value={f.llmModel} onChange={e => set('llmModel', e.target.value)} />
        </div>
        {f.fallbacks.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className="field" placeholder="provider" value={r.provider} onChange={e => set('fallbacks', f.fallbacks.map((x, j) => j === i ? { ...x, provider: e.target.value } : x))} />
            <input className="field" placeholder="model" value={r.model} onChange={e => set('fallbacks', f.fallbacks.map((x, j) => j === i ? { ...x, model: e.target.value } : x))} />
            <button className="btn btn-ghost" onClick={() => set('fallbacks', f.fallbacks.filter((_, j) => j !== i))}>删除</button>
          </div>
        ))}
        <button className="btn btn-ghost" onClick={() => set('fallbacks', [...f.fallbacks, { provider: '', model: '' }])}>+ 添加 fallback</button>
      </div>

      <div className="space-y-3">
        <label className="label">流程</label>
        <div className="flex gap-2">
          {(['single-loop', 'supervisor', 'stage-gate'] as const).map(mode => (
            <button key={mode} className={`btn ${f.mode === mode ? 'btn-primary' : 'btn-ghost'}`} onClick={() => set('mode', mode)}>{mode}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">最大步数</label>
            <input className="field mono" type="number" value={f.maxSteps} onChange={e => set('maxSteps', Number(e.target.value) || 1)} />
          </div>
        </div>
        {f.mode === 'stage-gate' && (
          <div className="space-y-2">
            {f.stages.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className="field" placeholder="阶段 id（如 s1）" value={s.id} onChange={e => set('stages', f.stages.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} />
                <input className="field" placeholder="门控工具名" value={s.tool} onChange={e => set('stages', f.stages.map((x, j) => j === i ? { ...x, tool: e.target.value } : x))} />
                <button className="btn btn-ghost" onClick={() => set('stages', f.stages.filter((_, j) => j !== i))}>删除</button>
              </div>
            ))}
            <button className="btn btn-ghost" onClick={() => set('stages', [...f.stages, { id: `s${f.stages.length + 1}`, tool: '' }])}>+ 添加阶段</button>
          </div>
        )}
        {f.mode === 'supervisor' && (
          <div className="space-y-2">
            {f.agents.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className="field" placeholder="专家名" value={a.name} onChange={e => set('agents', f.agents.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input className="field" placeholder="规格引用" value={a.specRef} onChange={e => set('agents', f.agents.map((x, j) => j === i ? { ...x, specRef: e.target.value } : x))} />
                <input className="field" placeholder="when 条件" value={a.when} onChange={e => set('agents', f.agents.map((x, j) => j === i ? { ...x, when: e.target.value } : x))} />
                <button className="btn btn-ghost" onClick={() => set('agents', f.agents.filter((_, j) => j !== i))}>删除</button>
              </div>
            ))}
            <button className="btn btn-ghost" onClick={() => set('agents', [...f.agents, { name: '', specRef: '', when: '' }])}>+ 添加专家</button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="label">工具</label>
        {f.tools.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className="field" placeholder="工具名" value={t.name} onChange={e => set('tools', f.tools.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <select className="field" value={t.access} onChange={e => set('tools', f.tools.map((x, j) => j === i ? { ...x, access: e.target.value as typeof t.access } : x))}>
              {ACCESS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <label className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
              <input type="checkbox" checked={t.deterministic} onChange={e => set('tools', f.tools.map((x, j) => j === i ? { ...x, deterministic: e.target.checked } : x))} />
              确定性
            </label>
            <button className="btn btn-ghost" onClick={() => set('tools', f.tools.filter((_, j) => j !== i))}>删除</button>
          </div>
        ))}
        <button className="btn btn-ghost" onClick={() => set('tools', [...f.tools, { name: '', access: 'allow', deterministic: false }])}>+ 添加工具</button>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={submit} disabled={!canSubmit || add.isPending}>{add.isPending ? '添加中…' : '添加规格'}</button>
        {err && <span className="text-[12px] text-red-600" data-testid="spec-form-error">{err}</span>}
      </div>
    </div>
  );
}