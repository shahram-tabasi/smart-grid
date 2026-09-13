'use client';

import { useEffect, useState } from 'react';
import { apiFetch, SessionExpiredError } from '@/lib/api';
import { TopBar } from '@/components/TopBar';
import { LocationPicker, type Country, type Province, type City } from '@/components/LocationPicker';
import { useI18n, useStatusLabel, Ltr } from '@/lib/i18n';

/**
 * Guided provisioning: create a real project and register a real relay.
 *
 * Deliberately a linear wizard rather than five separate CRUD screens. Registering a relay means
 * creating a chain — project → substation → switchgear → panel → relay → communication path — and
 * every step needs the id from the one before it. A wizard makes that order impossible to get wrong.
 *
 * Nothing on this screen touches a device. It creates records and describes where to READ from.
 */

interface Reference {
  countries: Country[];
  provinces: Province[];
  cities: City[];
  customers: { id: string; name: string }[];
  pointMaps: { profile_id: string; display_name: string; manufacturer: string }[];
  protocols: {
    protocol: string;
    tier: 'RECOMMENDED' | 'AVAILABLE' | 'ADVANCED';
    displayName: string;
    family: string;
    defaultPort: number | null;
    implementation: string;
    needsHost: boolean;
    needsSerial: boolean;
    needsPointMap: boolean;
    carriesFaultRecords: boolean;
    carriesEvents: boolean;
    deliveryMode: string;
    notes: string;
  }[];
}

const STEP_KEYS = ['step_project', 'step_substation', 'step_switchgear', 'step_panel', 'step_relay', 'step_connection'] as const;

const MANUFACTURERS = ['Siemens', 'ABB', 'Hitachi Energy', 'Schneider Electric', 'SEL', 'GE Multilin', 'Other'];

/**
 * The required-field marker, as its own left-to-right span.
 *
 * In Persian the page is right-to-left, and a bare "*" appended to a label is punctuation: the
 * browser moves it to the visual left, so "Protocol *" rendered as "* Protocol". Isolating it keeps
 * it after the label word in both languages.
 */
function Req() {
  return <Ltr className="text-status-critical">*</Ltr>;
}

