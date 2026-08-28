import { useMemo, useState } from 'react';
import type { TraceEvent } from '@veridical/schema';
import { eventMeta } from '../lib/events';
import { traceGraph, actorLabel, statusLabel } from '../lib/traceGraph';
import { EventDetail } from './EventDetail';
import '../session-workspace.css';

export function TraceTimeline({
  events,
  onSelect,
}: {
  events: TraceEvent[];
  onSelect: (e: TraceEvent) => void;
}) {
  const nodes = useMemo(() => traceGraph(events), [events]);
  const [raw, setRaw] = useState(false);
  const [search, setSearch] = useState('');
  const [actor, setActor] = useState('all');
  const [selected, setSelected] = useState<string>();
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const selectedEvent = events.find((e) => e.id === selected) ?? nodes[0]?.start ?? events[0];
  const graph = nodes.length > 0 && !raw;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasChildren = new Set(nodes.map((n) => n.parent));
  const visibleNodes = nodes.filter((node) => {
    // Bookkeeping remains available in the raw log, but should not dominate the human view.
    if (
      !search &&
      actor === 'all' &&
      node.actor === 'loop' &&
      ['control.check', 'checkpoint'].includes(node.operation)
    )
      return false;
    if (actor !== 'all' && node.actor !== actor) return false;
    if (
      !`${node.path} ${node.operation} ${node.status}`.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    if (search || actor !== 'all') return true;
    let parent = node.parent;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (collapsed.has(parent)) return false;
      seen.add(parent);
      parent = byId.get(parent)?.parent;
    }
    return true;
  });
  const rawEvents = events.filter((e) =>
    `${e.type} ${e.path ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  const choose = (e: TraceEvent) => {
    setSelected(e.id);
    onSelect(e);
  };
  return (
    <section className="trace-workspace" aria-label="运行轨迹">
      <header className="trace-toolbar">
        <div className="trace-view-switch">
          <button aria-pressed={graph} disabled={!nodes.length} onClick={() => setRaw(false)}>
            调用树 <span>{visibleNodes.length}</span>
          </button>
          <button aria-pressed={!graph} onClick={() => setRaw(true)}>
            事件日志 <span>{events.length}</span>
          </button>
        </div>
        <span className="trace-legacy">
          {nodes.length ? `${nodes.length} 次调用 · 按调用身份关联` : 'Legacy 事件 · 无调用图'}
        </span>
      </header>
      <div className="trace-split">
        <div className="trace-explorer">
          <div className="trace-filters">
            <input
              className="field"
              aria-label="搜索调用路径"
              placeholder="搜索调用、路径或状态"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {graph && (
              <select
                className="field"
                aria-label="调用类型"
                value={actor}
                onChange={(e) => setActor(e.target.value)}
              >
                <option value="all">全部类型</option>
                {Object.entries(actorLabel).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="trace-column-labels">
            <span>{graph ? '调用路径' : '事件'}</span>
            <span>状态 / 耗时</span>
          </div>
          <div className="trace-node-list">
            {graph
              ? visibleNodes.map((node) => (
                  <div
                    className={`trace-node ${selectedEvent?.id === node.start.id ? 'is-selected' : ''}`}
                    key={node.id}
                    style={{ '--trace-depth': Math.min(node.depth, 8) } as React.CSSProperties}
                  >
                    <button
                      className="trace-expand"
                      disabled={!hasChildren.has(node.id)}
                      aria-label={`${collapsed.has(node.id) ? '展开' : '折叠'} ${node.operation}`}
                      aria-expanded={hasChildren.has(node.id) ? !collapsed.has(node.id) : undefined}
                      onClick={() =>
                        setCollapsed((old) => {
                          const next = new Set(old);
                          next.has(node.id) ? next.delete(node.id) : next.add(node.id);
                          return next;
                        })
                      }
                    >
                      {hasChildren.has(node.id) ? (collapsed.has(node.id) ? '+' : '−') : ''}
                    </button>
                    <button
                      className="trace-node-select"
                      onClick={() => choose(node.start)}
                      aria-pressed={selectedEvent?.id === node.start.id}
                    >
                      <div className="trace-node-name">
                        <span className={`trace-actor actor-${node.actor}`}>
                          {actorLabel[node.actor] ?? node.actor}
                        </span>
                        <strong>{node.operation}</strong>
                        <small className="mono">{node.path}</small>
                      </div>
                      <div className={`trace-node-state state-${node.status}`}>
                        <span>{statusLabel[node.status] ?? node.status}</span>
                        <small>{node.end ? `${node.end.duration_ms} ms` : '等待结束'}</small>
                      </div>
                    </button>
                  </div>
                ))
              : rawEvents.map((e) => (
                  <button
                    key={e.id}
                    className={`trace-event-row ${selectedEvent?.id === e.id ? 'is-selected' : ''}`}
                    onClick={() => choose(e)}
                  >
                    <span className="trace-seq mono">{e.seq}</span>
                    <div>
                      <strong>{eventMeta(e).label}</strong>
                      <small>{e.type}</small>
                    </div>
                    <span className="mono">{e.duration_ms} ms</span>
                  </button>
                ))}
            {(graph ? visibleNodes.length : rawEvents.length) === 0 && (
              <p className="trace-no-results">没有匹配的记录，请调整筛选条件。</p>
            )}
          </div>
        </div>
        {selectedEvent ? (
          <EventDetail embedded event={selectedEvent} events={events} onClose={() => {}} />
        ) : (
          <div className="trace-no-results">运行后在这里查看输入与输出。</div>
        )}
      </div>
    </section>
  );
}
