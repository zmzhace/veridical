export function ReplayControls({ maxSeq, value, onScrub }: { maxSeq: number; value: number; onScrub: (seq: number) => void }) {
  return (
    <div className="card px-4 py-3 mb-4">
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-semibold shrink-0">回放</span>
        <span className="text-[11px] text-[var(--muted)] shrink-0 hidden sm:inline">拖动时间轴，查看某个时刻的轨迹</span>
        <input type="range" min={0} max={Math.max(maxSeq, 1)} value={value}
          onChange={(e) => onScrub(Number(e.target.value))}
          className="flex-1 accent-[var(--accent)]" />
        <span className="mono text-[12px] tnum shrink-0">{value === 0 ? '起点' : `第 ${value} 步`}/{maxSeq}</span>
      </div>
    </div>
  );
}