'use client';

import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { TopBar } from '@/components/TopBar';
import { KpiTile } from '@/components/KpiTile';
import { apiFetch } from '@/lib/api';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useI18n } from '@/lib/i18n';

export default function ExecutivePage() {
  const { t } = useI18n();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Previously neither the initial call nor the 30s refresh had a .catch, so a failing API left
    // "Loading…" on screen forever while emitting a fresh unhandled rejection every 30 seconds for
    // as long as the tab stayed open. A refresh failure now keeps the last good figures on screen
    // and only reports the error when there is nothing to show.
    const load = async () => {
      try {
        const d = await apiFetch('/api/executive/summary');
        if (cancelled) return;
        setData(d);
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? t('exec_summary_failed'));
      }
    };

    void load();
    const id = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!data) {
    return (
      <div className="p-6">
        {error ? <ErrorPanel message={error} onRetry={() => window.location.reload()} /> : <LoadingPanel />}
      </div>
    );
  }

  return (
    <div>
      <TopBar title={t('nav_executive')} subtitle={t('exec_sub')} />
      <div className="p-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiTile label={t('total_projects')} value={data.totalProjects} />
          <KpiTile label={t('running')} value={data.projectsRunning} tone="healthy" />
          <KpiTile label={t('projects_delayed')} value={data.projectsDelayed} tone="warning" />
          <KpiTile label={t('projects_at_risk')} value={data.projectsAtRisk} tone="critical" />
          <KpiTile label={t('critical_faults')} value={data.criticalFaults} tone="critical" />
          <KpiTile label={t('open_work_orders')} value={data.openWorkOrders} tone="warning" />
          <KpiTile label={t('relay_fleet_health')} value={data.relayFleetHealthPercent ?? '—'} suffix="%" tone="info" />
          <KpiTile label={t('cities_covered')} value={data.citiesCovered} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-graphite-200">{t('monthly_fault_trend')}</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.monthlyFaultTrend.map((m: any) => ({ ...m, month: new Date(m.month).toLocaleDateString('en-GB', { month: 'short' }) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2733" />
                <XAxis dataKey="month" stroke="#5c6b7c" fontSize={11} tickLine={false} />
                <YAxis stroke="#5c6b7c" fontSize={11} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#121822', border: '1px solid #1e2733', borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-graphite-200">Project Completion Forecast</h2>
            <ul className="space-y-2">
              {data.completionForecast.map((p: any) => (
                <li key={p.code} className="flex items-center justify-between text-sm">
                  <span className="text-graphite-300">{p.code} — {p.name}</span>
                  <span className="text-xs text-graphite-500">{p.expected_completion?.slice(0, 10)} · {p.overall_progress}%</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
