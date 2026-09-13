'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { useI18n, useLocalName } from '@/lib/i18n';

/**
 * Communications & Protocols.
 *
 * Answers the questions an operations engineer actually asks about the comms layer:
 *  - which relays are we blind to right now, and which have no redundancy?
 *  - which protocols is the estate actually using?
 *  - can I trust the timestamps on the fault timelines I'm looking at?
 *  - did anything fail to be ingested (i.e. did we lose an event)?
 */

type Tab = 'health' | 'protocols' | 'timesync' | 'gateways' | 'deadletter';

interface RelayHealth {
  relay_id: string;
  relay_code: string;
  manufacturer: string;
  model: string;
  project_code: string;
  province_name_en: string;
  city_name_en: string;
  configured_paths: string;
  connected_paths: string;
  has_active_path: boolean | null;
  is_redundant: boolean | null;
  last_data_at: string | null;
  worst_time_sync_quality: string | null;
  warnings: string[];
}

interface ProtocolDescriptor {
  protocol: string;
  displayName: string;
  family: string;
  transport: string;
  deliveryMode: string;
  defaultPort: number | null;
  implementation: string;
  commonVendors: string[];
  notes: string;
  capabilities: Record<string, boolean | number | string>;
}

const QUALITY_STYLE: Record<string, string> = {
  SUB_MICROSECOND: 'bg-status-healthy/20 text-status-healthy',
  SUB_MILLISECOND: 'bg-status-healthy/20 text-status-healthy',
  MILLISECOND: 'bg-accent/20 text-accent',
  SECOND: 'bg-status-warning/20 text-status-warning',
  GATEWAY_STAMPED: 'bg-status-warning/20 text-status-warning',
  UNKNOWN: 'bg-graphite-700 text-graphite-300',
};

const IMPL_STYLE: Record<string, string> = {
  NATIVE: 'bg-status-healthy/20 text-status-healthy',
  LIBRARY_BACKED: 'bg-accent/20 text-accent',
  ADAPTER_REQUIRED: 'bg-status-warning/20 text-status-warning',
  SIMULATED: 'bg-graphite-700 text-graphite-300',
};

