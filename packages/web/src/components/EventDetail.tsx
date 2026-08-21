import type { TraceEvent } from '@veridical/schema';
export function EventDetail({ event, onClose }: { event: TraceEvent; onClose: () => void }) {
  return (
    <div className="fixed right-0 top-0 h-full w-96 bg-white shadow-lg border-l p-4 overflow-auto">
      <div className="flex justify-between mb-2"><h3 className="font-semibold">{event.type}</h3><button onClick={onClose}>✕</button></div>
      <dl className="text-sm space-y-1">
        <div><dt className="text-gray-500">seq</dt><dd>{event.seq}</dd></div>
        <div><dt className="text-gray-500">span_id</dt><dd className="font-mono">{event.span_id}</dd></div>
        <div><dt className="text-gray-500">attempt</dt><dd>{event.attempt}</dd></div>
        <div><dt className="text-gray-500">call_id</dt><dd className="font-mono">{event.call_id ?? '-'}</dd></div>
      </dl>
      <pre className="mt-3 text-xs bg-gray-50 p-2 rounded overflow-auto">{JSON.stringify(event.payload, null, 2)}</pre>
    </div>
  );
}
