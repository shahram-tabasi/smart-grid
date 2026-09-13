'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useApiData } from '@/lib/useApiData';
import { useI18n, useStatusLabel } from '@/lib/i18n';

interface RelayRow {
  id: string; relay_code: string; manufacturer: string; model: string; protocol: string; voltage_level: string;
  comm_status: string; breaker_status: string; health_status: string; health_score: number;
  trip_count: number; alarm_count: number; last_communication_at: string | null;
  project_code: string; city_name_en: string; panel_name: string;
}

const MANUFACTURERS = ['Siemens', 'ABB', 'Hitachi Energy', 'Schneider Electric', 'SEL', 'GE Multilin', 'Other'];
const HEALTH = ['HEALTHY', 'WARNING', 'ATTENTION', 'CRITICAL', 'OFFLINE'];

export default function RelaysPage() {
  const { t } = useI18n();
  const statusLabel = useStatusLabel();
  const [manufacturer, setManufacturer] = useState('');
  const [healthStatus, setHealthStatus] = useState('');
  const [search, setSearch] = useState('');

  const params = new URLSearchParams();
  if (manufacturer) params.set('manufacturer', manufacturer);
  if (healthStatus) params.set('healthStatus', healthStatus);
  if (search) params.set('search', search);

  // Race-safe: the table can never show results for an older filter than the one on screen.
  const { data, error, loading, refreshing, reload } = useApiData<{ relays: RelayRow[] }>(
    `/api/relays?${params}`,
    { debounceMs: 250 }
  );
  const relays = data?.relays ?? [];

  return (
    <div>
      <TopBar title={t('nav_relays')} subtitle={t('relays_sub')} />
      <div className="p-6">
        <div className="mb-4 flex flex-wrap gap-3">
          <input placeholder={t('search_relays')} value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-64 rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm placeholder:text-graphite-500 focus:border-accent focus:outline-none" />
          <select value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className="rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm focus:border-accent focus:outline-none">
            <option value="">{t('all_manufacturers')}</option>
            {MANUFACTURERS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={healthStatus} onChange={(e) => setHealthStatus(e.target.value)} className="rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm focus:border-accent focus:outline-none">
            <option value="">{t('all_health')}</option>
            {HEALTH.map((h) => <option key={h} value={h}>{statusLabel(h)}</option>)}
          </select>
          <span className="ml-auto self-center text-sm text-graphite-500">
            {error ? '—' : loading ? t('loading') : `${relays.length} ${t('nav_relays')}`}
            {refreshing && !loading ? ` · ${t('updating')}` : ''}
          </span>
        </div>
        {error ? (
          <ErrorPanel message={error} onRetry={reload} />
        ) : loading ? (
          <LoadingPanel label={t('loading')} />
        ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-graphite-700 text-xs uppercase text-graphite-400">
              <tr>
                <th className="px-4 py-3">{t('relay')}</th>
                <th className="px-4 py-3">{t('manufacturer_model')}</th>
                <th className="px-4 py-3">{t('project_panel')}</th>
                <th className="px-4 py-3">{t('comm')}</th>
                <th className="px-4 py-3">{t('breaker')}</th>
                <th className="px-4 py-3">{t('health')}</th>
                <th className="px-4 py-3">{t('trips')}</th>
                <th className="px-4 py-3">{t('alarms_word')}</th>
              </tr>
            </thead>
            <tbody>
              {relays.map((r) => (
                <tr key={r.id} className="border-b border-graphite-800 last:border-0 hover:bg-graphite-800/50">
                  <td className="px-4 py-3"><Link href={`/relays/${r.id}`} className="font-mono text-accent hover:underline">{r.relay_code}</Link></td>
                  <td className="px-4 py-3 text-graphite-300">{r.manufacturer} <span className="text-graphite-500">{r.model}</span></td>
                  <td className="px-4 py-3 text-graphite-300">{r.project_code} <span className="text-graphite-500">/ {r.panel_name}</span></td>
                  <td className="px-4 py-3"><StatusBadge status={r.comm_status} /></td>
                  <td className="px-4 py-3"><StatusBadge status={r.breaker_status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={r.health_status} />
                      <span className="mono-nums text-xs text-graphite-500">{r.health_score}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 mono-nums text-graphite-300">{r.trip_count}</td>
                  <td className="px-4 py-3 mono-nums text-graphite-300">{r.alarm_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {relays.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-graphite-500">{t('no_relays_match')}</p>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
