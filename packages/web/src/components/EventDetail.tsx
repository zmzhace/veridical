import { useEffect, useState } from 'react';
import type { TraceEvent } from '@veridical/schema';
import { eventMeta } from '../lib/events';
import { statusLabel } from '../lib/traceGraph';

export function EventDetail({
  event,
  events = [],
  onClose,
  embedded = false,
}: {
  event: TraceEvent;
  events?: TraceEvent[];
  onClose: () => void;
  embedded?: boolean;
}) {
  const [tab, setTab] = useState<'io' | 'raw'>('io');
  const [copied, setCopied] = useState('');
  useEffect(() => {
    setCopied('');
  }, [event.id]);
  useEffect(() => {
    if (embedded) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [embedded, onClose]);
  const invocation = event.type.startsWith('invocation.');
  const start = invocation
    ? (events.find(
        (e) => e.type === 'invocation.start' && e.invocation_id === event.invocation_id,
      ) ?? event)
    : event;
  const end = invocation
    ? events.find((e) => e.type === 'invocation.end' && e.invocation_id === event.invocation_id)
    : undefined;
  const p = start.payload as any;
  const result = end?.payload as any;
  const meta = eventMeta(event);
  const input = invocation
    ? p?.input
    : event.type.endsWith('request') || event.type === 'tool.called'
      ? event.payload
      : undefined;
  const output = invocation ? result?.output : input === undefined ? event.payload : undefined;
  const title = invocation ? p?.operation : meta.label;
  const rows = [
    ['路径', event.path ?? p?.path ?? 'legacy · 未记录路径'],
    ['调用 ID', event.invocation_id ?? '未记录'],
    ['父调用', event.parent_invocation_id ?? p?.parent_invocation_id ?? '根节点'],
    ['事件序号', end ? `${start.seq} → ${end.seq}` : String(event.seq)],
    ['尝试', String(event.attempt)],
    ['耗时', `${end?.duration_ms ?? event.duration_ms} ms`],
  ];
  const raw = invocation ? { start, end: end ?? null } : event;
  return (
    <aside
      className={`trace-inspector ${embedded ? 'is-embedded' : 'is-drawer'}`}
      aria-label="调用详情"
    >
      <header className="trace-inspector-heading">
        <div>
          <h3>{title}</h3>
          <span className="trace-detail-status">
            {invocation
              ? (statusLabel[result?.status ?? 'started'] ?? result?.status)
              : meta.desc(event)}
          </span>
        </div>
        {!embedded && (
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        )}
      </header>
      <div className="trace-detail-tabs">
        <button aria-pressed={tab === 'io'} onClick={() => setTab('io')}>
          输入 / 输出
        </button>
        <button aria-pressed={tab === 'raw'} onClick={() => setTab('raw')}>
          原始事件
        </button>
        <button
          className="trace-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
              setCopied('已复制');
            } catch {
              setCopied('复制失败');
            }
          }}
        >
          {copied || '复制 JSON'}
        </button>
      </div>
      <div className="trace-inspector-body">
        {tab === 'io' ? (
          <>
            <section className="trace-payload">
              <h4>
                输入 <span>INPUT</span>
              </h4>
              <pre>{input === undefined ? '此事件未记录输入' : JSON.stringify(input, null, 2)}</pre>
            </section>
            <section className="trace-payload">
              <h4>
                输出 <span>OUTPUT</span>
              </h4>
              <pre>
                {output === undefined
                  ? invocation && !end
                    ? '尚未收到结束事件'
                    : '此事件未记录输出'
                  : JSON.stringify(output, null, 2)}
              </pre>
            </section>
            {result?.error && (
              <section className="trace-payload trace-failure">
                <h4>错误</h4>
                <pre>{JSON.stringify(result.error, null, 2)}</pre>
              </section>
            )}
            <dl className="trace-metadata">
              {rows.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <section className="trace-payload">
            <pre>{JSON.stringify(raw, null, 2)}</pre>
          </section>
        )}
      </div>
    </aside>
  );
}
