export function ProgressBar({ label, value }: { label: string; value: number }) {
  const color = value >= 90 ? 'bg-status-healthy' : value >= 60 ? 'bg-accent' : value >= 30 ? 'bg-status-warning' : 'bg-status-critical';
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-40 shrink-0 text-graphite-300">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-graphite-700">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right mono-nums text-graphite-200">{value}%</span>
    </div>
  );
}
