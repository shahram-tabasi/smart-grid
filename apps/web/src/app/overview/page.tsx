'use client';

import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { TopBar } from '@/components/TopBar';
import { KpiTile } from '@/components/KpiTile';
import { useI18n } from '@/lib/i18n';
import { apiFetch, SessionExpiredError } from '@/lib/api';

interface Kpis {
  totalProjects: number; activeProjects: number; runningProjects: number; commissioningProjects: number;
  engineeringProjects: number; projectsRequiringEngineering: number; projectsRequiringFieldService: number;
  healthyProjects: number; criticalProjects: number; citiesWithProjects: number; projectsWithCommProblems: number;
  totalRelays: number; onlineRelays: number; offlineRelays: number; relaysWithAlarms: number;
  relaysWithRecentTrips: number; criticalRelays: number; unresolvedFaults: number; criticalAlarmsFromFaults: number;
  activeAlarms: number; criticalOpenAlarms: number;
}

export default function OverviewPage() {
  const { t } = useI18n();
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [trend, setTrend] = useState<{ day: string; count: number; critical_count: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [k, tr] = await Promise.all([
          apiFetch<Kpis>('/api/dashboard/kpis'),
          apiFetch<{ series: any[] }>('/api/dashboard/fault-trend'),
        ]);
        if (!active) return;
        setKpis(k);
        setTrend(tr.series.map((s) => ({ ...s, day: new Date(s.day).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) })));
        setError(null);
      } catch (e: any) {
        if (!active) return;
        // An expired session is not an API outage. Leave the page rather than printing "is the API
        // running?" over a dashboard full of data the viewer is no longer entitled to see.
        if (e instanceof SessionExpiredError) {
          window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
          return;
        }
        setError(e.message ?? 'Failed to load dashboard');
      }
    }
    load();
    const id = setInterval(load, 15000); // auto-refresh without a page reload
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div>
      <TopBar title={t('nav_overview')} subtitle={t('overview_sub')} />
      <div className="p-6">
        {/* The refresh failed but the tiles below still hold the last good figures, so say plainly
            that they are stale rather than appending a guess about the cause to every error. */}
        {error && (
          <div className="mb-4 rounded-lg border border-status-critical/40 bg-status-critical/10 p-3 text-sm text-status-critical">
            {error}
            <span className="mt-0.5 block text-xs text-graphite-400">
              {t('stale_figures')}
            </span>
          </div>
        )}
        {!kpis ? (
          <div className="text-graphite-400">{t('loading')}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <KpiTile label={t('total_projects')} value={kpis.totalProjects} />
              <KpiTile label={t('active_projects')} value={kpis.activeProjects} tone="info" />
              <KpiTile label={t('running')} value={kpis.runningProjects} tone="healthy" />
              <KpiTile label={t('commissioning')} value={kpis.commissioningProjects} tone="info" />
              <KpiTile label={t('engineering')} value={kpis.engineeringProjects} />
              <KpiTile label={t('critical')} value={kpis.criticalProjects} tone="critical" />
              <KpiTile label="Relay Offline" value={kpis.offlineRelays} tone="warning" />
              <KpiTile label={t('unresolved_faults')} value={kpis.unresolvedFaults} tone="warning" />
              <KpiTile label={t('active_alarms')} value={kpis.activeAlarms} tone="critical" />
              <KpiTile label={t('healthy_projects')} value={kpis.healthyProjects} tone="healthy" />
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="card p-4 lg:col-span-2">
                <h2 className="mb-3 text-sm font-semibold text-graphite-200">{t('fault_trend_30')}</h2>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2733" />
                    <XAxis dataKey="day" stroke="#5c6b7c" fontSize={11} tickLine={false} />
                    <YAxis stroke="#5c6b7c" fontSize={11} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: '#121822', border: '1px solid #1e2733', borderRadius: 8, fontSize: 12 }} />
                    <Line type="monotone" dataKey="count" name="Total Faults" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="critical_count" name="Critical" stroke="#ef4444" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="card p-4">
                <h2 className="mb-3 text-sm font-semibold text-graphite-200">{t('relay_fleet')}</h2>
                <dl className="space-y-3 text-sm">
                  <Row label={t('total_relays')} value={kpis.totalRelays} />
                  <Row label={t('online_relays')} value={kpis.onlineRelays} tone="healthy" />
                  <Row label={t('offline_relays')} value={kpis.offlineRelays} tone="critical" />
                  <Row label={t('relays_with_alarms')} value={kpis.relaysWithAlarms} tone="warning" />
                  <Row label={t('recent_trips')} value={kpis.relaysWithRecentTrips} tone="warning" />
                  <Row label={t('cities_covered')} value={kpis.citiesWithProjects} />
                  <Row label={t('needs_engineering')} value={kpis.projectsRequiringEngineering} tone="warning" />
                  <Row label={t('needs_field_service')} value={kpis.projectsRequiringFieldService} tone="warning" />
                  <Row label={t('comm_problems')} value={kpis.projectsWithCommProblems} tone="critical" />
                </dl>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone?: 'healthy' | 'warning' | 'critical' }) {
  const cls = tone === 'healthy' ? 'text-status-healthy' : tone === 'warning' ? 'text-status-warning' : tone === 'critical' ? 'text-status-critical' : 'text-graphite-100';
  return (
    <div className="flex items-center justify-between border-b border-graphite-800 pb-2 last:border-0 last:pb-0">
      <dt className="text-graphite-400">{label}</dt>
      <dd className={`mono-nums font-semibold ${cls}`}>{value}</dd>
    </div>
  );
}
