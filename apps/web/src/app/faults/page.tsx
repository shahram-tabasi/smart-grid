'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useApiData } from '@/lib/useApiData';
import { useI18n, useStatusLabel } from '@/lib/i18n';

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const RESOLUTIONS = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED_NO_ACTION'];

export default function FaultsPage() {
  const { t } = useI18n();
  const statusLabel = useStatusLabel();
  const [severity, setSeverity] = useState('');
  const [resolutionStatus, setResolutionStatus] = useState('');

  const params = new URLSearchParams();
  if (severity) params.set('severity', severity);
  if (resolutionStatus) params.set('resolutionStatus', resolutionStatus);

  const { data, error, loading, refreshing, reload } = useApiData<{ faults: any[] }>(`/api/faults?${params}`);
  const faults = data?.faults ?? [];

  return (
    <div>
      <TopBar title={t('nav_faults')} subtitle={t('faults_sub')} />
      <div className="p-6">
        <div className="mb-4 flex flex-wrap gap-3">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm focus:border-accent focus:outline-none">
            <option value="">{t('all_severities')}</option>
            {SEVERITIES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <select value={resolutionStatus} onChange={(e) => setResolutionStatus(e.target.value)} className="rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm focus:border-accent focus:outline-none">
            <option value="">{t('all_resolutions')}</option>
            {RESOLUTIONS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <span className="ml-auto self-center text-sm text-graphite-500">
            {error ? '—' : loading ? t('loading') : `${faults.length} ${t('nav_faults')}`}
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
                <th className="px-4 py-3">{t('fault')}</th>
                <th className="px-4 py-3">{t('time')}</th>
                <th className="px-4 py-3">{t('project_relay')}</th>
                <th className="px-4 py-3">{t('type')}</th>
                <th className="px-4 py-3">{t('severity')}</th>
                <th className="px-4 py-3">{t('trip')}</th>
                <th className="px-4 py-3">{t('ack')}</th>
                <th className="px-4 py-3">{t('resolution')}</th>
              </tr>
            </thead>
            <tbody>
              {faults.map((f) => (
                <tr key={f.id} className="border-b border-graphite-800 last:border-0 hover:bg-graphite-800/50">
                  <td className="px-4 py-3"><Link href={`/faults/${f.id}`} className="font-mono text-accent hover:underline">{f.fault_code}</Link></td>
                  <td className="px-4 py-3 text-xs text-graphite-400">{new Date(f.timestamp).toLocaleString()}</td>
                  <td className="px-4 py-3 text-graphite-300">{f.project_code}{f.relay_code ? ` / ${f.relay_code}` : ''}</td>
                  <td className="px-4 py-3 text-graphite-200">{f.fault_type}</td>
                  <td className="px-4 py-3"><StatusBadge status={f.severity} /></td>
                  <td className="px-4 py-3"><StatusBadge status={f.trip_status} /></td>
                  <td className="px-4 py-3"><StatusBadge status={f.acknowledgement_status} /></td>
                  <td className="px-4 py-3"><StatusBadge status={f.resolution_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {faults.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-graphite-500">{t('no_faults_match')}</p>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
