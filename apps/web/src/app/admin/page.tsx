'use client';

import { useEffect, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function AdminPage() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ entries: any[] }>('/api/admin/audit-log')
      .then((d) => setEntries(d.entries))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <TopBar title={t('nav_admin')} subtitle={t('admin_audit_sub')} />
      <div className="p-6">
        {error && (
          <div className="mb-4 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning">
            {error} — sign in as an ADMIN or EXECUTIVE account to view the audit log.
          </div>
        )}
        {entries && (
          <div className="card overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-graphite-700 text-xs uppercase text-graphite-400">
                <tr>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} className="border-b border-graphite-800 last:border-0">
                    <td className="px-4 py-3 text-xs text-graphite-400">{new Date(e.time).toLocaleString()}</td>
                    <td className="px-4 py-3 text-graphite-300">{e.user_name ?? 'system'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-accent">{e.action}</td>
                    <td className="px-4 py-3 text-xs text-graphite-400">{e.entity_type ? `${e.entity_type}:${e.entity_id}` : '—'}</td>
                    <td className="px-4 py-3 text-xs text-graphite-500">{JSON.stringify(e.details)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
