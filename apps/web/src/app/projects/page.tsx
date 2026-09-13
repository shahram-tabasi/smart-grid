'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useApiData } from '@/lib/useApiData';
import { useI18n, useLocalName, useStatusLabel } from '@/lib/i18n';

interface ProjectRow {
  id: string; code: string; name: string; customer_name: string | null; city_name_en: string;
  province_name_en: string; status: string; overall_progress: number; health_score: number | null;
  requires_engineering_intervention: boolean; requires_field_service: boolean; has_comm_problem: boolean;
  voltage_level: string;
}

const STATUSES = ['PLANNING', 'ENGINEERING', 'PROCUREMENT', 'MANUFACTURING', 'FAT', 'INSTALLATION', 'COMMISSIONING', 'RUNNING', 'COMPLETED', 'BLOCKED'];

export default function ProjectsPage() {
  const { t } = useI18n();
  const localName = useLocalName();
  const statusLabel = useStatusLabel();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (search) params.set('search', search);

  // Debounced so typing does not fire a query per keystroke, and race-safe so the table can never
  // show the results of an older search than the one in the box.
  const { data, error, loading, refreshing, reload } = useApiData<{ projects: ProjectRow[] }>(
    `/api/projects?${params}`,
    { debounceMs: 250 }
  );
  const projects = data?.projects ?? [];

  return (
    <div>
      <TopBar title={t('nav_projects')} subtitle={t('projects_sub')} />
      <div className="p-6">
        <div className="mb-4 flex flex-wrap gap-3">
          <input
            placeholder={t('search_projects')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64 rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm text-graphite-100 placeholder:text-graphite-500 focus:border-accent focus:outline-none"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm text-graphite-100 focus:border-accent focus:outline-none"
          >
            <option value="">{t('all_statuses')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
          <span className="ml-auto self-center text-sm text-graphite-500">
            {/* Never show a count while the answer is unknown — "0 projects" during a failed or
                in-flight load reads as a fact about the fleet. */}
            {error ? '—' : loading ? t('loading') : `${projects.length} ${t('projects_word')}`}
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
                <th className="px-4 py-3">{t('code')}</th>
                <th className="px-4 py-3">{t('project')}</th>
                <th className="px-4 py-3">{t('location')}</th>
                <th className="px-4 py-3">{t('status')}</th>
                <th className="px-4 py-3">{t('progress')}</th>
                <th className="px-4 py-3">{t('health')}</th>
                <th className="px-4 py-3">{t('flags')}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-b border-graphite-800 last:border-0 hover:bg-graphite-800/50">
                  <td className="px-4 py-3">
                    <Link href={`/projects/${p.id}`} className="font-mono text-accent hover:underline">{p.code}</Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-graphite-100">{p.name}</div>
                    <div className="text-xs text-graphite-500">{p.customer_name}</div>
                  </td>
                  <td className="px-4 py-3 text-graphite-300">{localName(p.city_name_en, (p as any).city_name_fa)}, {localName(p.province_name_en, (p as any).province_name_fa)}</td>
                  <td className="px-4 py-3"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-graphite-700">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${p.overall_progress}%` }} />
                      </div>
                      <span className="mono-nums text-xs text-graphite-400">{p.overall_progress}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {p.health_score != null ? (
                      <span className={`mono-nums font-semibold ${p.health_score >= 80 ? 'text-status-healthy' : p.health_score >= 55 ? 'text-status-warning' : 'text-status-critical'}`}>
                        {p.health_score}
                      </span>
                    ) : (
                      <span className="text-graphite-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {p.requires_engineering_intervention && <span title="Requires engineering intervention" className="text-status-warning">⚙</span>}
                      {p.requires_field_service && <span title="Requires field service" className="text-status-attention">🛠</span>}
                      {p.has_comm_problem && <span title="Communication problem" className="text-status-critical">📡</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {projects.length === 0 && (
            <p className="px-4 py-8 text-center text-xs text-graphite-500">{t('no_projects_match')}</p>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
