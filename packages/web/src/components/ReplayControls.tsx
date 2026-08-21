export function ReplayControls({ maxSeq, value, onScrub }: { maxSeq: number; value: number; onScrub: (seq: number) => void }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="text-sm text-gray-500">Replay</span>
      <input type="range" min={0} max={Math.max(maxSeq, 1)} value={value} onChange={(e) => onScrub(Number(e.target.value))} className="flex-1" />
      <span className="font-mono text-sm">seq {value}/{maxSeq}</span>
    </div>
  );
}
