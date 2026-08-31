import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { TraceEvent } from '@veridical/schema';
import { useInvocations, useReplayExecution, useSession } from '../api/queries';
import { EventDetail } from '../components/EventDetail';
import { TraceTimeline } from '../components/TraceTimeline';
import '../product.css';

export function TaskTracePage() {
  const { taskId = '' } = useParams();
  const session = useSession(taskId);
  const invocations = useInvocations(taskId);
  const replay = useReplayExecution();
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const [selectedInvocation, setSelectedInvocation] = useState<any>(null);
  const [view, setView] = useState<'tree' | 'timeline' | 'data'>('tree');
  const events = session.data ?? [];
  const spec = (events.find((event) => event.type === 'run.provenance')?.payload as any)?.spec;
  const totals = useMemo(
    () =>
      events.reduce(
        (sum, event) => ({
          duration: sum.duration + event.duration_ms,
          tokens: sum.tokens + (event.tokens?.total ?? 0),
          cost: sum.cost + (event.cost ?? 0),
        }),
        { duration: 0, tokens: 0, cost: 0 },
      ),
    [events],
  );
  async function exportTrajectory(format: 'jsonl' | 'grpo') {
    const response = await fetch(`/api/sessions/${taskId}/trajectory/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format }),
    });
    if (!response.ok) return;
    const blob = await response.blob();
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `${taskId}.${format}.jsonl`;
    anchor.click();
    URL.revokeObjectURL(href);
  }
  return (
    <section className="trace-page">
      <header className="trace-heading">
        <div>
          <Link
            className="back-link"
            to={spec?.name ? `/agents/${spec.name}?task=${taskId}` : '/agents'}
          >
            ‹ 返回任务
          </Link>
          <p className="product-kicker">Run details</p>
          <h1>运行详情</h1>
          <p className="mono">{taskId}</p>
        </div>
        <div className="trace-actions">
          <button className="button" onClick={() => exportTrajectory('jsonl')}>
            导出 JSONL
          </button>
          <button className="button" onClick={() => exportTrajectory('grpo')}>
            导出 GRPO
          </button>
          <button
            className="button button-primary"
            disabled={replay.isPending}
            onClick={() => replay.mutate({ id: taskId, body: { mode: 'strict' } })}
          >
            {replay.isPending ? '回放中…' : '严格回放'}
          </button>
        </div>
      </header>
      <dl className="trace-metrics">
        <div>
          <dt>事件</dt>
          <dd>{events.length}</dd>
        </div>
        <div>
          <dt>调用节点</dt>
          <dd>{invocations.data?.invocations.length ?? 0}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>{totals.tokens.toLocaleString()}</dd>
        </div>
        <div>
          <dt>累计耗时</dt>
          <dd>{totals.duration}ms</dd>
        </div>
        <div>
          <dt>成本</dt>
          <dd>${totals.cost.toFixed(4)}</dd>
        </div>
      </dl>
      {replay.data && (
        <div className={`replay-banner ${replay.data.identical ? 'is-success' : 'is-difference'}`}>
          <strong>
            {replay.data.identical
              ? '严格回放一致'
              : replay.data.passed
                ? '语义回放通过'
                : '发现回放差异'}
          </strong>
          <span>
            {replay.data.degraded ? '本次回放已降级，详情已进入审计记录。' : '未使用静默降级。'}
          </span>
        </div>
      )}
      {replay.error && (
        <div className="replay-banner is-error" role="alert">
          <strong>回放未通过</strong>
          <span>{replay.error.message}</span>
        </div>
      )}
      <div className="trace-tabs">
        {(
          [
            ['tree', '调用树'],
            ['timeline', '时间线'],
            ['data', '来源与版本'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>
      {session.isLoading ? (
        <div className="state-panel">正在加载完整轨迹…</div>
      ) : view === 'tree' ? (
        <div className="invocation-tree">
          {(invocations.data?.invocations ?? []).length ? (
            (invocations.data?.invocations ?? []).map((item, index) => (
              <article
                key={String(item.invocation_id ?? index)}
                onClick={() => setSelectedInvocation(item)}
                tabIndex={0}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedInvocation(item); }}
                style={{
                  marginLeft: `${Math.max(0, String(item.path ?? '').split('/').length - 1) * 20}px`,
                }}
              >
                <span className={`invocation-status is-${String(item.status ?? 'success')}`} />
                <div>
                  <strong>{String(item.operation ?? item.actor ?? '调用')}</strong>
                  <small className="mono">{String(item.path ?? 'legacy')}</small>
                </div>
                <dl>
                  <div>
                    <dt>状态</dt>
                    <dd>{String(item.status ?? '完成')}</dd>
                  </div>
                  <div>
                    <dt>尝试</dt>
                    <dd>{String(item.attempt ?? 1)}</dd>
                  </div>
                </dl>
              </article>
            ))
          ) : (
            <div className="state-panel">
              <strong>旧轨迹没有显式调用图</strong>
              <p>仍可在时间线中查看事件，但不能声明为严格一致回放。</p>
            </div>
          )}
        </div>
      ) : view === 'timeline' ? (
        <TraceTimeline events={events} onSelect={setSelected} />
      ) : (
        <div className="provenance-panel">
          <h2>运行来源</h2>
          <pre>
            {JSON.stringify(
              events.find((event) => event.type === 'run.provenance')?.payload ?? {},
              null,
              2,
            )}
          </pre>
        </div>
      )}
      {selectedInvocation && (
        <aside className="invocation-inspector" aria-label="调用详情">
          <button className="button" onClick={() => setSelectedInvocation(null)}>关闭</button>
          <h2>{String(selectedInvocation.operation ?? '调用')}</h2>
          <p className="mono">{String(selectedInvocation.path ?? '')}</p>
          <h3>Input</h3><pre>{JSON.stringify(selectedInvocation.input, null, 2)}</pre>
          <h3>Output / Error</h3><pre>{JSON.stringify(selectedInvocation.output ?? selectedInvocation.error ?? null, null, 2)}</pre>
        </aside>
      )}
      {selected && (
        <EventDetail event={selected} events={events} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}
