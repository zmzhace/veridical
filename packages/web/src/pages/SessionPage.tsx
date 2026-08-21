import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSession, useReplay } from '../api/queries';
import { TraceTimeline } from '../components/TraceTimeline';
import { EventDetail } from '../components/EventDetail';
import { ReplayControls } from '../components/ReplayControls';
import type { TraceEvent } from '@veridical/schema';

export function SessionPage() {
  const { id = '' } = useParams();
  const { data, isLoading } = useSession(id);
  const [seq, setSeq] = useState(0);
  const [selected, setSelected] = useState<TraceEvent | null>(null);
  const replay = useReplay(id, seq);
  const maxSeq = data?.length ?? 0;
  const shown = seq > 0 && replay.data ? replay.data.events : (data ?? []);

  if (isLoading) return <p>Loading…</p>;
  return (
    <div className="relative">
      <h2 className="text-xl font-semibold mb-2">Session {id}</h2>
      <ReplayControls maxSeq={maxSeq} value={seq} onScrub={setSeq} />
      <TraceTimeline events={shown} onSelect={setSelected} />
      {selected && <EventDetail event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
