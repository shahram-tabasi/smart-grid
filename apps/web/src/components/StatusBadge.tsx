'use client';

import { useStatusLabel } from '@/lib/i18n';

const COLORS: Record<string, string> = {
  HEALTHY: 'bg-status-healthy/15 text-status-healthy border-status-healthy/30',
  ONLINE: 'bg-status-healthy/15 text-status-healthy border-status-healthy/30',
  RESOLVED: 'bg-status-healthy/15 text-status-healthy border-status-healthy/30',
  CLOSED: 'bg-status-healthy/15 text-status-healthy border-status-healthy/30',
  LOW: 'bg-status-healthy/15 text-status-healthy border-status-healthy/30',
  INFO: 'bg-status-info/15 text-status-info border-status-info/30',

  WARNING: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  MEDIUM: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  DEGRADED: 'bg-status-warning/15 text-status-warning border-status-warning/30',
  ACKNOWLEDGED: 'bg-status-warning/15 text-status-warning border-status-warning/30',

  ATTENTION: 'bg-status-attention/15 text-status-attention border-status-attention/30',
  HIGH: 'bg-status-attention/15 text-status-attention border-status-attention/30',
  INVESTIGATING: 'bg-status-attention/15 text-status-attention border-status-attention/30',
  ESCALATED: 'bg-status-attention/15 text-status-attention border-status-attention/30',

  CRITICAL: 'bg-status-critical/15 text-status-critical border-status-critical/30',
  OPEN: 'bg-status-critical/15 text-status-critical border-status-critical/30',
  TRIPPED: 'bg-status-critical/15 text-status-critical border-status-critical/30',

  OFFLINE: 'bg-status-offline/15 text-status-offline border-status-offline/30',
  UNKNOWN: 'bg-status-offline/15 text-status-offline border-status-offline/30',
  BLOCKED: 'bg-status-offline/15 text-status-offline border-status-offline/30',
  SUPPRESSED: 'bg-status-offline/15 text-status-offline border-status-offline/30',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const statusLabel = useStatusLabel();
  const key = status?.toUpperCase();
  const cls = COLORS[key] ?? 'bg-graphite-600/40 text-graphite-200 border-graphite-500/40';
  // An explicit `label` from the caller always wins; otherwise translate the enum.
  const text = label ?? statusLabel(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}
