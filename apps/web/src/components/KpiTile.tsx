export function KpiTile({
  label,
  value,
  tone = 'default',
  suffix,
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'healthy' | 'warning' | 'critical' | 'info';
  suffix?: string;
}) {
  const toneCls: Record<string, string> = {
    default: 'text-graphite-100',
    healthy: 'text-status-healthy',
    warning: 'text-status-warning',
    critical: 'text-status-critical',
    info: 'text-status-info',
  };
  return (
    <div className="card flex flex-col justify-between p-4">
      <span className="text-xs font-medium uppercase tracking-wide text-graphite-400">{label}</span>
      <span className={`mt-2 text-3xl font-semibold mono-nums ${toneCls[tone]}`}>
        {value}
        {suffix ? <span className="ml-1 text-base text-graphite-400">{suffix}</span> : null}
      </span>
    </div>
  );
}
