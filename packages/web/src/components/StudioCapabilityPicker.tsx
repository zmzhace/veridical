import { useEffect, useMemo, useState } from 'react';
import { useCapabilityCatalog, type CapabilitySummary } from '../api/queries';
import { CapabilityDetail, CapabilityRow } from './CapabilityCatalog';
import '../capabilities.css';

export interface StudioCapabilityBinding {
  capability_id: string;
  kind: CapabilitySummary['kind'];
  version?: string;
  access?: 'allow' | 'ask' | 'deny';
  activation?: 'auto' | 'always' | 'manual';
  selected_children?: string[];
  display_name?: string;
  summary?: string;
  content_hash?: string;
  tool_dependencies?: string[];
  risk?: CapabilitySummary['risk'];
}

export function StudioCapabilityPicker({
  bindings,
  onChange,
  onClose,
}: {
  bindings: StudioCapabilityBinding[];
  onChange: (bindings: StudioCapabilityBinding[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'enabled' | 'recommended' | 'all' | 'attention'>('enabled');
  const [kind, setKind] = useState<CapabilitySummary['kind'] | ''>('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CapabilitySummary | null>(null);
  const catalog = useCapabilityCatalog({ kind: kind || undefined, query, limit: 100 });
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const enabled = new Set(bindings.map((item) => `${item.kind}:${item.capability_id}`));
  const items = useMemo(() => {
    const source = catalog.data?.items ?? [];
    if (tab === 'enabled') return source.filter((item) => enabled.has(`${item.kind}:${item.id}`));
    if (tab === 'attention')
      return source.filter(
        (item) =>
          item.status !== 'approved' || item.health === 'offline' || item.health === 'degraded',
      );
    if (tab === 'recommended')
      return source
        .filter(
          (item) =>
            item.status === 'approved' &&
            ['tool', 'skill', 'knowledge'].includes(item.kind) &&
            !['echo', 'finish'].includes(item.id) &&
            item.risk !== 'destructive',
        )
        .slice(0, 12);
    return source;
  }, [catalog.data?.items, enabled, tab]);
  function toggle(item: CapabilitySummary) {
    const key = `${item.kind}:${item.id}`;
    if (enabled.has(key))
      return onChange(
        bindings.filter((binding) => `${binding.kind}:${binding.capability_id}` !== key),
      );
    onChange([
      ...bindings,
      {
        capability_id: item.id,
        kind: item.kind,
        version: item.version,
        access: item.risk === 'write' || item.risk === 'destructive' ? 'ask' : 'allow',
        activation: item.kind === 'skill' ? 'auto' : undefined,
        selected_children: item.kind === 'mcp' ? (item.selected_children ?? []) : undefined,
        display_name: item.display_name,
        summary: item.summary,
        content_hash: item.content_hash,
        tool_dependencies: item.tool_dependencies,
        risk: item.risk,
      },
    ]);
  }
  return (
    <div className="studio-capability-backdrop" onMouseDown={onClose}>
      <section
        className="studio-capability-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Agent 能力"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p>AGENT CAPABILITIES</p>
            <h2>Agent 能力</h2>
            <span>Agent 只能从这里启用的能力中选择。发布时会固定版本和 Hash。</span>
          </div>
          <button className="detail-close" onClick={onClose} aria-label="关闭能力选择器">
            ×
          </button>
        </header>
        <div className="studio-capability-tabs">
          {(
            [
              ['enabled', '已启用'],
              ['recommended', '推荐'],
              ['all', '全部'],
              ['attention', '需要处理'],
            ] as const
          ).map(([value, label]) => (
            <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
              {label}
              {value === 'enabled' && <span>{bindings.length}</span>}
            </button>
          ))}
        </div>
        <div className="studio-capability-toolbar">
          <input
            aria-label="搜索能力"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、用途或标签"
          />
          <select
            aria-label="能力类型"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="">所有类型</option>
            <option value="tool">工具</option>
            <option value="mcp">MCP</option>
            <option value="skill">Skill</option>
            <option value="memory">记忆</option>
            <option value="knowledge">知识</option>
          </select>
        </div>
        <div className="studio-capability-list">
          {catalog.isLoading ? (
            <div className="capability-empty-v2">正在读取能力库…</div>
          ) : items.length ? (
            items.map((item) => (
              <CapabilityRow
                key={`${item.kind}:${item.id}`}
                capability={item}
                enabled={enabled.has(`${item.kind}:${item.id}`)}
                selected={selected?.id === item.id && selected.kind === item.kind}
                onSelect={() => setSelected(item)}
                onToggle={() => toggle(item)}
              />
            ))
          ) : (
            <div className="capability-empty-v2">
              <div>
                <strong>{tab === 'enabled' ? '还没有启用能力' : '没有匹配结果'}</strong>
                <p>
                  {tab === 'enabled'
                    ? '切换到“推荐”或“全部”，为 Agent 添加能力。'
                    : '调整关键词或筛选条件。'}
                </p>
              </div>
            </div>
          )}
        </div>
        <footer>
          <span>{bindings.length} 项已启用 · 写入和高风险操作仍需确认</span>
          <button className="button button-primary" onClick={onClose}>
            完成
          </button>
        </footer>
        {selected && <CapabilityDetail capability={selected} onClose={() => setSelected(null)} />}
      </section>
    </div>
  );
}
