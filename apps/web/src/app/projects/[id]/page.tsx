'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { ProgressBar } from '@/components/ProgressBar';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch } from '@/lib/api';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useI18n } from '@/lib/i18n';

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  const { t } = useI18n();
  const [project, setProject] = useState<any>(null);
  const [hierarchy, setHierarchy] = useState<any[]>([]);
  const [workOrders, setWorkOrders] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // The project itself decides whether the page can render; the hierarchy and work orders are
        // supporting panels, so one of them failing must not blank the whole screen.
        const p = await apiFetch(`/api/projects/${params.id}`);
        if (cancelled) return;
        setProject(p);

        const [h, wo] = await Promise.allSettled([
          apiFetch<{ substations: any[] }>(`/api/projects/${params.id}/hierarchy`),
          apiFetch<{ workOrders: any[] }>(`/api/projects/${params.id}/work-orders`),
        ]);
        if (cancelled) return;
        setHierarchy(h.status === 'fulfilled' ? h.value.substations ?? [] : []);
        setWorkOrders(wo.status === 'fulfilled' ? wo.value.workOrders ?? [] : []);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Could not load this project.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) return <div className="p-6"><ErrorPanel message={error} onRetry={() => window.location.reload()} /></div>;
  if (loading || !project) return <div className="p-6"><LoadingPanel label={t('loading')} /></div>;

  return (
    <div>
      <TopBar title={project.code} subtitle={project.name} />
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="card p-5">
            <div className="mb-4 flex items-center justify-between">
              <StatusBadge status={project.status} />
              <span className="text-sm text-graphite-400">{project.city_name_en}, {project.province_name_en}</span>
            </div>
            <div className="space-y-2.5">
              <ProgressBar label="Engineering" value={project.engineering_progress} />
              <ProgressBar label="Manufacturing" value={project.manufacturing_progress} />
              <ProgressBar label="FAT" value={project.fat_progress} />
              <ProgressBar label="Installation" value={project.installation_progress} />
              <ProgressBar label="Commissioning" value={project.commissioning_progress} />
              <ProgressBar label="SCADA Integration" value={project.scada_integration_progress} />
              <ProgressBar label="Relay Integration" value={project.relay_integration_progress} />
            </div>
          </div>

          <div className="card p-5">
            <h3 className="mb-4 text-sm font-semibold text-graphite-200">Equipment Hierarchy</h3>
            <div className="space-y-4">
              {hierarchy.map((sub) => (
                <div key={sub.id} className="rounded-lg border border-graphite-700 p-3">
                  <div className="mb-2 font-medium text-graphite-100">🏭 {sub.name}</div>
                  {sub.switchgear.map((sg: any) => (
                    <div key={sg.id} className="ml-4 border-l border-graphite-700 pl-4 py-1">
                      <div className="text-sm text-graphite-200">▣ {sg.name} <span className="text-xs text-graphite-500">({sg.switchgear_type})</span></div>
                      {sg.panels.map((panel: any) => (
                        <div key={panel.id} className="ml-4 border-l border-graphite-800 pl-4 py-1">
                          <div className="text-sm text-graphite-300">◽ {panel.name} <span className="text-xs text-graphite-500">({panel.panel_type})</span></div>
                          {panel.relays.map((relay: any) => (
                            <Link
                              href={`/relays/${relay.id}`}
                              key={relay.id}
                              className="ml-4 mt-1 flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-graphite-800"
                            >
                              <StatusBadge status={relay.health_status} />
                              <span className="font-mono text-accent">{relay.relay_code}</span>
                              <span className="text-graphite-400">{relay.manufacturer} {relay.model}</span>
                            </Link>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              {hierarchy.length === 0 && <p className="text-sm text-graphite-500">No equipment recorded yet.</p>}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold text-graphite-200">Project Health</h3>
            {project.health_score != null ? (
              <div className="text-center">
                <div className={`text-5xl font-bold mono-nums ${project.health_score >= 80 ? 'text-status-healthy' : project.health_score >= 55 ? 'text-status-warning' : 'text-status-critical'}`}>
                  {project.health_score}
                </div>
                <div className="text-xs text-graphite-500">/ 100</div>
              </div>
            ) : (
              <p className="text-sm text-graphite-500">Not yet computed (pre-operational phase).</p>
            )}
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-graphite-400">Project Manager</dt><dd>{project.project_manager_name ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-graphite-400">Technical Manager</dt><dd>{project.technical_manager_name ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-graphite-400">Customer</dt><dd>{project.customer_name ?? '—'}</dd></div>
              <div className="flex justify-between"><dt className="text-graphite-400">Voltage Level</dt><dd>{project.voltage_level}</dd></div>
              <div className="flex justify-between"><dt className="text-graphite-400">Expected Completion</dt><dd>{project.expected_completion?.slice(0, 10) ?? '—'}</dd></div>
            </dl>
          </div>

          <div className="card p-5">
            <h3 className="mb-3 text-sm font-semibold text-graphite-200">Work Orders</h3>
            <ul className="space-y-2">
              {workOrders.map((wo) => (
                <li key={wo.id} className="flex items-center justify-between text-sm">
                  <span className="text-graphite-300">{wo.work_order_code}</span>
                  <StatusBadge status={wo.status} />
                </li>
              ))}
              {workOrders.length === 0 && <p className="text-sm text-graphite-500">No work orders for this project.</p>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
