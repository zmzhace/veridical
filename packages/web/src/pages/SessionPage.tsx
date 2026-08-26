import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSession, useReplay } from '../api/queries';
import { TraceTimeline } from '../components/TraceTimeline';
import { EventDetail } from '../components/EventDetail';
import { ReplayControls } from '../components/ReplayControls';
import { sessionHuman } from '../lib/events';
import type { TraceEvent } from '@veridical/schema';

export function SessionPage() {
  const { id = '' } = useParams();
  const { data, isLoading } = useSession(id);
  const [seq, setSeq] = useState(0);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const replay = useReplay(id, seq);
  const maxSeq = data?.length ?? 0;
  const shown = seq > 0 && replay.data ? replay.data.events : (data ?? []);

  if (isLoading) return <p className="text-[var(--muted)]">加载中…</p>;
  return (
    <div className="relative">
      <div className="mb-4">
        <h2 className="page-title">{sessionHuman(id)}</h2>
        <p className="page-desc mono text-[12px]">{id} · 点击任意事件查看详情</p>
      </div>
      <ReplayControls maxSeq={maxSeq} value={seq} onScrub={setSeq} />
      {shown.length ? <TraceTimeline events={shown} onSelect={setSelected} /> : <div className="empty"><div className="empty-title">该会话没有事件</div></div>}
      {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}