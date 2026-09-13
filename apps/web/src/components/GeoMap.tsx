'use client';

import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { WORLD_PATH, IRAN_PROVINCE_PATHS, CITY_CENTROID_BY_ID, project } from '@/lib/mapData';

/**
 * Self-contained pan/zoom map.
 *
 * Renders embedded Natural Earth geometry — no tile server, no external request — so it works
 * inside an air-gapped network. See lib/mapData.ts for why that matters.
 *
 * TWO THINGS THAT LOOK LIKE DETAIL BUT DECIDE WHETHER THE MAP IS USABLE:
 *
 * 1. Marker size is in PIXELS, not map units. An earlier version sized markers in degrees, which
 *    meant a marker was ~15° across at world zoom while Tehran and Isfahan are 3° apart — every
 *    Iranian city merged into one unreadable blob. Radius is now converted through unitsPerPx so a
 *    marker occupies the same screen area at every zoom level.
 *
 * 2. Markers that would overlap are CLUSTERED. Even at constant pixel size, twenty cities in one
 *    country cannot be distinguished when the whole world is on screen. Overlapping markers merge
 *    into a single circle carrying the combined count; clicking it zooms in and it splits apart.
 *    Without this the map shows a pile of circles and no information.
 */

/** A project pinned to an exact position by the operator. */
export interface ProjectPin {
  projectId: string;
  code: string;
  name: string;
  placeLabel: string;
  countryCode: string;
  lat: number;
  lon: number;
  relayCount: number;
  markerStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'OFFLINE';
}

export interface MapMarker {
  cityId: string;
  cityNameEn: string;
  cityNameFa: string;
  provinceNameEn: string;
  projectCount: number;
  relayCount?: number;
  /** Worst status present in that city — drives the marker colour. */
  status?: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'OFFLINE';
}

export interface CountryLabel {
  code: string;
  nameEn: string;
  nameFa: string;
  centroidLon: number;
  centroidLat: number;
  projectCount?: number;
}

interface Props {
  markers: MapMarker[];
  pins?: ProjectPin[];
  /** Countries with centroids, used to label the map at low zoom. */
  countries?: CountryLabel[];
  onSelect?: (cityId: string) => void;
  onPinSelect?: (projectId: string) => void;
  onMapClick?: (lat: number, lon: number) => void;
  draftPin?: { lat: number; lon: number } | null;
  selectedCityId?: string | null;
  initialView?: 'iran' | 'world' | 'auto';
  /** Tailwind height class, or 'full' to fill the parent (used by the full-screen command centre). */
  heightClass?: string;
  locale?: 'en' | 'fa';
}

const STATUS_FILL: Record<string, string> = {
  HEALTHY: '#22c55e',
  WARNING: '#eab308',
  CRITICAL: '#ef4444',
  OFFLINE: '#64748b',
};

// Status precedence when several cities merge into one cluster: the worst one wins, because a
// cluster showing green while it contains a critical site would actively mislead.
const STATUS_RANK: Record<string, number> = { CRITICAL: 3, OFFLINE: 2, WARNING: 1, HEALTHY: 0 };

// Equirectangular bounds. y is negated latitude (see project()).
const VIEWS = {
  iran: { x: 43, y: -40.5, w: 22, h: 16 },
  world: { x: -180, y: -84, w: 360, h: 150 },
};

/**
 * Label anchor for each Iranian province, derived from its own outline.
 *
 * The geodata carries province shapes but no label points, so the centre of each bounding box is
 * used. For a compact province that is the visual centre; for a long one it is close enough that
 * the name still reads as belonging to that shape. Computed once at module load rather than per
 * render — the paths never change, and parsing 31 outlines on every pan would be visible.
 */
const PROVINCE_LABELS: { name: string; x: number; y: number }[] = IRAN_PROVINCE_PATHS.map((p) => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const re = /(-?\d+\.?\d*),(-?\d+\.?\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p.d))) {
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    if (lon < minX) minX = lon;
    if (lon > maxX) maxX = lon;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  }
  // Same sign convention as project(): the raw data is +lat, the map draws -lat.
  return { name: p.name, x: (minX + maxX) / 2, y: -(minY + maxY) / 2 };
}).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

