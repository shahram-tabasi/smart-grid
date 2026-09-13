'use client';

import { useEffect, useState } from 'react';
import { TopBar } from '@/components/TopBar';
import { StatusBadge } from '@/components/StatusBadge';
import { apiFetch } from '@/lib/api';
import { ErrorPanel, LoadingPanel } from '@/components/DataState';
import { useI18n } from '@/lib/i18n';

export default function FaultDetailPage({ params }: { params: { id: string } }) {
  const { t } = useI18n();
  const [fault, setFault] = useState<any>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/faults/${params.id}`)
      .then((d) => !cancelled && setFault(d))
      .catch((err: any) => !cancelled && setError(err?.message ?? 'Could not load this fault.'));
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  async function loadAi() {
    if (aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const analysis = await apiFetch(`/api/ai/analyses/fault/${fault.id}`);
      setFault((f: any) => ({ ...f, aiAnalyses: [analysis, ...(f.aiAnalyses ?? []).filter((a: any) => a.id !== analysis.id)] }));
    } catch (err: any) {
      // Without this catch the button simply flipped back to "Analyze" and nothing happened —
      // the request had failed, silently, and the operator kept clicking.
      setAiError(err?.message ?? t('analysis_failed'));
    } finally {
      setAiLoading(false);
    }
  }

  if (error) return <div className="p-6"><ErrorPanel message={error} onRetry={() => window.location.reload()} /></div>;
  if (!fault) return <div className="p-6"><LoadingPanel label={t('loading')} /></div>;

  return (
    <div>
      <TopBar title={fault.fault_code} subtitle={fault.fault_type} />
      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="card p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <StatusBadge status={fault.severity} />
              <StatusBadge status={fault.trip_status} />
              <StatusBadge status={fault.acknowledgement_status} />
              <StatusBadge status={fault.resolution_status} />
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
              <Field label="Project" value={fault.project_code} />
              <Field label="City" value={fault.city_name_en} />
              <Field label="Panel" value={fault.panel_name ?? '—'} />
              <Field label="Relay" value={fault.relay_code ?? '—'} />
              <Field label="Protection Function" value={fault.protection_function ?? '—'} />
              <Field label="Breaker" value={fault.breaker_status ?? '—'} />
              <Field label="Current" value={fault.current_a ? `${fault.current_a} A` : '—'} />
              <Field label="Voltage" value={fault.voltage_kv ? `${fault.voltage_kv} kV` : '—'} />
              <Field label="Frequency" value={fault.frequency_hz ? `${fault.frequency_hz} Hz` : '—'} />
              <Field label="Assigned Engineer" value={fault.assigned_engineer_name ?? 'Unassigned'} />
              <Field label="Root Cause Status" value={fault.root_cause_status} />
            </div>
          </div>

          <div className="card p-5">
            <h3 className="mb-1 text-sm font-semibold text-graphite-200">Fault Timeline</h3>
            {(() => {
              // A timeline is only as precise as its worst clock. If any entry was stamped on
              // arrival rather than by the relay, say so once at the top instead of letting the
              // millisecond formatting imply a precision the data does not have.
              const untrusted = (fault.timeline ?? []).filter((t: any) =>
                ['GATEWAY_STAMPED', 'UNKNOWN', 'SECOND'].includes(t.time_sync_quality ?? 'UNKNOWN')
              );
              if (!untrusted.length) return null;
              return (
                <p className="mb-3 rounded border border-status-warning/40 bg-status-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-status-warning">
                  {untrusted.length} of {fault.timeline.length} entries were timestamped on arrival at the
                  gateway, not by the relay. Their position in this sequence is approximate — do not rely on
                  their relative ordering when the events are milliseconds apart.
                </p>
              );
            })()}
            <ol className="relative border-l border-graphite-700 pl-5">
              {fault.timeline.map((t: any, i: number) => {
                const quality = t.time_sync_quality ?? 'UNKNOWN';
                const trusted = ['SUB_MICROSECOND', 'SUB_MILLISECOND', 'MILLISECOND'].includes(quality);
                return (
                  <li key={i} className="mb-5 last:mb-0">
                    <span
                      className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${
                        trusted ? 'bg-accent' : 'bg-status-warning'
                      }`}
                    />
                    <div className="mono-nums flex flex-wrap items-center gap-2 text-xs text-graphite-500">
                      <span>{new Date(t.time).toISOString().replace('T', ' ').slice(0, 23)}</span>
                      {!trusted && (
                        <span className="rounded bg-status-warning/20 px-1 py-0.5 text-[9px] text-status-warning">
                          approximate
                        </span>
                      )}
                      {t.source_protocol && (
                        <span className="rounded bg-graphite-800 px-1 py-0.5 text-[9px] text-graphite-400">
                          {t.source_protocol}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-graphite-200">{t.description}</div>
                  </li>
                );
              })}
            </ol>
          </div>

          {fault.comtrade?.length > 0 && (
            <div className="card p-5">
              <h3 className="mb-3 text-sm font-semibold text-graphite-200">Disturbance Record (COMTRADE)</h3>
              {fault.comtrade.map((c: any) => (
                <WaveformPreview key={c.id} record={c} />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-graphite-200">✦ Simorgh Power Intelligence</h3>
              <button onClick={loadAi} disabled={aiLoading} className="rounded-md bg-accent/20 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/30 disabled:opacity-50">
                {aiLoading ? t('analyzing') : t('analyze')}
              </button>
            </div>
            {aiError && (
              <div className="mb-3 rounded-lg border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
                {aiError}
              </div>
            )}
            {(fault.aiAnalyses ?? []).length === 0 ? (
              <p className="text-sm text-graphite-500">{t('no_analysis_yet')}</p>
            ) : (
              fault.aiAnalyses.map((a: any) => (
                <div key={a.id} className="mb-4 space-y-3 rounded-lg border border-accent/20 bg-accent/5 p-3 text-sm last:mb-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-graphite-100">Probable Cause</span>
                    <span className="mono-nums text-xs font-semibold text-accent">{a.confidence_score}% confidence</span>
                  </div>
                  <p className="text-graphite-300">{a.probable_cause}</p>
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase text-graphite-500">Evidence</div>
                    <ul className="list-inside list-disc space-y-0.5 text-xs text-graphite-400">
                      {(typeof a.evidence === 'string' ? JSON.parse(a.evidence) : a.evidence).map((e: string, i: number) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase text-graphite-500">Recommendation</div>
                    <p className="text-graphite-300">{a.recommended_action}</p>
                  </div>
                  <div className="flex items-center justify-between text-xs text-graphite-500">
                    <span>Required: {a.required_engineer_role}</span>
                    <StatusBadge status={a.priority} />
                  </div>
                  <p className="text-[11px] italic text-graphite-600">Advisory only — no setting or control action is applied automatically. Requires explicit human approval.</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase text-graphite-500">{label}</div>
      <div className="text-graphite-200">{value}</div>
    </div>
  );
}

function WaveformPreview({ record }: { record: any }) {
  const preview = record.waveform_preview ?? {};
  const channels = ['IA', 'IB', 'IC'];
  const colors: Record<string, string> = { IA: '#3b82f6', IB: '#eab308', IC: '#ef4444' };
  const width = 600, height = 120;

  function path(values: number[]) {
    if (!values?.length) return '';
    const max = Math.max(...values.map(Math.abs), 1);
    return values
      .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i / (values.length - 1)) * width} ${height / 2 - (v / max) * (height / 2 - 4)}`)
      .join(' ');
  }

  return (
    <div className="rounded-lg border border-graphite-700 p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="#1e2733" />
        {channels.map((ch) => (
          <path key={ch} d={path(preview[ch] ?? [])} fill="none" stroke={colors[ch]} strokeWidth={1.5} />
        ))}
      </svg>
      <div className="mt-2 flex gap-4 text-xs">
        {channels.map((ch) => (
          <span key={ch} style={{ color: colors[ch] }}>■ {ch}</span>
        ))}
        <span className="ml-auto text-graphite-500">{record.sample_rate_hz} Hz · {record.duration_ms}ms window</span>
      </div>
    </div>
  );
}
