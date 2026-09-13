'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { GeoMap, MapMarker, ProjectPin } from '@/components/GeoMap';
import { useI18n, useLocalName } from '@/lib/i18n';

/**
 * Full-screen map command centre.
 *
 * The map is the screen, not a widget on it. Everything else is an overlay panel that steps
 * through the equipment hierarchy:
 *
 *     City  →  Projects  →  Project (+ substations/panels)  →  Relay status
 *
 * One click per step, with a breadcrumb to go back. This mirrors how the equipment is actually
 * organised, so an operator who clicks a red circle reaches the relay causing it in three clicks
 * without ever leaving the map.
 */

type Level = 'none' | 'city' | 'project' | 'relay';

interface CityDetail {
  cityId: string; nameEn: string; nameFa: string; projectCount: number;
  activeProjectCount: number; runningProjectCount: number;
  criticalAlarmCount: number; recentFaultCount: number;
  relayHealth: { status: string; count: number }[];
  recentFaults: { id: string; fault_code: string; fault_type: string; severity: string; timestamp: string; resolution_status: string }[];
}

interface ProjectRow {
  id: string; code: string; name: string; status: string;
  overall_progress: number; health_score: number;
  city_name_en: string; province_name_en: string;
  city_name_fa?: string; province_name_fa?: string;
  requires_engineering_intervention?: boolean; has_comm_problem?: boolean;
}

interface RelayRow {
  id: string; relay_code: string; manufacturer: string; model: string;
  protocol: string; comm_status: string; health_status: string; health_score: number;
  breaker_status: string; trip_count: number; alarm_count: number;
  last_communication_at: string | null; panel_name?: string;
}

const STATUS_DOT: Record<string, string> = {
  HEALTHY: 'bg-status-healthy', WARNING: 'bg-status-warning', ATTENTION: 'bg-status-attention',
  CRITICAL: 'bg-status-critical', OFFLINE: 'bg-status-offline',
  ONLINE: 'bg-status-healthy', DEGRADED: 'bg-status-warning', UNKNOWN: 'bg-status-offline',
};

