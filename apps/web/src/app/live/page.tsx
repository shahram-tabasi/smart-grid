'use client';

import { useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch, wsUrl } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface LiveEvent {
  id: string; time: string; eventType: string; severity: string; message: string;
  projectCode: string; cityNameEn: string; relayCode?: string;
}

export default function LivePage() {
  const { t } = useI18n();
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Seed the feed with recent history so the screen isn't empty on first load.
    apiFetch<{ events: any[] }>('/api/dashboard/recent-events')
      .then((d) =>
        setEvents(
          (d.events ?? []).map((e) => ({
            id: e.id, time: e.time, eventType: e.event_type, severity: e.severity, message: e.message,
            projectCode: e.project_code, cityNameEn: e.city_name_en,
          }))
        )
      )
      // Without this the screen sat on "Waiting for events…" indefinitely, which on a live
      // operations feed is indistinguishable from a quiet, healthy network.
      .catch((err: any) => setSeedError(err?.message ?? 'Could not load recent event history.'));

    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (msg) => {
      try {
        const payload = JSON.parse(msg.data);
        if (payload.type === 'LIVE_EVENT') {
          setEvents((prev) => [payload.event, ...prev].slice(0, 100));
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => ws.close();
  }, []);

  return (
    <div>
      <TopBar
        title="Live Operations Center"
        subtitle={connected ? 'Connected — streaming via WebSocket' : 'Connecting…'}
      />
      <div className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-status-healthy animate-pulse' : 'bg-status-offline'}`} />
          <span className="text-sm text-graphite-400">{connected ? 'Live' : 'Offline'} — {events.length} events buffered</span>
        </div>
        <div className="card divide-y divide-graphite-800">
          {events.map((e) => (
            <div key={e.id} className="flex items-center gap-4 px-4 py-3 text-sm">
              <span className="w-24 shrink-0 font-mono text-xs text-graphite-500">{new Date(e.time).toLocaleTimeString()}</span>
              <span className="w-40 shrink-0 text-graphite-300">{e.cityNameEn} — {e.projectCode}</span>
              <span className="flex-1 text-graphite-200">{e.message}</span>
              <StatusBadge status={e.severity} />
            </div>
          ))}
          {events.length === 0 &&
            (seedError ? (
              <div className="px-4 py-6 text-center">
                <p className="text-sm text-status-critical">{t('history_failed')}</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-graphite-500">
                  {seedError} — {t('empty_not_quiet')}
                </p>
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-graphite-500">{t('waiting_events')}</div>
            ))}
        </div>
      </div>
    </div>
  );
}
