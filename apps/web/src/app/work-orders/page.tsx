'use client';

import { useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useApiData } from '@/lib/useApiData';
import { useI18n, useStatusLabel } from '@/lib/i18n';

const WORKFLOW = ['OPEN', 'ANALYSIS', 'ASSIGNED', 'FIELD_INSPECTION', 'REPAIR', 'TEST', 'VERIFIED', 'CLOSED'];

export default function WorkOrdersPage() {
  const { t } = useI18n();
  const statusLabel = useStatusLabel();
  const [status, setStatus] = useState('');

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  const { data, error, loading, reload } = useApiData<{ workOrders: any[] }>(`/api/work-orders?${params}`);
  const workOrders = data?.workOrders ?? [];

  return (
    <div>
      <TopBar title={t('nav_workorders')} subtitle={t('wo_sub')} />
      <div className="p-6">
        <div className="mb-4 flex flex-wrap gap-2">
          <button onClick={() => setStatus('')} className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${status === '' ? 'border-accent bg-accent/15 text-accent' : 'border-graphite-600 text-graphite-300'}`}>{t('all')}</button>
          {WORKFLOW.map((s) => (
            <button key={s} onClick={() => setStatus(s)} className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${status === s ? 'border-accent bg-accent/15 text-accent' : 'border-graphite-600 text-graphite-300 hover:bg-graphite-800'}`}>
              {statusLabel(s)}
            </button>
          ))}
          <span className="ml-auto self-center text-sm text-graphite-500">
            {error ? '—' : loading ? t('loading') : `${workOrders.length} ${t('work_orders_word')}`}
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
                <th className="px-4 py-3">{t('wo')}</th>
                <th className="px-4 py-3">{t('project')}</th>
                <th className="px-4 py-3">{t('equipment')}</th>
                <th className="px-4 py-3">{t('priority')}</th>
                <th className="px-4 py-3">{t('assigned')}</th>
                <th className="px-4 py-3">{t('due')}</th>
                <th className="px-4 py-3">{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {workOrders.map((wo) => (
                <tr key={wo.id} className="border-b border-graphite-800 last:border-0 hover:bg-graphite-800/50">
                  <td className="px-4 py-3 font-mono text-accent">{wo.work_order_code}</td>
                  <td className="px-4 py-3 text-graphite-300">{wo.project_code}</td>
                  <td className="px-4 py-3 text-graphite-200">{wo.equipment_description}</td>
                  <td className="px-4 py-3"><StatusBadge status={wo.priority} /></td>
                  <td className="px-4 py-3 text-graphite-300">{wo.assigned_engineer_name ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-graphite-400">{wo.due_date ?? '—'}</td>
                  <td className="px-4 py-3"><StatusBadge status={wo.status} label={wo.status.replace('_', ' ')} /></td>
                </tr>
              ))}
              {workOrders.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-graphite-500">{t('no_wo_filter')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  );
}