export default function CommsPage() {
  const { t } = useI18n();
  const localName = useLocalName();
  const [tab, setTab] = useState<Tab>('health');
  const [health, setHealth] = useState<RelayHealth[]>([]);
  const [protocols, setProtocols] = useState<ProtocolDescriptor[]>([]);
  const [usage, setUsage] = useState<any[]>([]);
  const [timeSync, setTimeSync] = useState<any>(null);
  const [gateways, setGateways] = useState<any[]>([]);
  const [deadLetter, setDeadLetter] = useState<any[]>([]);
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Which gateway has an enable request in flight, and any error from the last attempt (e.g. a
  // non-admin trying it, which the API correctly rejects with 403).
  const [enabling, setEnabling] = useState<Record<string, boolean>>({});
  const [enableError, setEnableError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        if (tab === 'health') {
          const d = await apiFetch<{ relays: RelayHealth[] }>(`/api/comms/relay-health?onlyProblems=${onlyProblems}`);
          if (!cancelled) setHealth(d.relays ?? []);
        } else if (tab === 'protocols') {
          const [p, u] = await Promise.all([
            apiFetch<{ protocols: ProtocolDescriptor[] }>('/api/comms/protocols'),
            apiFetch<{ usage: any[] }>('/api/comms/protocol-usage').catch(() => ({ usage: [] })),
          ]);
          if (!cancelled) {
            setProtocols(p.protocols ?? []);
            setUsage(u.usage ?? []);
          }
        } else if (tab === 'timesync') {
          const d = await apiFetch<any>('/api/comms/time-sync');
          if (!cancelled) setTimeSync(d);
        } else if (tab === 'gateways') {
          const d = await apiFetch<{ gateways: any[] }>('/api/comms/gateways');
          if (!cancelled) setGateways(d.gateways ?? []);
        } else if (tab === 'deadletter') {
          const d = await apiFetch<{ entries: any[] }>('/api/comms/dead-letter');
          if (!cancelled) setDeadLetter(d.entries ?? []);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [tab, onlyProblems]);

  async function enableGateway(gatewayId: string) {
    if (enabling[gatewayId]) return;
    setEnabling((m) => ({ ...m, [gatewayId]: true }));
    setEnableError(null);
    try {
      await apiFetch(`/api/comms/gateways/${gatewayId}/enable`, { method: 'POST' });
      const d = await apiFetch<{ gateways: any[] }>('/api/comms/gateways');
      setGateways(d.gateways ?? []);
    } catch (e: any) {
      setEnableError(e?.message ?? 'Failed to enable gateway');
    } finally {
      setEnabling((m) => ({ ...m, [gatewayId]: false }));
    }
  }

  const usageByProtocol = new Map(usage.map((u) => [u.protocol, u]));

  return (
    <div className="space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold text-graphite-100">Communications &amp; Protocols</h1>
        <p className="mt-1 text-sm text-graphite-400">
          Every way data reaches this platform, and whether it is currently reaching it.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-graphite-700">
        {(
          [
            ['health', 'Relay comms health'],
            ['protocols', 'Protocol catalogue'],
            ['timesync', 'Time synchronisation'],
            ['gateways', 'Gateways'],
            ['deadletter', 'Ingest failures'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm transition-colors ${
              tab === key
                ? 'border-b-2 border-accent text-accent'
                : 'text-graphite-400 hover:text-graphite-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-status-critical/40 bg-status-critical/10 px-4 py-3 text-sm text-status-critical">
          {error}
        </div>
      )}
      {loading && <div className="text-sm text-graphite-400">Loading…</div>}

      {/* ---- Relay comms health ---- */}
      {tab === 'health' && !loading && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-xs text-graphite-400">
            <input
              type="checkbox"
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
              className="accent-accent"
            />
            Show only relays with a communication problem or no redundancy
          </label>

          {health.length === 0 ? (
            <div className="rounded-lg border border-graphite-700 bg-graphite-900 px-4 py-8 text-center text-sm text-graphite-400">
              {onlyProblems
                ? 'No relay currently has a communication problem or a single-path configuration.'
                : 'No relay communication paths are configured yet. Paths are registered by the edge gateway on first connection, or added in Administration.'}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-graphite-700">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-graphite-800 text-left text-xs uppercase text-graphite-400">
                  <tr>
                    <th className="px-3 py-2">Relay</th>
                    <th className="px-3 py-2">Location</th>
                    <th className="px-3 py-2">Paths</th>
                    <th className="px-3 py-2">Clock</th>
                    <th className="px-3 py-2">Last data</th>
                    <th className="px-3 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-graphite-800">
                  {health.map((r) => (
                    <tr key={r.relay_id} className="hover:bg-graphite-800/50">
                      <td className="px-3 py-2">
                        <div className="font-medium text-graphite-100">{r.relay_code}</div>
                        <div className="text-xs text-graphite-500">
                          {r.manufacturer} {r.model}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-graphite-300">
                        {localName(r.city_name_en, (r as any).city_name_fa)}
                        <div className="text-xs text-graphite-500">{localName(r.province_name_en, (r as any).province_name_fa)}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={r.has_active_path ? 'text-status-healthy' : 'text-status-critical'}>
                          {r.connected_paths}/{r.configured_paths} connected
                        </span>
                        <div className="text-xs">
                          {r.is_redundant ? (
                            <span className="text-status-healthy">redundant</span>
                          ) : (
                            <span className="text-status-warning">single path</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            QUALITY_STYLE[r.worst_time_sync_quality ?? 'UNKNOWN'] ?? QUALITY_STYLE.UNKNOWN
                          }`}
                        >
                          {r.worst_time_sync_quality ?? 'UNKNOWN'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-graphite-400">
                        {r.last_data_at ? new Date(r.last_data_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <ul className="space-y-0.5 text-xs text-graphite-400">
                          {r.warnings.map((w, i) => (
                            <li key={i}>• {w}</li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ---- Protocol catalogue ---- */}
      {tab === 'protocols' && !loading && (
        <div className="space-y-4">
          <p className="text-xs text-graphite-400">
            {protocols.length} protocols supported. &quot;In use&quot; counts configured paths across the estate.
            Implementation status tells a commissioning engineer what to expect: <strong>Native</strong> speaks to
            hardware directly, <strong>Library</strong> needs its npm package installed on the gateway, and{' '}
            <strong>Adapter</strong> needs a native stack or vendor SDK bound before it talks to real devices.
          </p>

          {['IEC61850', 'IEC60870', 'DNP3', 'MODBUS', 'MODERN', 'VENDOR', 'AUXILIARY', 'DEMO'].map((family) => {
            const inFamily = protocols.filter((p) => p.family === family);
            if (!inFamily.length) return null;
            return (
              <div key={family}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-graphite-400">{family}</h2>
                <div className="grid gap-2 md:grid-cols-2">
                  {inFamily.map((p) => {
                    const u = usageByProtocol.get(p.protocol);
                    return (
                      <div key={p.protocol} className="rounded-lg border border-graphite-700 bg-graphite-900 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-graphite-100">{p.displayName}</div>
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${IMPL_STYLE[p.implementation] ?? ''}`}>
                            {p.implementation.replace('_', ' ').toLowerCase()}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-graphite-400">
                          <span className="rounded bg-graphite-800 px-1.5 py-0.5">{p.transport}</span>
                          <span className="rounded bg-graphite-800 px-1.5 py-0.5">{p.deliveryMode}</span>
                          {p.defaultPort && <span className="rounded bg-graphite-800 px-1.5 py-0.5">:{p.defaultPort}</span>}
                          {p.capabilities.faultRecords && (
                            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-accent">fault records</span>
                          )}
                          {p.capabilities.disturbanceFiles && (
                            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-accent">COMTRADE</span>
                          )}
                          {u && Number(u.relay_count) > 0 && (
                            <span className="rounded bg-status-healthy/20 px-1.5 py-0.5 text-status-healthy">
                              in use: {u.relay_count} relays
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-graphite-400">{p.notes}</p>
                        {p.commonVendors.length > 0 && (
                          <p className="mt-1 text-[10px] text-graphite-500">Common on: {p.commonVendors.join(', ')}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Time sync ---- */}
      {tab === 'timesync' && !loading && timeSync && (
        <div className="space-y-4">
          <div className="rounded-lg border border-graphite-700 bg-graphite-900 p-4">
            <h2 className="text-sm font-medium text-graphite-100">Why this matters</h2>
            <p className="mt-1 text-xs leading-relaxed text-graphite-400">
              A fault timeline is only as precise as the worst clock in it. Events marked{' '}
              <span className="text-status-warning">GATEWAY_STAMPED</span> were timestamped when they arrived here, not
              by the relay, so they cannot establish the order of events inside a fast trip sequence. The platform
              records this per event rather than presenting every timeline as if it were millisecond-accurate.
            </p>
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-graphite-400">Configured paths by clock quality</h2>
            {timeSync.paths?.length ? (
              <div className="overflow-x-auto rounded-lg border border-graphite-700">
                <table className="w-full text-sm">
                  <thead className="bg-graphite-800 text-left text-xs uppercase text-graphite-400">
                    <tr>
                      <th className="px-3 py-2">Quality</th>
                      <th className="px-3 py-2">Paths</th>
                      <th className="px-3 py-2">Avg offset</th>
                      <th className="px-3 py-2">Worst offset</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-graphite-800">
                    {timeSync.paths.map((p: any) => (
                      <tr key={p.time_sync_quality}>
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] ${QUALITY_STYLE[p.time_sync_quality] ?? ''}`}>
                            {p.time_sync_quality}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-graphite-200">{p.path_count}</td>
                        <td className="px-3 py-2 text-graphite-300">
                          {p.avg_abs_offset_ms != null ? `${Number(p.avg_abs_offset_ms).toFixed(1)} ms` : '—'}
                        </td>
                        <td className="px-3 py-2 text-graphite-300">
                          {p.worst_abs_offset_ms != null ? `${Number(p.worst_abs_offset_ms).toFixed(1)} ms` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-lg border border-graphite-700 bg-graphite-900 px-4 py-6 text-center text-sm text-graphite-400">
                No path status reported yet. Time-sync supervision starts once a gateway connects.
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-graphite-400">
              Events recorded in the last 24 hours, by timestamp trust
            </h2>
            <div className="flex flex-wrap gap-2">
              {(timeSync.eventsLast24h ?? []).map((e: any) => (
                <div key={e.time_sync_quality} className="rounded-lg border border-graphite-700 bg-graphite-900 px-3 py-2">
                  <div className={`text-[10px] ${QUALITY_STYLE[e.time_sync_quality]?.split(' ')[1] ?? 'text-graphite-300'}`}>
                    {e.time_sync_quality}
                  </div>
                  <div className="text-lg font-semibold text-graphite-100">{e.event_count}</div>
                </div>
              ))}
              {!(timeSync.eventsLast24h ?? []).length && (
                <div className="text-sm text-graphite-400">No events in the last 24 hours.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- Gateways ---- */}
      {tab === 'gateways' && !loading && (
        <div className="overflow-x-auto rounded-lg border border-graphite-700">
          {enableError && (
            <div className="border-b border-status-critical/40 bg-status-critical/10 px-4 py-2 text-sm text-status-critical">
              {enableError}
            </div>
          )}
          {gateways.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-graphite-400">
              No edge gateways registered. A gateway registers itself on first contact and must then be enabled by an
              administrator before its events are accepted.
            </div>
          ) : (
            <table className="w-full min-w-[700px] text-sm">
              <thead className="bg-graphite-800 text-left text-xs uppercase text-graphite-400">
                <tr>
                  <th className="px-3 py-2">Gateway</th>
                  <th className="px-3 py-2">Site</th>
                  <th className="px-3 py-2">Version</th>
                  <th className="px-3 py-2">Last seen</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-graphite-800">
                {gateways.map((g) => (
                  <tr key={g.gateway_id}>
                    <td className="px-3 py-2 text-graphite-100">{g.display_name}</td>
                    <td className="px-3 py-2 text-graphite-300">
                      {localName(g.city_name_en, (g as any).city_name_fa) || '—'}
                      <div className="text-xs text-graphite-500">{localName(g.province_name_en, (g as any).province_name_fa)}</div>
                    </td>
                    <td className="px-3 py-2 text-graphite-400">{g.software_version ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-graphite-400">
                      {g.last_seen_at ? new Date(g.last_seen_at).toLocaleString() : 'never'}
                    </td>
                    <td className="px-3 py-2">
                      {!g.enabled ? (
                        <span className="rounded bg-status-warning/20 px-1.5 py-0.5 text-[10px] text-status-warning">
                          awaiting approval
                        </span>
                      ) : g.is_stale ? (
                        <span className="rounded bg-status-critical/20 px-1.5 py-0.5 text-[10px] text-status-critical">stale</span>
                      ) : (
                        <span className="rounded bg-status-healthy/20 px-1.5 py-0.5 text-[10px] text-status-healthy">online</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!g.enabled && (
                        <button
                          onClick={() => enableGateway(g.gateway_id)}
                          disabled={enabling[g.gateway_id]}
                          className="rounded border border-accent px-2 py-1 text-xs text-accent hover:bg-accent/10 disabled:opacity-50"
                        >
                          {enabling[g.gateway_id] ? 'Enabling…' : 'Enable'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---- Dead letter ---- */}
      {tab === 'deadletter' && !loading && (
        <div className="space-y-2">
          <p className="text-xs text-graphite-400">
            Events that could not be stored. These are kept rather than discarded, because silently dropping an event
            from a protection relay is how a real trip goes unrecorded.
          </p>
          {deadLetter.length === 0 ? (
            <div className="rounded-lg border border-graphite-700 bg-graphite-900 px-4 py-8 text-center text-sm text-status-healthy">
              No ingest failures. Every event received has been stored.
            </div>
          ) : (
            <div className="space-y-2">
              {deadLetter.map((d) => (
                <div key={d.id} className="rounded-lg border border-status-warning/40 bg-graphite-900 p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-status-warning">{d.reason}</span>
                    <span className="text-graphite-500">{new Date(d.received_at).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-graphite-500">gateway: {d.gateway_id ?? 'unknown'}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