export default function MapPage() {
  const { lang } = useI18n();
  const localName = useLocalName();
  const fa = lang === 'fa';

  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [pins, setPins] = useState<ProjectPin[]>([]);
  const [countries, setCountries] = useState<any[]>([]);

  // Drill-down state
  const [level, setLevel] = useState<Level>('none');
  const [city, setCity] = useState<CityDetail | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [project, setProject] = useState<any>(null);
  const [relays, setRelays] = useState<RelayRow[]>([]);
  const [relay, setRelay] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  // Location picker
  const [picking, setPicking] = useState(false);
  const [pickProjectId, setPickProjectId] = useState('');
  const [pickList, setPickList] = useState<any[]>([]);
  const [draft, setDraft] = useState<{ lat: number; lon: number } | null>(null);
  const [pickCountry, setPickCountry] = useState('');
  const [pickLabel, setPickLabel] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadPins = useCallback(() => {
    apiFetch<{ pins: ProjectPin[] }>('/api/map/project-pins').then((d) => setPins(d.pins ?? [])).catch(() => setPins([]));
  }, []);

  useEffect(() => {
    apiFetch<{ markers: MapMarker[] }>('/api/map/markers').then((d) => setMarkers(d.markers ?? [])).catch(() => setMarkers([]));
    apiFetch<{ countries: any[] }>('/api/map/countries').then((d) => setCountries(d.countries ?? [])).catch(() => {});
    loadPins();
  }, [loadPins]);

  // ---- drill-down steps ------------------------------------------------------------------------

  /**
   * Every drill-down request carries a sequence number and only the newest one may write state.
   *
   * Without this, clicking two markers in quick succession — the normal way an operator scans a busy
   * map — produced two failures. If the first response landed last, the panel settled on the relay
   * the operator did NOT click, showing its comm status, breaker status and trip count under the
   * other relay's breadcrumb. And because the older request's `finally` cleared `loading`, the panel
   * could drop its loading state and render the PREVIOUS project's figures under the new selection.
   * On a protection console, reading the wrong device's status with no indication anything is wrong
   * is the most consequential class of bug in this screen.
   */
  const drillId = useRef(0);

  async function openCity(cityId: string) {
    const id = ++drillId.current;
    setLoading(true); setPanelError(null); setLevel('city'); setProject(null); setRelay(null);
    try {
      const [detail, list] = await Promise.all([
        apiFetch<CityDetail>(`/api/map/cities/${cityId}`),
        apiFetch<{ projects: ProjectRow[] }>(`/api/projects?cityId=${cityId}`),
      ]);
      if (id !== drillId.current) return;
      setCity(detail);
      setProjects(list.projects ?? []);
    } catch (e: any) {
      if (id !== drillId.current) return;
      setPanelError(e?.message ?? 'Failed to load');
    } finally { if (id === drillId.current) setLoading(false); }
  }

  async function openProject(projectId: string) {
    const id = ++drillId.current;
    // Cleared up front so a stale project's figures can never sit under a new selection.
    setLoading(true); setPanelError(null); setLevel('project'); setRelay(null); setProject(null); setRelays([]);
    try {
      const [detail, hierarchy] = await Promise.all([
        apiFetch<any>(`/api/projects/${projectId}`),
        apiFetch<any>(`/api/projects/${projectId}/hierarchy`),
      ]);
      if (id !== drillId.current) return;
      setProject(detail);
      // Flatten the hierarchy to the relay list — that is what an operator is looking for here.
      const flat: RelayRow[] = [];
      for (const sub of hierarchy.substations ?? []) {
        for (const sg of sub.switchgear ?? []) {
          for (const pnl of sg.panels ?? []) {
            for (const r of pnl.relays ?? []) flat.push({ ...r, panel_name: pnl.name });
          }
        }
      }
      setRelays(flat);
    } catch (e: any) {
      if (id !== drillId.current) return;
      setPanelError(e?.message ?? 'Failed to load');
    } finally { if (id === drillId.current) setLoading(false); }
  }

  /** A pin click jumps straight to that project, skipping the city step. */
  async function openProjectFromPin(projectId: string) {
    setCity(null);
    await openProject(projectId);
  }

  async function openRelay(relayId: string) {
    const id = ++drillId.current;
    setLoading(true); setPanelError(null); setLevel('relay'); setRelay(null);
    try {
      // The endpoint returns { hierarchy, relay, protectionFunctions, recentEvents, faults } —
      // flatten it here so the panel reads one object.
      const d = await apiFetch<any>(`/api/relays/${relayId}`);
      if (id !== drillId.current) return;
      setRelay({
        ...d.relay,
        hierarchy: d.hierarchy,
        protectionFunctions: d.protectionFunctions ?? [],
        recentEvents: d.recentEvents ?? [],
        faults: d.faults ?? [],
      });
    } catch (e: any) {
      if (id !== drillId.current) return;
      setPanelError(e?.message ?? 'Failed to load');
    } finally { if (id === drillId.current) setLoading(false); }
  }

  function closePanel() {
    // Invalidate anything in flight so a late response cannot reopen a panel the operator closed.
    drillId.current++;
    setLoading(false);
    setLevel('none'); setCity(null); setProject(null); setRelay(null); setPanelError(null);
  }

  // ---- location picker -------------------------------------------------------------------------

  async function startPicking() {
    setPicking(true); setMsg(null); setDraft(null); closePanel();
    try {
      const d = await apiFetch<{ projects: any[] }>('/api/provisioning/projects');
      setPickList(d.projects ?? []);
    } catch {
      setMsg({ ok: false, text: fa ? 'برای تعیین موقعیت باید وارد شوید.' : 'Sign in to set a location.' });
    }
  }

  async function saveLocation() {
    if (!pickProjectId || !draft) return;
    try {
      await apiFetch(`/api/provisioning/projects/${pickProjectId}/location`, {
        method: 'PUT',
        body: JSON.stringify({ lat: draft.lat, lon: draft.lon, countryCode: pickCountry || undefined, locationLabel: pickLabel || undefined }),
      });
      setMsg({ ok: true, text: fa ? 'موقعیت ثبت شد.' : 'Location saved.' });
      setDraft(null); setPickLabel(''); loadPins();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? 'Failed' });
    }
  }

  // ---- rendering -------------------------------------------------------------------------------

  const crumb = (label: string, onClick?: () => void, active = false) => (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`truncate ${active ? 'text-graphite-100' : onClick ? 'text-accent hover:underline' : 'text-graphite-500'}`}
    >
      {label}
    </button>
  );

  const input = 'w-full rounded-lg border border-graphite-600 bg-graphite-850 px-2.5 py-1.5 text-sm text-graphite-100 focus:border-accent focus:outline-none';

  return (
    // Fills the viewport: the sidebar is 15rem wide, so the map takes the rest.
    <div className="relative h-screen w-full overflow-hidden" dir={fa ? 'rtl' : 'ltr'}>
      <GeoMap
        markers={markers}
        pins={pins}
        countries={countries}
        onSelect={openCity}
        onPinSelect={openProjectFromPin}
        selectedCityId={city?.cityId ?? null}
        onMapClick={picking ? (lat, lon) => setDraft({ lat, lon }) : undefined}
        draftPin={draft}
        initialView="auto"
        heightClass="full"
        locale={fa ? 'fa' : 'en'}
      />

      {/* Title bar overlay */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="pointer-events-auto rounded-lg border border-graphite-700 bg-graphite-900/90 px-3 py-2 backdrop-blur">
          <div className="text-sm font-semibold text-graphite-100">
            {fa ? 'مرکز فرماندهی نقشه' : 'Map Command Centre'}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-graphite-400">
            <span>{markers.reduce((a, m) => a + m.projectCount, 0)} {fa ? 'پروژه' : 'projects'}</span>
            <span>{markers.length} {fa ? 'شهر' : 'cities'}</span>
            <span>{countries.filter((c) => c.projectCount > 0).length} {fa ? 'کشور' : 'countries'}</span>
            {pins.length > 0 && <span className="text-accent">{pins.length} {fa ? 'سنجاق' : 'pinned'}</span>}
          </div>
        </div>

        <div className="pointer-events-auto flex gap-2">
          {!picking ? (
            <button onClick={startPicking} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white shadow hover:bg-accent-dim">
              {fa ? '📍 تعیین موقعیت' : '📍 Set location'}
            </button>
          ) : (
            <button onClick={() => { setPicking(false); setDraft(null); setPickProjectId(''); setMsg(null); }}
              className="rounded-lg border border-graphite-600 bg-graphite-900/90 px-3 py-2 text-xs text-graphite-300 hover:bg-graphite-800">
              {fa ? 'پایان' : 'Done'}
            </button>
          )}
        </div>
      </div>

      {/* Location picker bar */}
      {picking && (
        <div className="absolute inset-x-3 top-20 z-20 rounded-lg border border-accent/40 bg-graphite-900/95 p-3 backdrop-blur">
          {/*
            Drop the pin FIRST, then say what it is.

            This panel used to demand a project from a dropdown before a click on the map did
            anything at all, and it read "Choose a project first" until you did. That is backwards:
            the thing the person is looking at is the place, and they already know where it is — the
            paperwork can follow. Now any click while placing drops the pin, and the project
            selector only appears once there is something to attach it to.
          */}
          {!draft ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-sm">📍</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-graphite-100">
                  {fa ? 'روی نقشه کلیک کنید تا محل تابلو مشخص شود' : 'Click the map where the panel is'}
                </p>
                <p className="text-[11px] text-graphite-400">
                  {fa
                    ? 'لازم نیست مختصات را تایپ کنید. بعد از کلیک، پروژه را انتخاب می‌کنید.'
                    : 'No coordinates to type. You pick the project after dropping the pin.'}
                </p>
              </div>
              <button
                onClick={() => { setPicking(false); setDraft(null); setMsg(null); }}
                className="ml-auto rounded-lg border border-graphite-600 px-3 py-1.5 text-xs text-graphite-300 hover:bg-graphite-800"
              >
                {fa ? 'انصراف' : 'Cancel'}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-graphite-800 px-2 py-1 font-mono text-xs text-graphite-200" dir="ltr">
                  📍 {draft.lat.toFixed(4)}, {draft.lon.toFixed(4)}
                </span>
                <button
                  onClick={() => setDraft(null)}
                  className="text-[11px] text-accent hover:underline"
                >
                  {fa ? 'جای دیگری کلیک کنم' : 'Pick a different spot'}
                </button>
              </div>

              <div className="grid gap-2 md:grid-cols-4">
                <div className="md:col-span-2">
                  <label className="mb-1 block text-[11px] text-graphite-400">
                    {fa ? 'این محل مربوط به کدام پروژه است؟' : 'Which project is here?'}
                  </label>
                  <select
                    className={input}
                    autoFocus
                    value={pickProjectId}
                    onChange={(e) => {
                      setPickProjectId(e.target.value);
                      const pr = pickList.find((x) => x.project_id === e.target.value);
                      setPickCountry(pr?.country_code ?? '');
                      setPickLabel(pr?.location_label ?? '');
                    }}
                  >
                    <option value="">{fa ? '— انتخاب —' : '— choose —'}</option>
                    {pickList.map((pr) => (
                      <option key={pr.project_id} value={pr.project_id}>
                        {pr.has_pin ? '📍 ' : ''}{pr.code} — {pr.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-graphite-400">{fa ? 'کشور' : 'Country'}</label>
                  <select className={input} value={pickCountry} onChange={(e) => setPickCountry(e.target.value)}>
                    <option value="">—</option>
                    {countries.map((c) => (
                      <option key={c.code} value={c.code}>{fa ? c.nameFa : c.nameEn}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-graphite-400">{fa ? 'نام محل' : 'Place label'}</label>
                  <input className={input} value={pickLabel} onChange={(e) => setPickLabel(e.target.value)} />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={saveLocation}
                  disabled={!pickProjectId}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim disabled:opacity-50"
                >
                  {fa ? 'ذخیرهٔ موقعیت' : 'Save location'}
                </button>
                <button
                  onClick={() => { setPicking(false); setDraft(null); setMsg(null); }}
                  className="rounded-lg border border-graphite-600 px-3 py-1.5 text-xs text-graphite-300 hover:bg-graphite-800"
                >
                  {fa ? 'بستن' : 'Done'}
                </button>
                {msg && (
                  <span className={`text-xs ${msg.ok ? 'text-status-healthy' : 'text-status-critical'}`}>{msg.text}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Drill-down panel */}
      {level !== 'none' && (
        <div className={`absolute ${fa ? 'left-3' : 'right-3'} top-3 bottom-3 z-10 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-graphite-700 bg-graphite-900/97 shadow-2xl backdrop-blur`}>
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 border-b border-graphite-700 px-3 py-2 text-xs">
            {crumb(fa ? 'نقشه' : 'Map', closePanel)}
            {city && (<><span className="text-graphite-600">›</span>{crumb(fa ? city.nameFa : city.nameEn, level !== 'city' ? () => openCity(city.cityId) : undefined, level === 'city')}</>)}
            {project && (<><span className="text-graphite-600">›</span>{crumb(project.code, level !== 'project' ? () => openProject(project.id) : undefined, level === 'project')}</>)}
            {relay && (<><span className="text-graphite-600">›</span>{crumb(relay.relay_code, undefined, true)}</>)}
            <button onClick={closePanel} className="ml-auto shrink-0 rounded px-1.5 text-graphite-500 hover:bg-graphite-800 hover:text-graphite-200">✕</button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {loading && <p className="text-sm text-graphite-400">{fa ? 'در حال بارگذاری…' : 'Loading…'}</p>}
            {panelError && <p className="text-sm text-status-critical">{panelError}</p>}

            {/* ---- STEP 1: city ---- */}
            {!loading && level === 'city' && city && (
              <div className="space-y-3">
                <div>
                  <h2 className="text-base font-semibold text-graphite-100">{fa ? city.nameFa : city.nameEn}</h2>
                  <p className="text-xs text-graphite-500">{city.projectCount} {fa ? 'پروژه' : 'projects'} · {city.runningProjectCount} {fa ? 'در حال بهره‌برداری' : 'running'}</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-graphite-700 bg-graphite-850 px-2.5 py-2">
                    <div className="text-[10px] uppercase text-graphite-500">{fa ? 'آلارم بحرانی' : 'Critical alarms'}</div>
                    <div className={`text-lg font-semibold ${city.criticalAlarmCount > 0 ? 'text-status-critical' : 'text-graphite-200'}`}>{city.criticalAlarmCount}</div>
                  </div>
                  <div className="rounded-lg border border-graphite-700 bg-graphite-850 px-2.5 py-2">
                    <div className="text-[10px] uppercase text-graphite-500">{fa ? 'خطای اخیر' : 'Recent faults'}</div>
                    <div className="text-lg font-semibold text-graphite-200">{city.recentFaultCount}</div>
                  </div>
                </div>

                {city.relayHealth.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-[10px] uppercase text-graphite-500">{fa ? 'وضعیت رله‌ها' : 'Relay health'}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {city.relayHealth.map((h) => (
                        <span key={h.status} className="flex items-center gap-1.5 rounded bg-graphite-800 px-2 py-1 text-[11px] text-graphite-300">
                          <span className={`h-2 w-2 rounded-full ${STATUS_DOT[h.status] ?? 'bg-graphite-500'}`} />
                          {h.status} {h.count}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <h3 className="mb-1.5 text-[10px] uppercase text-graphite-500">{fa ? 'پروژه‌ها — برای ورود کلیک کنید' : 'Projects — click to open'}</h3>
                  <div className="space-y-1.5">
                    {projects.map((p) => (
                      <button key={p.id} onClick={() => openProject(p.id)}
                        className="w-full rounded-lg border border-graphite-700 bg-graphite-850 px-2.5 py-2 text-start hover:border-accent hover:bg-accent/10">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-graphite-100">{p.code}</span>
                          <span className="shrink-0 rounded bg-graphite-700 px-1.5 py-0.5 text-[9px] text-graphite-300">{p.status}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-graphite-400">{p.name}</div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-graphite-700">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${p.overall_progress ?? 0}%` }} />
                          </div>
                          <span className="text-[10px] text-graphite-500">{p.overall_progress ?? 0}%</span>
                        </div>
                      </button>
                    ))}
                    {projects.length === 0 && <p className="text-xs text-graphite-500">{fa ? 'پروژه‌ای نیست' : 'No projects'}</p>}
                  </div>
                </div>
              </div>
            )}

            {/* ---- STEP 2: project ---- */}
            {!loading && level === 'project' && project && (
              <div className="space-y-3">
                <div>
                  <h2 className="text-base font-semibold text-graphite-100">{project.code}</h2>
                  <p className="text-xs text-graphite-400">{project.name}</p>
                  <p className="mt-0.5 text-[11px] text-graphite-500">
                    {localName(project.city_name_en, project.city_name_fa)}, {localName(project.province_name_en, project.province_name_fa)} · {project.status}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-graphite-700 bg-graphite-850 px-2.5 py-2">
                    <div className="text-[10px] uppercase text-graphite-500">{fa ? 'پیشرفت' : 'Progress'}</div>
                    <div className="text-lg font-semibold text-graphite-200">{project.overall_progress ?? 0}%</div>
                  </div>
                  <div className="rounded-lg border border-graphite-700 bg-graphite-850 px-2.5 py-2">
                    <div className="text-[10px] uppercase text-graphite-500">{fa ? 'سلامت' : 'Health'}</div>
                    <div className={`text-lg font-semibold ${(project.health_score ?? 100) < 60 ? 'text-status-critical' : (project.health_score ?? 100) < 80 ? 'text-status-warning' : 'text-status-healthy'}`}>
                      {project.health_score ?? '—'}
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="mb-1.5 text-[10px] uppercase text-graphite-500">
                    {relays.length} {fa ? 'رله — برای وضعیت کلیک کنید' : 'relays — click for status'}
                  </h3>
                  <div className="space-y-1.5">
                    {relays.map((r) => (
                      <button key={r.id} onClick={() => openRelay(r.id)}
                        className="w-full rounded-lg border border-graphite-700 bg-graphite-850 px-2.5 py-2 text-start hover:border-accent hover:bg-accent/10">
                        <div className="flex items-center gap-2">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[r.health_status] ?? 'bg-graphite-500'}`} />
                          <span className="truncate text-xs font-medium text-graphite-100">{r.relay_code}</span>
                          <span className="ms-auto shrink-0 text-[9px] text-graphite-500">{r.protocol}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-graphite-500">
                          {r.manufacturer} {r.model}{r.panel_name ? ` · ${r.panel_name}` : ''}
                        </div>
                      </button>
                    ))}
                    {relays.length === 0 && <p className="text-xs text-graphite-500">{fa ? 'رله‌ای ثبت نشده' : 'No relays registered'}</p>}
                  </div>
                </div>

                <a href={`/projects/${project.id}`} className="block rounded-lg border border-graphite-600 px-3 py-2 text-center text-xs text-graphite-300 hover:bg-graphite-800">
                  {fa ? 'صفحه کامل پروژه' : 'Full project page'}
                </a>
              </div>
            )}

            {/* ---- STEP 3: relay status ---- */}
            {!loading && level === 'relay' && relay && (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[relay.health_status] ?? 'bg-graphite-500'}`} />
                    <h2 className="text-base font-semibold text-graphite-100">{relay.relay_code}</h2>
                  </div>
                  <p className="text-xs text-graphite-400">{relay.manufacturer} {relay.model}</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {[
                    [fa ? 'ارتباط' : 'Comms', relay.comm_status],
                    [fa ? 'سلامت' : 'Health', `${relay.health_status} (${relay.health_score ?? '—'})`],
                    [fa ? 'بریکر' : 'Breaker', relay.breaker_status ?? '—'],
                    [fa ? 'پروتکل' : 'Protocol', relay.protocol],
                    [fa ? 'تعداد تریپ' : 'Trips', relay.trip_count ?? 0],
                    [fa ? 'آلارم' : 'Alarms', relay.alarm_count ?? 0],
                    [fa ? 'گروه تنظیمات' : 'Setting group', relay.active_setting_group ?? '—'],
                  ].map(([k, v]) => (
                    <div key={String(k)} className="rounded-lg border border-graphite-700 bg-graphite-850 px-2.5 py-1.5">
                      <div className="text-[10px] uppercase text-graphite-500">{k}</div>
                      <div className="truncate text-xs font-medium text-graphite-200">{String(v)}</div>
                    </div>
                  ))}
                </div>

                {relay.hierarchy && (
                  <p className="text-[11px] leading-relaxed text-graphite-500">
                    {relay.hierarchy.substation_name} › {relay.hierarchy.switchgear_name} › {relay.hierarchy.panel_name}
                  </p>
                )}

                {relay.faults?.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-[10px] uppercase text-graphite-500">
                      {fa ? 'خطاهای باز' : 'Open faults'} ({relay.faults.length})
                    </h3>
                    <div className="space-y-1">
                      {relay.faults.slice(0, 4).map((f: any) => (
                        <a key={f.id} href={`/faults/${f.id}`}
                          className="block rounded border border-graphite-700 bg-graphite-850 px-2 py-1.5 hover:border-accent">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[11px] text-graphite-200">{f.fault_code}</span>
                            <span className={`shrink-0 text-[9px] ${f.severity === 'CRITICAL' ? 'text-status-critical' : 'text-status-warning'}`}>{f.severity}</span>
                          </div>
                          <div className="truncate text-[10px] text-graphite-500">{f.fault_type}</div>
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {relay.recentEvents?.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-[10px] uppercase text-graphite-500">{fa ? 'رویدادهای اخیر' : 'Recent events'}</h3>
                    <div className="space-y-1">
                      {relay.recentEvents.slice(0, 5).map((e: any, i: number) => (
                        <div key={i} className="rounded border border-graphite-700 bg-graphite-850 px-2 py-1">
                          <div className="truncate text-[10px] text-graphite-300">{e.message ?? e.event_type}</div>
                          <div className="text-[9px] text-graphite-500">{e.time ? new Date(e.time).toLocaleString() : ''}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(relay.protectionFunctions) && relay.protectionFunctions.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-[10px] uppercase text-graphite-500">{fa ? 'توابع حفاظتی' : 'Protection functions'}</h3>
                    <div className="flex flex-wrap gap-1">
                      {relay.protectionFunctions.map((f: any, i: number) => (
                        <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] ${f.enabled ? 'bg-accent/20 text-accent' : 'bg-graphite-800 text-graphite-500'}`}>
                          {f.function_code}{f.ansi_code ? ` (${f.ansi_code})` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-[10px] text-graphite-500">
                  {fa ? 'آخرین ارتباط: ' : 'Last communication: '}
                  {relay.last_communication_at ? new Date(relay.last_communication_at).toLocaleString() : '—'}
                </p>

                <a href={`/relays/${relay.id}`} className="block rounded-lg border border-graphite-600 px-3 py-2 text-center text-xs text-graphite-300 hover:bg-graphite-800">
                  {fa ? 'صفحه کامل رله' : 'Full relay page'}
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
