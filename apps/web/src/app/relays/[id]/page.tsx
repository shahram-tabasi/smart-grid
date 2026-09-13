'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useApiData } from '@/lib/useApiData';
import { useI18n } from '@/lib/i18n';

export default function RelayDetailPage({ params }: { params: { id: string } }) {
  const { t } = useI18n();
  const { data, error, loading, reload } = useApiData<any>(`/api/relays/${params.id}`);

  if (error) return <div className="p-6"><ErrorPanel message={error} onRetry={reload} /></div>;
  if (loading || !data) return <div className="p-6"><LoadingPanel label={t('loading')} /></div>;
  // The API returns a nested envelope, not a flat relay. Each list is defaulted because a relay with
  // no recorded events or faults omits nothing here today, but a `.map()` on undefined is a white screen.
  const { hierarchy: h, relay } = data;
  const protectionFunctions = data.protectionFunctions ?? [];
  const recentEvents = data.recentEvents ?? [];
  const faults = data.faults ?? [];

  return (
    <div>
      <TopBar title={relay.relay_code} subtitle={`${relay.manufacturer} ${relay.model} — ${relay.protocol}`} />
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="card p-5">
            <div className="mb-4 text-xs text-graphite-500">
              <Link href={`/projects/${h.project_id}`} className="text-accent hover:underline">{h.project_code}</Link>
              {' › '}{h.substation_name} {' › '}{h.switchgear_name} {' › '}{h.panel_name}
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label={t('communication')} node={<StatusBadge status={relay.comm_status} />} />
              <Field label={t('protection')} node={<span className="text-sm">{relay.protection_status}</span>} />
              <Field label={t('breaker')} node={<StatusBadge status={relay.breaker_status} />} />
              <Field label={t('setting_group')} node={<span className="text-sm">{relay.active_setting_group}</span>} />
              <Field label={t('health')} node={<div className="flex items-center gap-2"><StatusBadge status={relay.health_status} /><span className="mono-nums text-xs text-graphite-500">{relay.health_score}/100</span></div>} />
              <Field label={t('trip_count')} node={<span className="mono-nums text-sm">{relay.trip_count}</span>} />
              <Field label={t('alarm_count')} node={<span className="mono-nums text-sm">{relay.alarm_count}</span>} />
              <Field label={t('last_communication')} node={<span className="text-xs text-graphite-400">{relay.last_communication_at ? new Date(relay.last_communication_at).toLocaleString() : '—'}</span>} />
            </div>
          </div>

          {/*
            Every protection function configured on this relay, as a table rather than a row of
            chips. A chip could only fit the ANSI number and the pickup value, so the two things a
            protection engineer checks first — whether the stage is ENABLED, and its time delay —
            were held in the database but never shown. A disabled stage that nobody noticed is a
            protection gap, so it is now called out explicitly instead of looking like every other
            entry.

            These are RECORDED settings, read from the relay or entered at commissioning. This
            screen never writes them: changing a protection setting is not something this system
            does (docs/ARCHITECTURE.md §2).
          */}
          <div className="card p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-graphite-200">{t('protection_functions')}</h3>
              <span className="text-[11px] text-graphite-500">
                {protectionFunctions.length} {t('configured')}
                {protectionFunctions.some((f: any) => f.enabled === false) &&
                  ` · ${protectionFunctions.filter((f: any) => f.enabled === false).length} ${t('disabled_count')}`}
              </span>
            </div>

            {protectionFunctions.length === 0 ? (
              <p className="text-sm text-graphite-500">{t('no_prot_fns')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-graphite-700 text-[10px] uppercase text-graphite-500">
                    <tr>
                      <th className="py-2 pr-3">{t('ansi')}</th>
                      <th className="py-2 pr-3">{t('function')}</th>
                      <th className="py-2 pr-3">{t('pickup')}</th>
                      <th className="py-2 pr-3">{t('time_delay')}</th>
                      <th className="py-2">{t('state')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {protectionFunctions.map((f: any) => (
                      <tr key={f.id} className="border-b border-graphite-800 last:border-0">
                        <td className="py-2 pr-3 font-mono font-medium text-accent">{f.ansi_code ?? '—'}</td>
                        <td className="py-2 pr-3 text-graphite-200">{String(f.function_code).replace(/_/g, ' ')}</td>
                        <td className="py-2 pr-3 mono-nums text-graphite-300">
                          {f.pickup_value != null ? `${f.pickup_value} ${f.pickup_unit ?? ''}`.trim() : '—'}
                        </td>
                        <td className="py-2 pr-3 mono-nums text-graphite-300">
                          {f.time_delay_ms != null ? `${f.time_delay_ms} ms` : '—'}
                        </td>
                        <td className="py-2">
                          {f.enabled === false ? (
                            <span className="rounded bg-status-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warning">
                              {t('disabled')}
                            </span>
                          ) : (
                            <span className="text-[10px] text-status-healthy">{t('enabled')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold text-graphite-200">{t('recent_events_soe')}</h3>
            <ul className="divide-y divide-graphite-800 text-sm">
              {recentEvents.map((e: any) => (
                <li key={e.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="text-graphite-200">{e.message}</div>
                    <div className="text-xs text-graphite-500">{new Date(e.time).toISOString().replace('T', ' ').slice(0, 23)}</div>
                  </div>
                  <StatusBadge status={e.severity} />
                </li>
              ))}
              {recentEvents.length === 0 && <p className="text-sm text-graphite-500">No events recorded.</p>}
            </ul>
          </div>
        </div>

        <div className="card h-fit p-5">
          <h3 className="mb-3 text-sm font-semibold text-graphite-200">Associated Faults</h3>
          <ul className="space-y-3">
            {faults.map((f: any) => (
              <li key={f.id}>
                <Link href={`/faults/${f.id}`} className="block rounded-lg border border-graphite-700 p-3 hover:border-accent">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-mono text-xs text-accent">{f.fault_code}</span>
                    <StatusBadge status={f.severity} />
                  </div>
                  <div className="text-sm text-graphite-200">{f.fault_type}</div>
                  <div className="text-xs text-graphite-500">{new Date(f.timestamp).toLocaleString()}</div>
                </Link>
              </li>
            ))}
            {faults.length === 0 && <p className="text-sm text-graphite-500">No faults recorded for this relay.</p>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Field({ label, node }: { label: string; node: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase text-graphite-500">{label}</div>
      {node}
    </div>
  );
}
