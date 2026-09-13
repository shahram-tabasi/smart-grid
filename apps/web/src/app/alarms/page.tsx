'use client';

import { useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { apiFetch } from '@/lib/api';
import { useApiData } from '@/lib/useApiData';
import { useI18n, useStatusLabel } from '@/lib/i18n';

export default function AlarmsPage() {
  const { t } = useI18n();
  const statusLabel = useStatusLabel();
  const [status, setStatus] = useState('');
  // Which alarms have an acknowledge request in flight. Without this the button stayed enabled, and
  // a second click hit an alarm that was no longer OPEN — the API correctly answered 409 and the
  // operator got an alert box saying the alarm was not found, moments after acknowledging it.
  const [acking, setAcking] = useState<Record<string, boolean>>({});
  const [ackError, setAckError] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const { data, error, loading, reload } = useApiData<{ alarms: any[] }>(`/api/alarms?${params}`);
  const alarms = data?.alarms ?? [];

  async function acknowledge(id: string) {
    if (acking[id]) return;
    setAcking((m) => ({ ...m, [id]: true }));
    setAckError(null);
    try {
      await apiFetch(`/api/alarms/${id}/acknowledge`, { method: 'POST' });
      reload();
    } catch (e: any) {
      setAckError(e?.message ?? t('ack_failed'));
    } finally {
      setAcking((m) => ({ ...m, [id]: false }));
    }
  }

  return (
    <div>
      <TopBar title={t('nav_alarms')} subtitle={t('alarms_sub')} />
      <div className="p-6">
        <div className="mb-4 flex gap-3">
          {['', 'OPEN', 'ACKNOWLEDGED', 'ESCALATED', 'SUPPRESSED', 'CLOSED'].map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${status === s ? 'border-accent bg-accent/15 text-accent' : 'border-graphite-600 text-graphite-300 hover:bg-graphite-800'}`}
            >
              {s ? statusLabel(s) : t('all')}
            </button>
          ))}
          <span className="ml-auto self-center text-sm text-graphite-500">
            {error ? '—' : loading ? t('loading') : `${alarms.length} ${t('alarms_word')}`}
          </span>
        </div>

        {ackError && (
          <div className="mb-3 rounded-lg border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
            {ackError}
          </div>
        )}

        {error ? (
          <ErrorPanel message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingPanel label={t('loading')} />
        ) : (
        <div className="space-y-2">
          {alarms.map((a) => (
            <div key={a.id} className="card flex items-center gap-4 p-4">
              <StatusBadge status={a.priority} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-graphite-100">{a.title}</span>
                  {a.correlated_count > 1 && (
                    <span className="rounded-full bg-graphite-700 px-2 py-0.5 text-[10px] text-graphite-300">
                      {a.correlated_count} {t('correlated')} — {a.correlation_root_cause}
                    </span>
                  )}
                </div>
                <p className="text-xs text-graphite-500">{a.message}</p>
                <p className="mt-1 text-[11px] text-graphite-600">{a.project_code ?? ''} {a.relay_code ? `/ ${a.relay_code}` : ''} · {new Date(a.created_at).toLocaleString()}</p>
              </div>
              <StatusBadge status={a.status} />
              {a.status === 'OPEN' && (
                <button
                  onClick={() => acknowledge(a.id)}
                  disabled={!!acking[a.id]}
                  className="rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/30 disabled:opacity-50"
                >
                  {acking[a.id] ? t('acknowledging') : t('acknowledge')}
                </button>
              )}
            </div>
          ))}
          {alarms.length === 0 && <p className="text-sm text-graphite-500">{t('no_alarms_filter')}</p>}
        </div>
        )}
      </div>
    </div>
  );
}
