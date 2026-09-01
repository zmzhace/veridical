import { cloneElement, useEffect, useState, type ReactElement } from 'react';
import { useAddSpec, useSkills } from '../api/queries';
import { useBlocker, useInRouterContext } from 'react-router-dom';
import {
  blankSpec,
  editorYaml,
  formToSpec,
  readEditorYaml,
  recommendSkills,
  starterSkills,
  specToForm,
  suggestTools,
  validateSpec,
  type AgentSpec,
  type FieldErrors,
} from '../spec/editor';
import type { SpecFormState } from '../spec/formToYaml';

const sections = ['基础信息', '模型与指令', '工具权限', '运行流程'];
const sectionFor = (path: string) =>
  path.startsWith('llm') || path.startsWith('instruction')
    ? 1
    : path.startsWith('tools')
      ? 2
      : path.startsWith('flow') || path.startsWith('agents')
        ? 3
        : 0;
const modeNames = { 'single-loop': '单循环', supervisor: '主管编排', 'stage-gate': '阶段门控' };

function RouteGuard({ dirty, busy }: { dirty: boolean; busy: boolean }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (dirty || busy) && currentLocation.pathname !== nextLocation.pathname,
  );
  if (blocker.state !== 'blocked') return null;
  return (
    <div className="spec-discard" role="alert">
      <div>
        <strong>{busy ? '正在注册，请稍候' : '离开前要保留这份草稿吗？'}</strong>
        <p>{busy ? '完成后再离开，避免无法确认保存结果。' : '离开配置页面会丢失未保存的修改。'}</p>
      </div>
      <button type="button" className="btn btn-ghost" onClick={() => blocker.reset()}>
        留在此页
      </button>
      <button
        type="button"
        disabled={busy}
        className="btn btn-danger"
        onClick={() => blocker.proceed()}
      >
        丢弃并离开
      </button>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}) {
  return (
    <div className="spec-field">
      <label className="label" htmlFor={`spec-${id}`}>
        {label}
      </label>
      {cloneElement(children, { 'aria-describedby': hint || error ? `hint-${id}` : undefined })}
      {(hint || error) && (
        <p id={`hint-${id}`} className={error ? 'field-error' : 'field-hint'}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function SpecForm({
  onSaved,
  initial,
  onDirtyChange,
  onBusyChange,
}: {
  onSaved: (spec?: AgentSpec) => void;
  initial?: AgentSpec;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const add = useAddSpec();
  const skillQuery = useSkills();
  const remoteSkills = Array.isArray(skillQuery.data) ? skillQuery.data : [];
  const skillCatalog = [...starterSkills, ...remoteSkills].map((skill) => ({ ...skill, tags: skill.tags ?? [] })).filter((skill, index, all) => all.findIndex((item) => item.name === skill.name) === index);
  const inRouter = useInRouterContext();
  const [f, setF] = useState<SpecFormState>(() => (initial ? specToForm(initial) : blankSpec()));
  const [baseline, setBaseline] = useState(() => JSON.stringify(f));
  const [section, setSection] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yaml, setYaml] = useState('');
  const [generated, setGenerated] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState('');
  const [status, setStatus] = useState('');
  const dirty = JSON.stringify(f) !== baseline || (mode === 'yaml' && yaml !== generated);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(add.isPending);
  }, [add.isPending, onBusyChange]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (dirty || add.isPending) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty, add.isPending]);
  const set = <K extends keyof SpecFormState>(key: K, value: SpecFormState[K]) => {
    setF((prev) => ({ ...prev, [key]: value }));
    setStatus('');
    setServerError('');
    setErrors({});
  };
  const attrs = (path: string) => ({
    id: `spec-${path}`,
    'aria-invalid': !!errors[path],
    'aria-describedby': `hint-${path}`,
  });
  const input = (
    key: 'name' | 'version' | 'description' | 'llmProvider' | 'llmModel',
    path: string,
    label: string,
    placeholder: string,
    hint?: string,
  ) => (
    <Field id={path} label={label} hint={hint} error={errors[path]}>
      <input
        {...attrs(path)}
        className="field"
        value={f[key]}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </Field>
  );

  function switchMode(next: 'form' | 'yaml') {
    if (next === mode) return;
    if (next === 'yaml') {
      const text = editorYaml(f);
      setYaml(text);
      setGenerated(text);
    } else if (yaml !== generated) {
      const result = readEditorYaml(yaml);
      if (!result.spec || Object.keys(result.errors).length) {
        setErrors(result.errors);
        return;
      }
      setF(specToForm(result.spec));
    }
    setErrors({});
    setMode(next);
    setStatus('');
  }

  async function submit() {
    if (add.isPending) return;
    setServerError('');
    setStatus('');
    const result = mode === 'yaml' ? readEditorYaml(yaml) : validateSpec(formToSpec(f));
    setErrors(result.errors);
    const first = Object.keys(result.errors)[0];
    if (first || !result.spec) {
      if (mode === 'form') setSection(sectionFor(first ?? 'name'));
      return;
    }
    try {
      await add.mutateAsync(mode === 'yaml' ? yaml : editorYaml(f));
      const empty = blankSpec();
      setF(empty);
      setBaseline(JSON.stringify(empty));
      setYaml('');
      setGenerated('');
      setMode('form');
      setSection(0);
      setStatus(`${result.spec.name} · v${result.spec.version} 已注册。`);
      onSaved(result.spec);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : '注册失败，请稍后重试。');
    }
  }

  async function copyYaml() {
    try {
      await navigator.clipboard.writeText(mode === 'yaml' ? yaml : editorYaml(f));
      setStatus('YAML 已复制。');
    } catch {
      setStatus('复制不可用，请切换到 YAML 后手动复制。');
    }
  }

  function autoAddTools() {
    const suggested = suggestTools(`${f.description} ${f.system}`);
    const existing = new Set(f.tools.map((tool) => tool.name));
    const additions = suggested.filter((tool) => !existing.has(tool.name));
    set('tools', [...f.tools, ...additions]);
    setStatus(
      additions.length
        ? `已根据任务添加 ${additions.map((tool) => tool.name).join('、')}。请确认权限。`
        : '当前任务没有新的工具建议。',
    );
  }

  function autoAddSkills() {
    const recommended = recommendSkills(`${f.description} ${f.system}`);
    const existing = new Set(f.skills.map((skill) => skill.name));
    const additions = recommended.filter((skill) => !existing.has(skill.name));
    set('skills', [...f.skills, ...additions.map((skill) => ({ ...skill, tags: [...skill.tags] }))]);
    setStatus(additions.length ? `已推荐 ${additions.map((skill) => skill.name).join('、')}，请确认后保存。` : '当前任务没有新的能力包建议。');
  }

  return (
    <div className="spec-editor">
      {inRouter && <RouteGuard dirty={dirty} busy={add.isPending} />}
      <header className="spec-editor-heading">
        <div>
          <h3>{initial ? '创建新版本' : '新建规格'}</h3>
          <p>
            {initial
              ? `${initial.name} · 独立保存，不覆盖原版本`
              : '定义 Agent 的目标、模型与执行边界。'}
          </p>
        </div>
        <span className={`spec-draft ${dirty ? 'is-dirty' : ''}`}>
          {dirty ? '未保存的草稿' : '草稿'}
        </span>
      </header>
      <fieldset disabled={add.isPending} className="spec-editor-controls">
        <div className="spec-mode-bar">
          <div className="spec-segment" aria-label="编辑方式">
            <button type="button" aria-pressed={mode === 'form'} onClick={() => switchMode('form')}>
              表单配置
            </button>
            <button type="button" aria-pressed={mode === 'yaml'} onClick={() => switchMode('yaml')}>
              粘贴 YAML
            </button>
          </div>
          {mode === 'form' && (
            <button
              type="button"
              className="spec-text-button"
              onClick={() => setAdvanced((value) => !value)}
            >
              {advanced ? '使用快速配置' : '完整配置'}
            </button>
          )}
          <button type="button" className="spec-text-button" onClick={copyYaml}>
            复制 YAML
          </button>
        </div>
        {mode === 'form' && (
          <nav className="spec-section-nav" aria-label="配置分区">
            {sections.map((title, i) => (
              <button
                type="button"
                key={title}
                aria-current={section === i ? 'step' : undefined}
                onClick={() => {
                  setSection(i);
                  setAdvanced(true);
                }}
              >
                {title}
                {Object.keys(errors).some((p) => sectionFor(p) === i) && (
                  <span className="spec-error-dot" aria-label="存在错误" />
                )}
              </button>
            ))}
          </nav>
        )}
        <div className="spec-editor-body">
          {(Object.keys(errors).length > 0 || serverError) && (
            <div className="spec-error-panel" role="alert" data-testid="spec-form-error">
              <strong>{serverError ? '未能注册，草稿已保留' : '请先修正配置'}</strong>
              {serverError ? (
                <p>{serverError}</p>
              ) : (
                <ul>
                  {Object.entries(errors).map(([path, message]) => (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => {
                          if (mode === 'form') {
                            setSection(sectionFor(path));
                            requestAnimationFrame(() =>
                              document.getElementById(`spec-${path}`)?.focus(),
                            );
                          }
                        }}
                      >
                        {path}：{message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {mode === 'yaml' ? (
            <div>
              <label className="label" htmlFor="spec-yaml">
                规格 YAML
              </label>
              <p className="field-hint mb-3">
                与表单共享同一份配置。切回表单前会校验全部字段；重新生成 YAML
                会规范格式，不保留注释。
              </p>
              <textarea
                id="spec-yaml"
                className="field mono spec-yaml"
                placeholder="粘贴 YAML…"
                value={yaml}
                onChange={(e) => {
                  setYaml(e.target.value);
                  setErrors({});
                  setServerError('');
                  setStatus('');
                }}
                spellCheck={false}
                aria-invalid={Object.keys(errors).length > 0}
              />
            </div>
          ) : !advanced ? (
            <section className="spec-quick" aria-label="快速配置">
              <div className="spec-section-title">
                <h4>三步创建一个可运行的 Agent</h4>
                <p>先填这四项就可以注册。工具、流程和 fallback 可以稍后再配置。</p>
              </div>
              <div className="spec-grid">
                {input('name', 'name', '规格名称 *', '规格名称（如 insurance-check）')}
                {input('version', 'version', '版本 *', '0.1.0')}
              </div>
              {input('description', 'description', '用途描述', '例如：回答售后问题并查询订单')}
              <div className="spec-quick-skills" aria-label="能力包">
                <div className="spec-quick-divider"><span>能力包 <em className="spec-optional">可选</em></span></div>
                <div className="spec-skill-heading">
                  <div><strong>给 Agent 一组可复用的做事方法</strong><p className="field-hint">能力包只补充行为指引，不会自动获得工具权限。</p></div>
                  <button type="button" className="btn btn-ghost" onClick={autoAddSkills}>根据任务推荐</button>
                </div>
                <div className="spec-skill-catalog">
                  {skillCatalog.map((skill) => {
                    const selected = f.skills.some((item) => item.name === skill.name);
                    return <button type="button" key={skill.name} className={`spec-skill-card ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={() => set('skills', selected ? f.skills.filter((item) => item.name !== skill.name) : [...f.skills, { ...skill, tags: [...skill.tags] }])}>
                      <span className="spec-skill-check" aria-hidden="true">{selected ? '✓' : '+'}</span><strong>{skill.name}</strong><span>{skill.description}</span><small>{skill.tags.join(' · ')}</small>
                    </button>;
                  })}
                </div>
                {f.skills.length > 0 && <p className="field-hint">已选择：{f.skills.map((skill) => skill.name).join('、')}。可在“完整配置”中编辑细节。</p>}
              </div>
              <div className="spec-task-type">
                <div className="spec-quick-divider">
                  <span>任务形态</span>
                </div>
                <p className="field-hint spec-task-hint">
                  先选 Agent 如何完成任务，后面的配置会按这个选择展开。
                </p>
                <div className="spec-task-options" role="radiogroup" aria-label="任务形态">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={f.mode === 'single-loop'}
                    className={f.mode === 'single-loop' ? 'is-selected' : ''}
                    onClick={() => set('mode', 'single-loop')}
                  >
                    <strong>开放任务</strong>
                    <span>一个 Agent 自主完成目标</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={f.mode === 'supervisor'}
                    className={f.mode === 'supervisor' ? 'is-selected' : ''}
                    onClick={() => set('mode', 'supervisor')}
                  >
                    <strong>多 Agent 协作</strong>
                    <span>由主管分配给多个子 Agent</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={f.mode === 'stage-gate'}
                    className={f.mode === 'stage-gate' ? 'is-selected' : ''}
                    onClick={() => set('mode', 'stage-gate')}
                  >
                    <strong>分阶段任务</strong>
                    <span>按阶段和门控条件推进</span>
                  </button>
                </div>
              </div>
              {f.mode === 'supervisor' && (
                <div className="spec-quick-agents">
                  <div className="spec-subheading">
                    <h4>
                      子 Agent <span className="spec-optional">至少一个</span>
                    </h4>
                    <span>保存时自动生成内部规格</span>
                  </div>
                  <p className="field-hint">
                    每个子 Agent 只需要一个角色和一句职责说明；底层 Spec 会自动生成并保留版本。
                  </p>
                  {f.agents.map((a, i) => (
                    <div className="spec-quick-agent" key={i}>
                      <Field
                        id={`agents.${i}.name`}
                        label={`子 Agent ${i + 1} · 角色`}
                        error={errors[`agents.${i}.name`]}
                      >
                        <input
                          {...attrs(`agents.${i}.name`)}
                          className="field"
                          placeholder="例如：订单查询专家"
                          value={a.name}
                          onChange={(e) =>
                            set(
                              'agents',
                              f.agents.map((x, j) =>
                                j === i ? { ...x, name: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field
                        id={`agents.${i}.system`}
                        label="它要负责什么？"
                        hint="不用写 Spec 名称，保存时会自动生成内部 Agent 规格。"
                      >
                        <textarea
                          {...attrs(`agents.${i}.system`)}
                          className="field spec-agent-prompt"
                          placeholder="例如：检查订单状态，发现异常时说明原因。"
                          value={a.system ?? ''}
                          onChange={(e) =>
                            set(
                              'agents',
                              f.agents.map((x, j) =>
                                j === i ? { ...x, system: e.target.value } : x,
                              ),
                            )
                          }
                        />
                      </Field>
                      <button
                        type="button"
                        className="spec-remove"
                        aria-label={`删除子 Agent ${i + 1}`}
                        onClick={() =>
                          set(
                            'agents',
                            f.agents.filter((_, j) => j !== i),
                          )
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      set('agents', [...f.agents, { name: '', specRef: '', when: '' }])
                    }
                  >
                    + 添加子 Agent
                  </button>
                </div>
              )}
              <div className="spec-quick-divider">
                <span>模型</span>
              </div>
              <div className="spec-grid">
                {input('llmProvider', 'llm.provider', 'Provider *', 'provider（如 mock）')}
                {input('llmModel', 'llm.model', '模型 *', 'model（如 deepseek-v4）')}
              </div>
              <Field
                id="instruction.system"
                label="系统指令 *"
                hint="用自然语言写任务目标、语气和不能做的事情。"
                error={errors['instruction.system']}
              >
                <textarea
                  {...attrs('instruction.system')}
                  className="field spec-prompt"
                  placeholder="人设指令…"
                  value={f.system}
                  onChange={(e) => set('system', e.target.value)}
                />
              </Field>
              <div className="spec-quick-tools">
                <div className="spec-subheading">
                  <h4>
                    工具权限 <span className="spec-optional">可选</span>
                  </h4>
                  <button type="button" className="spec-text-button" onClick={autoAddTools}>
                    根据任务自动添加
                  </button>
                </div>
                <p className="field-hint">
                  自动添加的是 Spec 中的工具声明；真正执行能力仍需在服务端注册。
                </p>
                {!f.tools.length && (
                  <p className="spec-inline-note">不需要调用外部工具？保持空白即可。</p>
                )}
                {f.tools.map((t, i) => (
                  <div className="spec-quick-tool" key={i}>
                    <Field
                      id={`quick.tools.${i}.name`}
                      label={`工具 ${i + 1}`}
                      error={errors[`tools.${i}.name`]}
                    >
                      <input
                        {...attrs(`tools.${i}.name`)}
                        className="field"
                        placeholder="工具名"
                        value={t.name}
                        onChange={(e) =>
                          set(
                            'tools',
                            f.tools.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                          )
                        }
                      />
                    </Field>
                    <Field id={`quick.tools.${i}.access`} label="权限">
                      <select
                        {...attrs(`quick.tools.${i}.access`)}
                        className="field"
                        value={t.access}
                        onChange={(e) =>
                          set(
                            'tools',
                            f.tools.map((x, j) =>
                              j === i ? { ...x, access: e.target.value as typeof t.access } : x,
                            ),
                          )
                        }
                      >
                        <option value="allow">允许调用</option>
                        <option value="deny">拒绝调用</option>
                        <option value="ask">运行时询问</option>
                      </select>
                    </Field>
                    <button
                      type="button"
                      className="spec-remove"
                      aria-label={`删除工具 ${i + 1}`}
                      onClick={() =>
                        set(
                          'tools',
                          f.tools.filter((_, j) => j !== i),
                        )
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    set('tools', [...f.tools, { name: '', access: 'deny', deterministic: false }]);
                    setSection(2);
                    setAdvanced(true);
                  }}
                >
                  + 添加工具
                </button>
              </div>
              <div className="spec-quick-advanced">
                <strong>需要主管编排、阶段门控或备用模型？</strong>
                <button
                  type="button"
                  className="spec-text-button"
                  onClick={() => setAdvanced(true)}
                >
                  打开完整配置 →
                </button>
              </div>
            </section>
          ) : (
            <>
              <section hidden={section !== 0} aria-label="基础信息">
                <div className="spec-section-title">
                  <h4>给这个 Agent 一个明确的身份</h4>
                  <p>名称与版本共同标识一份不可覆盖的规格。</p>
                </div>
                <div className="spec-grid">
                  {input(
                    'name',
                    'name',
                    '规格名称 *',
                    '规格名称（如 insurance-check）',
                    '使用稳定的英文标识，方便运行与审计引用。',
                  )}
                  {input(
                    'version',
                    'version',
                    '版本 *',
                    '0.1.0',
                    '语义化版本，例如 1.0.0。已有版本不能重复注册。',
                  )}
                </div>
                {input(
                  'description',
                  'description',
                  '用途描述',
                  '一句话描述',
                  '告诉协作者它负责什么，以及何时应该使用。',
                )}
                <div className="spec-grid">
                  <Field
                    id="schema_version"
                    label="Schema 版本 *"
                    hint="当前规格结构使用版本 1。"
                    error={errors.schema_version}
                  >
                    <input
                      {...attrs('schema_version')}
                      className="field"
                      type="number"
                      min="1"
                      step="1"
                      value={Number.isNaN(f.schemaVersion) ? '' : f.schemaVersion}
                      onChange={(e) => set('schemaVersion', e.target.valueAsNumber)}
                    />
                  </Field>
                </div>
                <div className="spec-note">
                  <strong>配置保存到哪里？</strong>
                  <p>
                    注册到当前服务的本地规格库。本页不会触发评测、审批或生产部署，也不会调用模型。
                  </p>
                </div>
              </section>
              <section hidden={section !== 1} aria-label="模型与指令">
                <div className="spec-section-title">
                  <h4>选择模型，写清行为边界</h4>
                  <p>Provider 必须由运行服务注册；填写模型名称不等于已经连通模型。</p>
                </div>
                <div className="spec-grid">
                  {input('llmProvider', 'llm.provider', 'Provider *', 'provider（如 mock）')}
                  {input('llmModel', 'llm.model', '模型 *', 'model（如 deepseek-v4）')}
                </div>
                <p className="spec-inline-note">
                  API Key 只保存在服务端环境变量中，不要写入规格或系统指令。
                </p>
                <Field
                  id="instruction.system"
                  label="系统指令 *"
                  hint="建议包含：任务目标、可用工具、输出格式、禁止事项与结束条件。"
                  error={errors['instruction.system']}
                >
                  <textarea
                    {...attrs('instruction.system')}
                    className="field spec-prompt"
                    placeholder="人设指令…"
                    value={f.system}
                    onChange={(e) => set('system', e.target.value)}
                  />
                </Field>
                <div className="spec-subheading"><h4>输出格式</h4><span>让结果更容易被应用消费</span></div>
                <div className="spec-grid">
                  <Field id="output.profile" label="结果类型" hint="对话适合 markdown；结构化结果会在运行时校验。">
                    <select className="field" value={f.outputProfile ?? 'conversational'} onChange={(e) => set('outputProfile', e.target.value as SpecFormState['outputProfile'])}>
                      <option value="conversational">对话回复</option><option value="report">报告</option><option value="structured">结构化 JSON</option><option value="artifact">产物</option>
                    </select>
                  </Field>
                  <Field id="output.strict" label="严格校验">
                    <select className="field" value={f.outputStrict === false ? 'false' : 'true'} onChange={(e) => set('outputStrict', e.target.value === 'true')}>
                      <option value="true">开启（推荐）</option><option value="false">宽松</option>
                    </select>
                  </Field>
                </div>
                <div className="spec-subheading">
                  <h4>能力包</h4><span>{f.skills.length ? `${f.skills.length} 个已启用` : '可选'}</span>
                </div>
                {f.skills.map((skill, i) => (
                  <div className="spec-skill-edit" key={`${skill.name}-${i}`}>
                    <input className="field" aria-label={`能力包 ${i + 1} 名称`} value={skill.name} onChange={(e) => set('skills', f.skills.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <textarea className="field" aria-label={`能力包 ${i + 1} 执行要点`} placeholder="执行要点（可选）" value={skill.procedure} onChange={(e) => set('skills', f.skills.map((x, j) => j === i ? { ...x, procedure: e.target.value } : x))} />
                    <button type="button" className="spec-remove" onClick={() => set('skills', f.skills.filter((_, j) => j !== i))}>删除</button>
                  </div>
                ))}
                <button type="button" className="btn btn-ghost" onClick={() => set('skills', [...f.skills, { name: '', description: '', procedure: '', tags: [] }])}>+ 添加自定义能力包</button>
                <div className="spec-subheading">
                  <h4>备用模型</h4>
                  <span>按顺序尝试</span>
                </div>
                {!f.fallbacks.length && (
                  <p className="spec-inline-note">尚未配置备用模型。模型不可用时不会自动切换。</p>
                )}
                {f.fallbacks.map((r, i) => (
                  <div className="spec-row" key={i}>
                    <Field
                      id={`llm.fallback.${i}.provider`}
                      label={`备用 ${i + 1} · Provider`}
                      error={errors[`llm.fallback.${i}.provider`]}
                    >
                      <input
                        {...attrs(`llm.fallback.${i}.provider`)}
                        className="field"
                        value={r.provider}
                        onChange={(e) =>
                          set(
                            'fallbacks',
                            f.fallbacks.map((x, j) =>
                              j === i ? { ...x, provider: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field
                      id={`llm.fallback.${i}.model`}
                      label="模型"
                      error={errors[`llm.fallback.${i}.model`]}
                    >
                      <input
                        {...attrs(`llm.fallback.${i}.model`)}
                        className="field"
                        value={r.model}
                        onChange={(e) =>
                          set(
                            'fallbacks',
                            f.fallbacks.map((x, j) =>
                              j === i ? { ...x, model: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </Field>
                    <button
                      className="spec-remove"
                      type="button"
                      aria-label={`删除备用模型 ${i + 1}`}
                      onClick={() =>
                        set(
                          'fallbacks',
                          f.fallbacks.filter((_, j) => j !== i),
                        )
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => set('fallbacks', [...f.fallbacks, { provider: '', model: '' }])}
                >
                  + 添加 fallback
                </button>
              </section>
              <section hidden={section !== 2} aria-label="工具权限">
                <div className="spec-section-title">
                  <h4>只开放任务需要的工具</h4>
                  <p>声明工具权限不会安装工具；工具名称必须与服务端注册项一致。</p>
                </div>
                <div className="spec-permission-key">
                  <span>
                    <b>允许</b> 可以调用
                  </span>
                  <span>
                    <b>拒绝</b> 阻止调用
                  </span>
                  <span>
                    <b>询问</b> 需要运行时审批支持
                  </span>
                </div>
                {!f.tools.length && (
                  <div className="spec-empty-inline">
                    <h4>还没有工具</h4>
                    <p>可以保留为空，让 Agent 仅生成文本；需要执行操作时再添加。</p>
                  </div>
                )}
                {f.tools.map((t, i) => (
                  <div className="spec-tool-row" key={i}>
                    <Field
                      id={`tools.${i}.name`}
                      label={`工具 ${i + 1} · 名称`}
                      error={errors[`tools.${i}.name`]}
                    >
                      <input
                        {...attrs(`tools.${i}.name`)}
                        className="field"
                        placeholder="工具名"
                        value={t.name}
                        onChange={(e) =>
                          set(
                            'tools',
                            f.tools.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                          )
                        }
                      />
                    </Field>
                    <Field id={`tools.${i}.access`} label="调用权限">
                      <select
                        {...attrs(`tools.${i}.access`)}
                        className="field"
                        value={t.access}
                        onChange={(e) =>
                          set(
                            'tools',
                            f.tools.map((x, j) =>
                              j === i ? { ...x, access: e.target.value as typeof t.access } : x,
                            ),
                          )
                        }
                      >
                        <option value="allow">允许 · allow</option>
                        <option value="deny">拒绝 · deny</option>
                        <option value="ask">询问 · ask</option>
                      </select>
                    </Field>
                    <label className="spec-checkbox">
                      <input
                        type="checkbox"
                        checked={t.deterministic}
                        onChange={(e) =>
                          set(
                            'tools',
                            f.tools.map((x, j) =>
                              j === i ? { ...x, deterministic: e.target.checked } : x,
                            ),
                          )
                        }
                      />
                      确定性
                    </label>
                    <button
                      className="spec-remove"
                      type="button"
                      aria-label={`删除工具 ${i + 1}`}
                      onClick={() =>
                        set(
                          'tools',
                          f.tools.filter((_, j) => j !== i),
                        )
                      }
                    >
                      删除
                    </button>
                  </div>
                ))}
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() =>
                    set('tools', [...f.tools, { name: '', access: 'deny', deterministic: false }])
                  }
                >
                  + 添加工具
                </button>
                <p className="field-hint mt-3">
                  新增工具默认拒绝。确定性表示相同输入应产生相同结果；这是声明，不是自动验证。
                </p>
              </section>
              <section hidden={section !== 3} aria-label="运行流程">
                <div className="spec-section-title">
                  <h4>选择执行方式，限制运行范围</h4>
                  <p>流程控制决定 Agent 如何推进任务、何时交接与停止。</p>
                </div>
                <Field id="flow.mode" label="执行方式">
                  <select
                    {...attrs('flow.mode')}
                    className="field"
                    value={f.mode}
                    onChange={(e) => set('mode', e.target.value as SpecFormState['mode'])}
                  >
                    {Object.entries(modeNames).map(([value, label]) => (
                      <option value={value} key={value}>
                        {label} · {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="spec-grid">
                  <Field
                    id="flow.max_steps"
                    label="最大步数 *"
                    hint="正整数。达到上限后停止，避免无限循环。"
                    error={errors['flow.max_steps']}
                  >
                    <input
                      {...attrs('flow.max_steps')}
                      type="number"
                      min="1"
                      step="1"
                      className="field"
                      value={Number.isNaN(f.maxSteps) ? '' : f.maxSteps}
                      onChange={(e) => set('maxSteps', e.target.valueAsNumber)}
                    />
                  </Field>
                </div>
                {f.mode === 'single-loop' && (
                  <div className="spec-note">
                    <strong>单循环</strong>
                    <p>模型决策、工具执行、结果反馈，重复推进直到完成或达到步数上限。</p>
                  </div>
                )}
                {f.mode === 'stage-gate' && (
                  <>
                    <div className="spec-subheading">
                      <h4>阶段与门控</h4>
                      <span>按列表顺序推进</span>
                    </div>
                    <p className="field-hint">
                      每阶段需要唯一 ID。可选门控工具必须先在工具权限中声明。
                    </p>
                    {f.stages.map((s, i) => (
                      <div className="spec-row" key={i}>
                        <Field
                          id={`flow.stages.${i}.id`}
                          label={`阶段 ${i + 1} · ID`}
                          error={errors[`flow.stages.${i}.id`]}
                        >
                          <input
                            {...attrs(`flow.stages.${i}.id`)}
                            className="field"
                            value={s.id}
                            onChange={(e) =>
                              set(
                                'stages',
                                f.stages.map((x, j) =>
                                  j === i ? { ...x, id: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </Field>
                        <Field id={`flow.stages.${i}.gate.tool_called`} label="门控工具">
                          <select
                            {...attrs(`flow.stages.${i}.gate.tool_called`)}
                            className="field"
                            value={s.tool}
                            onChange={(e) =>
                              set(
                                'stages',
                                f.stages.map((x, j) =>
                                  j === i ? { ...x, tool: e.target.value } : x,
                                ),
                              )
                            }
                          >
                            <option value="">不设置门控</option>
                            {s.tool && !f.tools.some((t) => t.name === s.tool) && (
                              <option value={s.tool}>{s.tool}（未声明）</option>
                            )}
                            {f.tools
                              .filter((t) => t.name)
                              .map((t, j) => (
                                <option key={j} value={t.name}>
                                  {t.name}
                                  {t.access === 'deny' ? '（已拒绝）' : ''}
                                </option>
                              ))}
                          </select>
                        </Field>
                        <button
                          className="spec-remove"
                          type="button"
                          aria-label={`删除阶段 ${i + 1}`}
                          onClick={() =>
                            set(
                              'stages',
                              f.stages.filter((_, j) => j !== i),
                            )
                          }
                        >
                          删除
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        let n = f.stages.length + 1;
                        while (f.stages.some((s) => s.id === `stage-${n}`)) n++;
                        set('stages', [...f.stages, { id: `stage-${n}`, tool: '' }]);
                      }}
                    >
                      + 添加阶段
                    </button>
                  </>
                )}
                {f.mode === 'supervisor' && (
                  <>
                    <div className="spec-subheading">
                      <h4>专家分工</h4>
                      <span>至少一个专家</span>
                    </div>
                    {f.agents.map((a, i) => (
                      <div className="spec-agent-row" key={i}>
                        <Field
                          id={`agents.${i}.name`}
                          label={`专家 ${i + 1} · 名称`}
                          error={errors[`agents.${i}.name`]}
                        >
                          <input
                            {...attrs(`agents.${i}.name`)}
                            className="field"
                            value={a.name}
                            onChange={(e) =>
                              set(
                                'agents',
                                f.agents.map((x, j) =>
                                  j === i ? { ...x, name: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </Field>
                        <Field
                          id={`agents.${i}.spec_ref`}
                          label="规格引用"
                          error={errors[`agents.${i}.spec_ref`]}
                        >
                          <input
                            {...attrs(`agents.${i}.spec_ref`)}
                            className="field"
                            placeholder="名称@版本"
                            value={a.specRef}
                            onChange={(e) =>
                              set(
                                'agents',
                                f.agents.map((x, j) =>
                                  j === i ? { ...x, specRef: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </Field>
                        <Field id={`agents.${i}.when`} label="触发条件（可选）">
                          <input
                            {...attrs(`agents.${i}.when`)}
                            className="field"
                            value={a.when}
                            onChange={(e) =>
                              set(
                                'agents',
                                f.agents.map((x, j) =>
                                  j === i ? { ...x, when: e.target.value } : x,
                                ),
                              )
                            }
                          />
                        </Field>
                        <button
                          className="spec-remove"
                          type="button"
                          aria-label={`删除专家 ${i + 1}`}
                          onClick={() =>
                            set(
                              'agents',
                              f.agents.filter((_, j) => j !== i),
                            )
                          }
                        >
                          删除
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        set('agents', [...f.agents, { name: '', specRef: '', when: '' }])
                      }
                    >
                      + 添加专家
                    </button>
                  </>
                )}
                {((f.mode !== 'stage-gate' && f.stages.length > 0) ||
                  (f.mode !== 'supervisor' && f.agents.length > 0)) && (
                  <p className="spec-inline-note mt-4">
                    其他模式的阶段或专家配置仍保留在 YAML 中，切回对应模式即可编辑。
                  </p>
                )}
              </section>
            </>
          )}
        </div>
        <footer className="spec-editor-footer">
          <div>
            <strong>
              {mode === 'yaml' ? '保存当前 YAML' : f.name || '尚未命名'}
              {mode === 'form' && <span className="mono"> · v{f.version || '—'}</span>}
            </strong>
            <p>仅注册规格，不会启动 Agent。</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {add.isPending ? '注册中…' : initial ? '注册新版本' : '添加规格'}
          </button>
        </footer>
      </fieldset>
      <p role="status" className={`spec-save-status ${status ? 'has-message' : ''}`}>
        {status}
      </p>
    </div>
  );
}