export default function ProvisioningPage() {
  const { t, lang } = useI18n();
  const statusLabel = useStatusLabel();
  const [ref, setRef] = useState<Reference | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Default to the short list. Thirty protocols in a dropdown is where a first-time trial stalls.
  const [showAllProtocols, setShowAllProtocols] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ reachable: boolean | null; message: string; caveat: string | null } | null>(null);

  // ids captured as we go
  const [projectId, setProjectId] = useState('');
  const [substationId, setSubstationId] = useState('');
  const [switchgearId, setSwitchgearId] = useState('');
  const [panelId, setPanelId] = useState('');
  const [relayId, setRelayId] = useState('');
  const [done, setDone] = useState(false);

  const [f, setF] = useState({
    code: '', name: '', countryCode: 'IR', provinceId: '', cityId: '', customerId: '', projectType: 'RELAY_UPGRADE',
    voltageLevel: '20kV', status: 'COMMISSIONING',
    subName: '', sgName: '', panelName: '', panelType: 'FEEDER',
    relayCode: '', manufacturer: 'Siemens', model: '', firmwareVersion: '', serialNumber: '',
    pathId: '', protocol: 'IEC60870_5_104', role: 'PRIMARY', host: '', port: '',
    serialDevice: '', pollIntervalMs: '10000', supervisionTimeoutSec: '60', pointMapProfileId: '',
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    apiFetch<Reference>('/api/provisioning/reference')
      .then(setRef)
      .catch((e) => setError(`Could not load reference data: ${e.message}. Are you signed in?`));
  }, []);

  const proto = ref?.protocols.find((p) => p.protocol === f.protocol);
  /**
   * Fold a newly created province or city into the in-memory reference list.
   *
   * Cheaper and less disruptive than refetching the whole reference payload (433 cities, 54
   * countries, 30 protocols) just because someone typed one town name — and it keeps the half-filled
   * wizard form intact, which a refetch-and-rerender would be at risk of disturbing.
   */
  function absorbCreated(created: { province?: Province; city?: City }) {
    setRef((prev) => {
      if (!prev) return prev;
      const provinces = created.province && !prev.provinces.some((p) => p.id === created.province!.id)
        ? [...prev.provinces, created.province]
        : prev.provinces;
      const cities = created.city && !prev.cities.some((c) => c.id === created.city!.id)
        ? [...prev.cities, created.city]
        : prev.cities;
      return { ...prev, provinces, cities };
    });
  }

  async function call(path: string, body: any) {
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      return await apiFetch<any>(path, { method: 'POST', body: JSON.stringify(body) });
    } catch (e: any) {
      if (e instanceof SessionExpiredError) {
        // Send them somewhere they can actually fix it, keeping the page to return to.
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        return null;
      }
      // apiFetch now attaches `problems` directly; no more parsing JSON out of a message string.
      if (Array.isArray(e?.problems)) setProblems(e.problems);
      setError(e?.message ?? 'Request failed');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await apiFetch<any>('/api/provisioning/test-connection', {
        method: 'POST',
        body: JSON.stringify({ host: f.host || undefined, port: f.port ? Number(f.port) : undefined, protocol: f.protocol }),
      });
      setTestResult({ reachable: r.reachable, message: r.message, caveat: r.caveat ?? null });
    } catch (e: any) {
      setTestResult({ reachable: false, message: e?.message ?? 'Test failed', caveat: null });
    } finally {
      setTesting(false);
    }
  }

  const next = async () => {
    if (step === 0) {
      const r = await call('/api/provisioning/projects', {
        code: f.code, name: f.name, provinceId: f.provinceId, cityId: f.cityId,
        customerId: f.customerId || undefined, projectType: f.projectType,
        voltageLevel: f.voltageLevel, status: f.status,
      });
      if (r) { setProjectId(r.id); setStep(1); }
    } else if (step === 1) {
      const r = await call('/api/provisioning/substations', {
        projectId, name: f.subName, voltageLevel: f.voltageLevel,
      });
      if (r) { setSubstationId(r.id); setStep(2); }
    } else if (step === 2) {
      const r = await call('/api/provisioning/switchgear', {
        substationId, name: f.sgName, voltageLevel: f.voltageLevel,
      });
      if (r) { setSwitchgearId(r.id); setStep(3); }
    } else if (step === 3) {
      const r = await call('/api/provisioning/panels', {
        switchgearId, name: f.panelName, panelType: f.panelType,
      });
      if (r) { setPanelId(r.id); setStep(4); }
    } else if (step === 4) {
      const r = await call('/api/provisioning/relays', {
        panelId, relayCode: f.relayCode, manufacturer: f.manufacturer, model: f.model,
        voltageLevel: f.voltageLevel, firmwareVersion: f.firmwareVersion || undefined,
        serialNumber: f.serialNumber || undefined,
      });
      if (r) {
        setRelayId(r.id);
        set('pathId', `${f.relayCode.toLowerCase()}-primary`);
        setStep(5);
      }
    } else if (step === 5) {
      const r = await call(`/api/provisioning/relays/${relayId}/paths`, {
        pathId: f.pathId, protocol: f.protocol, role: f.role,
        host: f.host || undefined,
        port: f.port ? Number(f.port) : undefined,
        serialDevice: f.serialDevice || undefined,
        pollIntervalMs: f.pollIntervalMs ? Number(f.pollIntervalMs) : undefined,
        supervisionTimeoutSec: Number(f.supervisionTimeoutSec),
        pointMapProfileId: f.pointMapProfileId || undefined,
      });
      if (r) { setWarnings(r.warnings ?? []); setDone(true); }
    }
  };

  const input = 'w-full rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-2 text-sm text-graphite-100 focus:border-accent focus:outline-none';
  const label = 'mb-1 block text-xs text-graphite-400';

  if (done) {
    return (
      <div>
        <TopBar title={t('nav_provisioning')} subtitle={t('relay_registered')} />
        <div className="p-6">
          <div className="card max-w-2xl p-6">
            <h2 className="text-lg font-semibold text-status-healthy">Relay {f.relayCode} registered</h2>
            <p className="mt-2 text-sm text-graphite-300">
              Project <strong>{f.code}</strong> now contains this relay and one communication path.
            </p>

            {warnings.length > 0 && (
              <div className="mt-4 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3">
                <p className="mb-1 text-xs font-medium text-status-warning">Before this reads real data:</p>
                <ul className="space-y-1 text-xs text-graphite-300">
                  {warnings.map((w, i) => <li key={i}>• {w}</li>)}
                </ul>
              </div>
            )}

            <div className="mt-4 rounded-lg border border-graphite-700 bg-graphite-850 p-3">
              <p className="mb-2 text-xs font-medium text-graphite-200">Next: point the Edge Gateway at it</p>
              <p className="mb-2 text-[11px] leading-relaxed text-graphite-400">
                The relay is registered but nothing is reading it yet. The gateway runs at the site, connects
                outbound only, and is what actually talks to the device.
              </p>
              <pre className="overflow-x-auto rounded bg-graphite-950 p-2 text-[10px] text-graphite-300">
{`# on the gateway machine
SIMULATE=false \\
GATEWAY_ID=gw-${f.code.toLowerCase()} \\
INGEST_URL=http://<this-server>:4000/api/ingest/events \\
INGEST_TOKEN=<your token> \\
npm run dev:gateway`}
              </pre>
              <p className="mt-2 text-[11px] text-graphite-400">
                Then approve the gateway under <strong>Communications → Gateways</strong>, and watch{' '}
                <strong>Communications → Relay comms health</strong>.
              </p>
            </div>

            <div className="mt-4 flex gap-2">
              <a href={`/projects`} className="rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent-dim">
                {t('view_projects')}
              </a>
              <a href="/comms" className="rounded-lg border border-graphite-600 px-3 py-2 text-sm text-graphite-200 hover:bg-graphite-800">
                Communications
              </a>
              <button
                onClick={() => { setDone(false); setStep(0); setWarnings([]); }}
                className="rounded-lg border border-graphite-600 px-3 py-2 text-sm text-graphite-300 hover:bg-graphite-800"
              >
                {t('register_another')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <TopBar title={t('nav_provisioning')} subtitle={t('prov_sub')} />
      <div className="p-6">
        <div className="mb-5 flex flex-wrap gap-1">
          {STEP_KEYS.map((s, i) => (
            <div
              key={s}
              className={`rounded-lg px-3 py-1.5 text-xs ${
                i === step ? 'bg-accent/20 text-accent'
                : i < step ? 'bg-status-healthy/15 text-status-healthy'
                : 'bg-graphite-800 text-graphite-500'
              }`}
            >
              {i + 1}. {t(s)} {i < step && '✓'}
            </div>
          ))}
        </div>

        <div className="card max-w-2xl p-5">
          {!ref && !error && <p className="text-sm text-graphite-400">{t('loading')}</p>}

          {ref && step === 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-graphite-200">{t('step_project')}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={label}>{t('project_code')} <Req /></label>
                  <input className={input} value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="TRIAL-001" /></div>
                <div><label className={label}>{t('name')} <Req /></label>
                  <input className={input} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Workshop trial" /></div>
                <LocationPicker
                  countries={ref.countries ?? []}
                  provinces={ref.provinces}
                  cities={ref.cities}
                  countryCode={f.countryCode}
                  provinceId={f.provinceId}
                  cityId={f.cityId}
                  onChange={(next) =>
                    setF((prev) => ({ ...prev, countryCode: next.countryCode, provinceId: next.provinceId, cityId: next.cityId }))
                  }
                  onCreated={absorbCreated}
                  inputClass={input}
                  labelClass={label}
                  fa={lang === 'fa'}
                />
                <div><label className={label}>{t('voltage_level')} <Req /></label>
                  <input className={input} value={f.voltageLevel} onChange={(e) => set('voltageLevel', e.target.value)} placeholder="20kV" /></div>
                <div><label className={label}>{t('status')}</label>
                  <select className={input} value={f.status} onChange={(e) => set('status', e.target.value)}>
                    {['PLANNING','ENGINEERING','PROCUREMENT','MANUFACTURING','FAT','INSTALLATION','COMMISSIONING','RUNNING'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                  </select></div>
              </div>
              <p className="text-[11px] text-graphite-500">
                {t('loc_note')}
              </p>
            </div>
          )}

          {ref && step === 1 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-graphite-200">{t('substation_plant')}</h2>
              <div><label className={label}>{t('name')} <Req /></label>
                <input className={input} value={f.subName} onChange={(e) => set('subName', e.target.value)} placeholder="Workshop Test Bay" /></div>
            </div>
          )}

          {ref && step === 2 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-graphite-200">{t('step_switchgear')}</h2>
              <div><label className={label}>{t('name')} <Req /></label>
                <input className={input} value={f.sgName} onChange={(e) => set('sgName', e.target.value)} placeholder="Test Switchgear 01" /></div>
            </div>
          )}

          {ref && step === 3 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-graphite-200">{t('step_panel')}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={label}>{t('name')} <Req /></label>
                  <input className={input} value={f.panelName} onChange={(e) => set('panelName', e.target.value)} placeholder="Feeder 01" /></div>
                <div><label className={label}>{t('type')}</label>
                  <select className={input} value={f.panelType} onChange={(e) => set('panelType', e.target.value)}>
                    {['FEEDER','INCOMER','BUS_COUPLER','TRANSFORMER','CAPACITOR','MOTOR','METERING'].map((t) => <option key={t}>{t}</option>)}
                  </select></div>
              </div>
            </div>
          )}

          {ref && step === 4 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-graphite-200">{t('protection_relay')}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={label}>{t('relay_code')} <Req /></label>
                  <input className={input} value={f.relayCode} onChange={(e) => set('relayCode', e.target.value)} placeholder="TRIAL-R01" /></div>
                <div><label className={label}>{t('manufacturer')} <Req /></label>
                  <select className={input} value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)}>
                    {MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
                  </select></div>
                <div><label className={label}>{t('model')} <Req /></label>
                  <input className={input} value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="SIPROTEC 5 7SJ82" /></div>
                <div><label className={label}>{t('firmware')}</label>
                  <input className={input} value={f.firmwareVersion} onChange={(e) => set('firmwareVersion', e.target.value)} /></div>
              </div>
            </div>
          )}

          {ref && step === 5 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-graphite-200">{t('how_gateway_reaches')}</h2>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className={label} style={{ marginBottom: 0 }}>{t('protocol')} <Req /></label>
                  <button
                    type="button"
                    onClick={() => setShowAllProtocols((v) => !v)}
                    className="text-[11px] text-accent hover:underline"
                  >
                    {showAllProtocols ? t('show_recommended') : `${t('show_all_30')}`}
                  </button>
                </div>

                {!showAllProtocols ? (
                  // Card picker for the five that work over Ethernet with no extra setup.
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {ref.protocols.filter((p) => p.tier === 'RECOMMENDED').map((p) => (
                      <button
                        key={p.protocol}
                        type="button"
                        onClick={() => {
                          set('protocol', p.protocol);
                          if (p.defaultPort) set('port', String(p.defaultPort));
                        }}
                        className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                          f.protocol === p.protocol
                            ? 'border-accent bg-accent/10'
                            : 'border-graphite-700 hover:border-graphite-600 hover:bg-graphite-800'
                        }`}
                      >
                        <div className="text-xs font-medium text-graphite-100">{p.displayName}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1 text-[9px]">
                          {p.defaultPort && (
                            <span className="rounded bg-graphite-800 px-1 py-0.5 text-graphite-400"><Ltr>port {p.defaultPort}</Ltr></span>
                          )}
                          {p.carriesEvents && (
                            <span className="rounded bg-accent/20 px-1 py-0.5 text-accent">events</span>
                          )}
                          {p.needsPointMap && (
                            <span className="rounded bg-status-warning/20 px-1 py-0.5 text-status-warning">needs point map</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <select className={input} value={f.protocol} onChange={(e) => {
                    const p = ref.protocols.find((x) => x.protocol === e.target.value);
                    set('protocol', e.target.value);
                    if (p?.defaultPort) set('port', String(p.defaultPort));
                  }}>
                    <optgroup label="Recommended — Ethernet, no extra setup">
                      {ref.protocols.filter((p) => p.tier === 'RECOMMENDED')
                        .map((p) => <option key={p.protocol} value={p.protocol}>{p.displayName}</option>)}
                    </optgroup>
                    <optgroup label="Available — needs serial hardware or an extra package">
                      {ref.protocols.filter((p) => p.tier === 'AVAILABLE')
                        .map((p) => <option key={p.protocol} value={p.protocol}>{p.displayName}</option>)}
                    </optgroup>
                    <optgroup label="Advanced — needs a native stack, or legacy">
                      {ref.protocols.filter((p) => p.tier === 'ADVANCED')
                        .map((p) => <option key={p.protocol} value={p.protocol}>{p.displayName}</option>)}
                    </optgroup>
                  </select>
                )}

                {!showAllProtocols && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-graphite-500">
                    These five reach a relay over Ethernet with nothing else to install. The other{' '}
                    {ref.protocols.length - ref.protocols.filter((p) => p.tier === 'RECOMMENDED').length} cover serial
                    links, legacy fleets and supporting channels.
                  </p>
                )}
              </div>

              {proto && (
                <div className="rounded-lg border border-graphite-700 bg-graphite-850 p-3 text-[11px] leading-relaxed text-graphite-400">
                  <div className="mb-1 flex flex-wrap gap-1">
                    <span className={`rounded px-1.5 py-0.5 ${
                      proto.implementation === 'NATIVE' ? 'bg-status-healthy/20 text-status-healthy'
                      : proto.implementation === 'LIBRARY_BACKED' ? 'bg-accent/20 text-accent'
                      : 'bg-status-warning/20 text-status-warning'}`}>
                      {proto.implementation.replace('_',' ').toLowerCase()}
                    </span>
                    {proto.carriesFaultRecords && <span className="rounded bg-accent/20 px-1.5 py-0.5 text-accent">fault records</span>}
                    {proto.carriesEvents && <span className="rounded bg-accent/20 px-1.5 py-0.5 text-accent">time-tagged events</span>}
                  </div>
                  {proto.notes}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={label}>{t('path_id')} <Req /></label>
                  <input className={input} value={f.pathId} onChange={(e) => set('pathId', e.target.value)} /></div>
                <div><label className={label}>{t('role')}</label>
                  <select className={input} value={f.role} onChange={(e) => set('role', e.target.value)}>
                    {['PRIMARY','BACKUP','AUXILIARY'].map((r) => <option key={r}>{r}</option>)}
                  </select></div>

                {proto?.needsHost && (<>
                  <div><label className={label}>{t('relay_ip')} <Req /></label>
                    <input className={input} value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="192.168.10.50" /></div>
                  <div><label className={label}>{t('port')}</label>
                    <input className={input} value={f.port} onChange={(e) => set('port', e.target.value)} /></div>
                </>)}

                {proto?.needsSerial && (
                  <div><label className={label}>Serial device <Req /></label>
                    <input className={input} value={f.serialDevice} onChange={(e) => set('serialDevice', e.target.value)} placeholder="/dev/ttyS0 or COM3" /></div>
                )}

                <div><label className={label}>{t('poll_interval')}</label>
                  <input className={input} value={f.pollIntervalMs} onChange={(e) => set('pollIntervalMs', e.target.value)} /></div>
                <div><label className={label}>{t('supervision_timeout')}</label>
                  <input className={input} value={f.supervisionTimeoutSec} onChange={(e) => set('supervisionTimeoutSec', e.target.value)} /></div>

                {proto?.needsPointMap && (
                  <div className="sm:col-span-2">
                    <label className={label}>{t('point_map_profile')} <Req /> — {t('point_map_why')}</label>
                    <select className={input} value={f.pointMapProfileId} onChange={(e) => set('pointMapProfileId', e.target.value)}>
                      <option value="">—</option>
                      {ref.pointMaps.map((m) => <option key={m.profile_id} value={m.profile_id}>{m.display_name}</option>)}
                    </select>
                    <p className="mt-1 text-[10px] text-graphite-500">
                      {t('point_map_caveat')}
                    </p>
                  </div>
                )}
              </div>

              {/* Reachability check — catches the wrong IP / wrong VLAN / protocol-not-enabled
                  problems that otherwise only surface as a silent OFFLINE relay later. */}
              <div className="rounded-lg border border-graphite-700 bg-graphite-850 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={testConnection}
                    disabled={testing || (proto?.needsHost && !f.host)}
                    className="rounded-lg border border-accent/60 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
                  >
                    {testing ? t('testing') : t('test_connection')}
                  </button>
                  <span className="text-[11px] text-graphite-500">
                    {t('test_hint')}
                  </span>
                </div>

                {testResult && (
                  <div
                    className={`mt-2 rounded border px-2.5 py-2 text-[11px] leading-relaxed ${
                      testResult.reachable === true
                        ? 'border-status-healthy/40 bg-status-healthy/10 text-status-healthy'
                        : testResult.reachable === false
                        ? 'border-status-critical/40 bg-status-critical/10 text-status-critical'
                        : 'border-graphite-600 bg-graphite-800 text-graphite-300'
                    }`}
                  >
                    <Ltr>{testResult.message}</Ltr>
                    {testResult.caveat && (
                      <div className="mt-1 text-graphite-400">{testResult.caveat}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {(error || problems.length > 0) && (
            <div className="mt-4 rounded-lg border border-status-critical/40 bg-status-critical/10 p-3">
              {error && <p className="text-xs text-status-critical">{error}</p>}
              {problems.length > 0 && (
                <ul className="mt-1 space-y-1 text-xs text-graphite-300">
                  {problems.map((p, i) => <li key={i}>• {p}</li>)}
                </ul>
              )}
            </div>
          )}

          {ref && (
            <div className="mt-5 flex gap-2">
              {step > 0 && (
                <button onClick={() => setStep(step - 1)} disabled={busy}
                  className="rounded-lg border border-graphite-600 px-3 py-2 text-sm text-graphite-300 hover:bg-graphite-800">
                  {t('back')}
                </button>
              )}
              <button onClick={next} disabled={busy}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-60">
                {busy ? t('working') : step === 5 ? t('register_relay') : t('create_continue')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