/**
 * Zoom thresholds for the label tiers, in degrees of longitude across the viewport.
 *
 * The map reads like an atlas rather than a single flat layer: countries name themselves when you
 * are looking at the world, provinces appear as you come down to one country, and city names only
 * once they are far enough apart to be readable. Showing every tier at once produces an unreadable
 * pile of text at world zoom, which is the state this replaces.
 */
// Above the world view's own width (360°), so country names are present at every zoom including
// fully zoomed out — which is exactly where an atlas needs them most. They shrink instead of
// disappearing. A first attempt used 300 here, which silently hid every name at the World button.
const SHOW_COUNTRY_NAMES_BELOW = 1000;
const SHOW_PROVINCE_NAMES_BELOW = 42;
const SHOW_CITY_NAMES_BELOW = 30;

/** Screen-space distance below which two markers are merged, in pixels. */
const CLUSTER_RADIUS_PX = 30;

interface Placed {
  key: string;
  x: number;
  y: number;
  cities: MapMarker[];
  projectCount: number;
  relayCount: number;
  status: string;
}

export function GeoMap({
  markers,
  pins = [],
  countries = [],
  onSelect,
  onPinSelect,
  onMapClick,
  draftPin,
  selectedCityId,
  initialView = 'auto',
  heightClass = 'h-[460px]',
  locale = 'en',
}: Props) {
  const fa = locale === 'fa';
  const [view, setView] = useState(initialView === 'iran' ? VIEWS.iran : VIEWS.world);
  const [hovered, setHovered] = useState<Placed | null>(null);
  const [hoveredPin, setHoveredPin] = useState<ProjectPin | null>(null);
  const [size, setSize] = useState({ w: 1000, h: 500 });
  const movedRef = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragState = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // Measure the element so map units can be converted to pixels. Without this, marker size cannot
  // be held constant on screen and the map degenerates at low zoom.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Open the map on the data, not on the whole planet.
   *
   * With initialView="world" every marker for a fleet installed in one country fell inside the
   * 30px cluster radius and collapsed into a SINGLE dot — 21 cities rendered as one circle, which
   * is why the map read as empty. Fitting the first view to the markers means a fleet in one
   * country opens on that country, and the same code opens on a wider view once panels exist on
   * more than one continent. The World and Iran buttons still override it, and this runs once so it
   * never fights the operator's own panning.
   */
  const didAutoFit = useRef(false);
  useEffect(() => {
    if (initialView !== 'auto' || didAutoFit.current) return;
    const pts = [
      ...markers.map((m) => CITY_CENTROID_BY_ID[m.cityId]).filter(Boolean).map((c: any) => project(c.lon, c.lat)),
      ...pins.filter((p) => p.lat != null && p.lon != null).map((p) => project(p.lon as number, p.lat as number)),
    ];
    if (pts.length === 0) return;
    didAutoFit.current = true;

    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    // Pad the bounding box so markers are never flush against the edge, with a floor so a single
    // site does not zoom to street level — this map is deliberately city-level only.
    const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 4);
    const spanY = Math.max(Math.max(...ys) - Math.min(...ys), 4);
    const w = Math.min(360, spanX * 1.6);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const h = Math.max(spanY * 1.6, w * 0.4);
    setView({ x: cx - w / 2, y: cy - h / 2, w, h });
  }, [markers, pins, initialView]);

  // Keep the viewBox aspect ratio matched to the element, otherwise the map is stretched and
  // clicking picks the wrong coordinate.
  const aspect = size.h / size.w;
  const viewH = view.w * aspect;
  const unitsPerPx = view.w / size.w;
  const px = useCallback((n: number) => n * unitsPerPx, [unitsPerPx]);

  /** Cluster markers whose screen positions are within CLUSTER_RADIUS_PX of each other. */
  const placed = useMemo<Placed[]>(() => {
    const points = markers
      .map((m) => {
        const c = CITY_CENTROID_BY_ID[m.cityId];
        if (!c) return null;
        const p = project(c.lon, c.lat);
        return { m, x: p.x, y: p.y };
      })
      .filter(Boolean) as Array<{ m: MapMarker; x: number; y: number }>;

    const threshold = CLUSTER_RADIUS_PX * unitsPerPx;
    const clusters: Placed[] = [];

    for (const pt of points) {
      // Greedy nearest-cluster assignment. Adequate here: a few dozen points, recomputed on zoom,
      // and the exact grouping does not need to be optimal — only stable and non-overlapping.
      const hit = clusters.find((c) => Math.hypot(c.x - pt.x, c.y - pt.y) < threshold);
      if (hit) {
        hit.cities.push(pt.m);
        hit.projectCount += pt.m.projectCount;
        hit.relayCount += pt.m.relayCount ?? 0;
        if (STATUS_RANK[pt.m.status ?? 'HEALTHY'] > STATUS_RANK[hit.status]) hit.status = pt.m.status ?? 'HEALTHY';
        // Recentre on the mean so the cluster sits among its members rather than on the first one.
        hit.x = (hit.x * (hit.cities.length - 1) + pt.x) / hit.cities.length;
        hit.y = (hit.y * (hit.cities.length - 1) + pt.y) / hit.cities.length;
      } else {
        clusters.push({
          key: pt.m.cityId,
          x: pt.x,
          y: pt.y,
          cities: [pt.m],
          projectCount: pt.m.projectCount,
          relayCount: pt.m.relayCount ?? 0,
          status: pt.m.status ?? 'HEALTHY',
        });
      }
    }
    return clusters;
  }, [markers, unitsPerPx]);

  const maxCount = Math.max(1, ...placed.map((p) => p.projectCount));

  /** Constant on-screen radius: 7px at the smallest, 15px for the busiest location. */
  const radiusPxFor = (count: number) => 7 + 8 * Math.sqrt(count / maxCount);

  const zoomBy = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      setView((v) => {
        const nw = Math.min(360, Math.max(0.6, v.w * factor));
        const ax = cx ?? v.x + v.w / 2;
        const ay = cy ?? v.y + v.w * aspect / 2;
        const rx = (ax - v.x) / v.w;
        const ry = (ay - v.y) / (v.w * aspect);
        return { x: ax - nw * rx, y: ay - nw * aspect * ry, w: nw, h: nw * aspect };
      });
    },
    [aspect]
  );

  const clientToView = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: view.x + ((clientX - r.left) / r.width) * view.w,
      y: view.y + ((clientY - r.top) / r.height) * viewH,
    };
  };

  /** Zoom so a cluster's members separate. */
  const zoomToCluster = (c: Placed) => {
    setView((v) => {
      const nw = Math.max(0.6, v.w / 3);
      return { x: c.x - nw / 2, y: c.y - (nw * aspect) / 2, w: nw, h: nw * aspect };
    });
  };

  const fit = (key: 'iran' | 'world') => {
    const base = VIEWS[key];
    const h = base.w * aspect;
    // Keep the stored centre when the height is recomputed for this element's aspect ratio.
    // Taking base.y unchanged pushed the world view's bottom edge past the south pole and left a
    // black band under Antarctica.
    const cy = base.y + base.h / 2;
    setView({ x: base.x, y: cy - h / 2, w: base.w, h });
  };

  /**
   * Country labels that fit without overlapping each other.
   *
   * At world zoom the Gulf and the Caucasus pack a dozen countries into a few hundred pixels, and
   * printing every centroid name produced a smear of overlapping text right where this company's
   * projects are. Countries that hold projects are placed FIRST so they always win a contested
   * spot — the map's job is to show where Electro Kavir's panels are, and a neighbour's name losing
   * out at world zoom costs nothing, since zooming in gives it room again.
   */
  const visibleCountryLabels = useMemo(() => {
    if (view.w >= SHOW_COUNTRY_NAMES_BELOW) return [];
    const candidates = countries
      .filter((c) => c.centroidLon != null && c.centroidLat != null)
      // Once a country's own provinces are named its country label is redundant and just competes
      // with them — Iran's provinces are the detail the operator came for. Neighbours keep theirs,
      // which is what orients you.
      .filter((c) => !(c.code === 'IR' && view.w < SHOW_PROVINCE_NAMES_BELOW))
      .map((c) => ({ c, pt: project(c.centroidLon, c.centroidLat) }))
      .filter(({ pt }) =>
        pt.x >= view.x - 2 && pt.x <= view.x + view.w + 2 && pt.y >= view.y - 2 && pt.y <= view.y + viewH + 2
      )
      .sort((a, b) => (b.c.projectCount ?? 0) - (a.c.projectCount ?? 0));

    const kept: { c: CountryLabel; pt: { x: number; y: number } }[] = [];
    const minGapX = px(78);
    const minGapY = px(15);

    for (const entry of candidates) {
      let pt = entry.pt;

      // Markers are drawn on top of labels, so a country whose centroid sits under one loses its
      // name entirely — which happened to IRAN at world zoom, the single most important label on
      // this company's map, buried under its own project cluster. Nudge the label clear instead of
      // dropping it: below the marker if that is free, above it otherwise.
      const markerClash = placed.find(
        (m) => Math.abs(m.x - pt.x) < px(30) && Math.abs(m.y - pt.y) < px(24)
      );
      if (markerClash) {
        const below = { x: pt.x, y: markerClash.y + px(26) };
        const above = { x: pt.x, y: markerClash.y - px(22) };
        const free = (cand: { x: number; y: number }) =>
          !placed.some((m) => Math.abs(m.x - cand.x) < px(30) && Math.abs(m.y - cand.y) < px(20));
        pt = free(below) ? below : free(above) ? above : below;
      }

      const clashes = kept.some(
        (k) => Math.abs(k.pt.x - pt.x) < minGapX && Math.abs(k.pt.y - pt.y) < minGapY
      );
      if (!clashes) kept.push({ c: entry.c, pt });
    }
    return kept;
  }, [countries, placed, view.x, view.y, view.w, viewH, px]);

  /**
   * Province labels that fit without overlapping each other.
   *
   * Bounding-box centres put West and East Azarbaijan almost on top of one another, so both names
   * printed over the same patch of map and neither could be read. This walks them largest-first and
   * keeps a label only if it clears every label already placed — the same greedy screen-space test
   * the markers use for clustering. A dropped name reappears as soon as zooming gives it room.
   */
  const visibleProvinceLabels = useMemo(() => {
    if (view.w >= SHOW_PROVINCE_NAMES_BELOW) return [];
    const kept: { name: string; x: number; y: number }[] = [];
    // Roughly the on-screen footprint of a label, converted to map units.
    const minGapX = px(70);
    const minGapY = px(16);
    for (const pr of PROVINCE_LABELS) {
      if (pr.x < view.x || pr.x > view.x + view.w) continue;
      if (pr.y < view.y || pr.y > view.y + viewH) continue;
      const clashes = kept.some((k) => Math.abs(k.x - pr.x) < minGapX && Math.abs(k.y - pr.y) < minGapY);
      if (!clashes) kept.push(pr);
    }
    return kept;
  }, [view.x, view.y, view.w, viewH, px]);

  const heightStyle = heightClass === 'full' ? 'h-full w-full' : heightClass;

  return (
    <div className={`relative overflow-hidden bg-graphite-950 ${heightStyle}`}>
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${viewH}`}
        preserveAspectRatio="none"
        className={`h-full w-full ${onMapClick ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'}`}
        onWheel={(e) => {
          const p = clientToView(e.clientX, e.clientY);
          zoomBy(e.deltaY > 0 ? 1.25 : 1 / 1.25, p?.x, p?.y);
        }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          movedRef.current = false;
          dragState.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const d = dragState.current;
          if (!d || !svgRef.current) return;
          if (Math.abs(e.clientX - d.x) > 3 || Math.abs(e.clientY - d.y) > 3) movedRef.current = true;
          const r = svgRef.current.getBoundingClientRect();
          setView((v) => ({
            ...v,
            x: d.vx - ((e.clientX - d.x) / r.width) * v.w,
            y: d.vy - ((e.clientY - d.y) / r.height) * (v.w * aspect),
          }));
        }}
        onPointerUp={(e) => {
          const wasDragging = movedRef.current;
          dragState.current = null;
          if (!onMapClick || wasDragging) return;
          const p = clientToView(e.clientX, e.clientY);
          if (!p) return;
          const lat = -p.y;
          const lon = ((((p.x + 180) % 360) + 360) % 360) - 180;
          if (lat < -90 || lat > 90) return;
          onMapClick(Number(lat.toFixed(5)), Number(lon.toFixed(5)));
        }}
        onPointerLeave={() => {
          dragState.current = null;
        }}
      >
        {/*
          THE GEOGRAPHY IS DRAWN FLIPPED, AND THAT IS THE POINT.

          The geodata holds raw longitude/latitude pairs, so a point in northern Iran is y = +36.
          Everything else on this map — the viewBox, the markers, click-to-latitude — uses
          project(), which returns y = -lat, because SVG's y axis grows downward and north has to
          be up. The two conventions disagreed by a sign, so the land was painted at y = +25..+40
          while the camera looked at y = -40..-25: every country and province rendered just off
          screen. The markers were positioned correctly the whole time, which is why the map looked
          like coloured dots floating on an empty black background.

          scale(1,-1) converts the raw data into the same convention as everything else. Doing it
          here, in one place, keeps the 80KB of Natural Earth path data untouched and unduplicated.
        */}
        <g transform="scale(1,-1)">
          <path d={WORLD_PATH} fill="#18202c" stroke="#2f3b4b" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />

          {/* Province borders strengthen as you come in, so the subdivision is visible when you are
              looking at one country and stays out of the way when you are looking at the world. */}
          {IRAN_PROVINCE_PATHS.map((p) => (
            <path
              key={p.name}
              d={p.d}
              fill={p.provinceId ? '#232e3d' : '#1c2431'}
              stroke={view.w < SHOW_PROVINCE_NAMES_BELOW ? '#4d5f74' : '#3c4a5a'}
              strokeWidth={view.w < SHOW_PROVINCE_NAMES_BELOW ? 1 : 0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>

        {/*
          LABEL LAYERS — the map names what you are looking at, like an atlas.

          Text is sized through px() so it stays the same size on screen at every zoom; sizing type
          in map units would make a country name span a continent when zoomed out. All of it is
          pointer-events:none so a label never swallows a click meant for the map or a marker —
          which matters now that clicking the map is how a panel's location gets placed.
        */}
        <g pointerEvents="none">
          {/* Countries: shown at every zoom, but quiet and small so they read as ground truth
              rather than competing with the markers. */}
          {visibleCountryLabels.map(({ c, pt }) => {
              // A country holding projects is worth more emphasis than one that is only scenery.
              const active = (c.projectCount ?? 0) > 0;
              const fs = px(view.w > 120 ? 10 : view.w > 40 ? 12 : 13);
              return (
                <text
                  key={c.code}
                  x={pt.x}
                  y={pt.y}
                  textAnchor="middle"
                  fontSize={fs}
                  fontWeight={active ? 600 : 400}
                  fill={active ? '#cbd5e1' : '#64748b'}
                  letterSpacing={px(0.4)}
                  style={{ paintOrder: 'stroke', stroke: '#0a1018', strokeWidth: px(2.5), strokeLinejoin: 'round' }}
                >
                  {fa ? c.nameFa : c.nameEn}
                </text>
              );
            })}

          {/* Provinces: appear once a single country fills the view. */}
          {view.w < SHOW_PROVINCE_NAMES_BELOW &&
            visibleProvinceLabels.map((pr) => {
              return (
                <text
                  key={pr.name}
                  x={pr.x}
                  y={pr.y}
                  textAnchor="middle"
                  fontSize={px(10.5)}
                  fill="#7c8ba1"
                  letterSpacing={px(0.6)}
                  style={{
                    textTransform: 'uppercase',
                    paintOrder: 'stroke',
                    stroke: '#0a1018',
                    strokeWidth: px(2.5),
                    strokeLinejoin: 'round',
                  }}
                >
                  {pr.name}
                </text>
              );
            })}
        </g>

        {/* City markers / clusters */}
        {placed.map((c) => {
          const rPx = radiusPxFor(c.projectCount);
          const r = px(rPx);
          const fill = STATUS_FILL[c.status] ?? STATUS_FILL.HEALTHY;
          const isCluster = c.cities.length > 1;
          const isSelected = !isCluster && selectedCityId === c.cities[0].cityId;
          const isHovered = hovered?.key === c.key;

          return (
            <g
              key={c.key}
              transform={`translate(${c.x} ${c.y})`}
              className="cursor-pointer"
              onMouseEnter={() => setHovered(c)}
              onMouseLeave={() => setHovered(null)}
              onClick={(e) => {
                e.stopPropagation();
                if (isCluster) zoomToCluster(c);
                else onSelect?.(c.cities[0].cityId);
              }}
            >
              {(isSelected || isHovered) && <circle r={r * 1.8} fill={fill} opacity={0.22} />}
              <circle r={r} fill={fill} fillOpacity={0.9} stroke="#0a0e14" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
              {/* The count is the whole point of a cluster, so it is always drawn inside it. */}
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fill="#0a0e14"
                style={{ fontSize: `${px(rPx * 0.95)}px`, fontWeight: 700, pointerEvents: 'none' }}
              >
                {c.projectCount}
              </text>
              {/* Name only when it will not collide: single city, and zoomed in enough. */}
              {!isCluster && view.w < SHOW_CITY_NAMES_BELOW && (
                <text
                  y={r + px(11)}
                  textAnchor="middle"
                  fill="#c4d0dc"
                  style={{ fontSize: `${px(11)}px`, pointerEvents: 'none' }}
                >
                  {fa ? c.cities[0].cityNameFa : c.cities[0].cityNameEn}
                </text>
              )}
            </g>
          );
        })}

        {/* Project pins — exact positions the operator placed */}
        {pins.map((pin) => {
          const p = project(pin.lon, pin.lat);
          const fill = STATUS_FILL[pin.markerStatus] ?? STATUS_FILL.HEALTHY;
          const u = px(1);
          return (
            <g
              key={pin.projectId}
              transform={`translate(${p.x} ${p.y})`}
              className="cursor-pointer"
              onMouseEnter={() => setHoveredPin(pin)}
              onMouseLeave={() => setHoveredPin(null)}
              onClick={(e) => {
                e.stopPropagation();
                onPinSelect?.(pin.projectId);
              }}
            >
              <path
                d={`M0,0 L${-6 * u},${-13 * u} A${7.5 * u},${7.5 * u} 0 1,1 ${6 * u},${-13 * u} Z`}
                fill={fill}
                stroke="#0a0e14"
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
              />
              <circle cy={-15 * u} r={3 * u} fill="#0a0e14" />
              {view.w < 60 && (
                <text y={10 * u} textAnchor="middle" fill="#dbe3ea" style={{ fontSize: `${px(10)}px`, pointerEvents: 'none' }}>
                  {pin.code}
                </text>
              )}
            </g>
          );
        })}

        {draftPin &&
          (() => {
            const p = project(draftPin.lon, draftPin.lat);
            const u = px(1);
            return (
              <g transform={`translate(${p.x} ${p.y})`} style={{ pointerEvents: 'none' }}>
                <circle r={18 * u} fill="#3b82f6" opacity={0.25}>
                  <animate attributeName="r" values={`${12 * u};${24 * u};${12 * u}`} dur="1.6s" repeatCount="indefinite" />
                </circle>
                <path
                  d={`M0,0 L${-6 * u},${-13 * u} A${7.5 * u},${7.5 * u} 0 1,1 ${6 * u},${-13 * u} Z`}
                  fill="#3b82f6"
                  stroke="#dbe3ea"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })()}
      </svg>

      {/* Hover cards */}
      {hovered && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-graphite-600 bg-graphite-900/95 px-3 py-2 shadow-lg">
          {hovered.cities.length > 1 ? (
            <>
              <div className="text-sm font-medium text-graphite-100">
                {hovered.cities.length} {fa ? 'شهر' : 'cities'}
              </div>
              <div className="max-w-[240px] text-[11px] text-graphite-400">
                {hovered.cities.slice(0, 4).map((c) => (fa ? c.cityNameFa : c.cityNameEn)).join(fa ? '، ' : ', ')}
                {hovered.cities.length > 4 && ` +${hovered.cities.length - 4}`}
              </div>
              <div className="mt-1 text-[11px] text-accent">{fa ? 'برای باز شدن کلیک کنید' : 'Click to zoom in'}</div>
            </>
          ) : (
            <>
              <div className="text-sm font-medium text-graphite-100">
                {fa ? hovered.cities[0].cityNameFa : hovered.cities[0].cityNameEn}
              </div>
              <div className="text-[11px] text-graphite-400">{hovered.cities[0].provinceNameEn}</div>
            </>
          )}
          <div className="mt-1 flex gap-3 text-[11px] text-graphite-300">
            <span>
              {hovered.projectCount} {fa ? 'پروژه' : 'projects'}
            </span>
            {hovered.relayCount > 0 && (
              <span>
                {hovered.relayCount} {fa ? 'رله' : 'relays'}
              </span>
            )}
          </div>
        </div>
      )}

      {hoveredPin && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-graphite-600 bg-graphite-900/95 px-3 py-2 shadow-lg">
          <div className="text-sm font-medium text-graphite-100">{hoveredPin.code}</div>
          <div className="max-w-[220px] truncate text-[11px] text-graphite-300">{hoveredPin.name}</div>
          <div className="text-[11px] text-graphite-400">{hoveredPin.placeLabel}</div>
          <div className="mt-1 text-[11px] text-graphite-300">
            {hoveredPin.relayCount} {fa ? 'رله' : 'relays'}
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <button onClick={() => zoomBy(1 / 1.6)} className="h-8 w-8 rounded border border-graphite-600 bg-graphite-900/90 text-base text-graphite-200 hover:bg-graphite-800" aria-label="Zoom in">+</button>
        <button onClick={() => zoomBy(1.6)} className="h-8 w-8 rounded border border-graphite-600 bg-graphite-900/90 text-base text-graphite-200 hover:bg-graphite-800" aria-label="Zoom out">−</button>
        <button onClick={() => fit('iran')} className="mt-1 rounded border border-graphite-600 bg-graphite-900/90 px-1.5 py-1 text-[10px] text-graphite-300 hover:bg-graphite-800">{fa ? 'ایران' : 'Iran'}</button>
        <button onClick={() => fit('world')} className="rounded border border-graphite-600 bg-graphite-900/90 px-1.5 py-1 text-[10px] text-graphite-300 hover:bg-graphite-800">{fa ? 'جهان' : 'World'}</button>
      </div>

      <div className="pointer-events-none absolute bottom-2 left-3 right-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] leading-snug text-graphite-500">
        <span>{fa ? 'عدد داخل دایره = تعداد پروژه' : 'Number in circle = project count'}</span>
        <span>{fa ? 'دایره چند شهری: کلیک = بزرگ‌نمایی' : 'Merged circle: click to zoom in'}</span>
        {onMapClick && <span className="text-accent">{fa ? 'برای انتخاب موقعیت کلیک کنید' : 'Click to choose a position'}</span>}
      </div>
    </div>
  );
}
