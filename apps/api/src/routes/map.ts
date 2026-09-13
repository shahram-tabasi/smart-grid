import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';

export const mapRouter = createRouter();

// National project map — province -> city -> counts ONLY. No coordinates, no addresses.
// See docs/ARCHITECTURE.md §9: this endpoint never joins site_location_restricted.
mapRouter.get('/provinces', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      pr.id AS province_id, pr.name_en, pr.name_fa,
      c.id AS city_id, c.name_en AS city_name_en, c.name_fa AS city_name_fa,
      COUNT(p.id) AS project_count,
      COUNT(p.id) FILTER (WHERE p.status = 'RUNNING') AS running_count,
      COUNT(p.id) FILTER (WHERE p.status NOT IN ('COMPLETED','BLOCKED')) AS active_count
    FROM provinces pr
    JOIN cities c ON c.province_id = pr.id
    LEFT JOIN projects p ON p.city_id = c.id
    GROUP BY pr.id, pr.name_en, pr.name_fa, c.id, c.name_en, c.name_fa
    ORDER BY pr.name_en, c.name_en
  `);

  const byProvince: Record<string, any> = {};
  for (const r of rows) {
    if (!byProvince[r.province_id]) {
      byProvince[r.province_id] = {
        provinceId: r.province_id, nameEn: r.name_en, nameFa: r.name_fa, totalProjects: 0, cities: [],
      };
    }
    const projectCount = Number(r.project_count);
    byProvince[r.province_id].totalProjects += projectCount;
    if (projectCount > 0) {
      byProvince[r.province_id].cities.push({
        cityId: r.city_id, nameEn: r.city_name_en, nameFa: r.city_name_fa,
        projectCount, runningCount: Number(r.running_count), activeCount: Number(r.active_count),
      });
    }
  }
  res.json({ provinces: Object.values(byProvince).filter((p: any) => p.totalProjects > 0), isDemoData: true });
});

// City drill-down overview (spec §2 "City Overview").
mapRouter.get('/cities/:cityId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM v_city_summary WHERE city_id = $1', [req.params.cityId]);
  if (!rows[0]) return res.status(404).json({ error: 'City not found' });
  const c = rows[0];

  const { rows: relayHealth } = await pool.query(
    `SELECT r.health_status, COUNT(*) AS count
     FROM relays r
     JOIN panels pnl ON pnl.id = r.panel_id
     JOIN switchgear sg ON sg.id = pnl.switchgear_id
     JOIN substations s ON s.id = sg.substation_id
     JOIN projects p ON p.id = s.project_id
     WHERE p.city_id = $1
     GROUP BY r.health_status`,
    [req.params.cityId]
  );

  const { rows: recentFaults } = await pool.query(
    `SELECT id, fault_code, fault_type, severity, "timestamp", resolution_status
     FROM faults WHERE city_id = $1 ORDER BY "timestamp" DESC LIMIT 10`,
    [req.params.cityId]
  );

  res.json({
    cityId: c.city_id, nameEn: c.name_en, nameFa: c.name_fa, provinceId: c.province_id,
    projectCount: Number(c.project_count), activeProjectCount: Number(c.active_project_count),
    runningProjectCount: Number(c.running_project_count),
    criticalAlarmCount: Number(c.critical_alarm_count), recentFaultCount: Number(c.recent_fault_count),
    relayHealth: relayHealth.map((r) => ({ status: r.health_status, count: Number(r.count) })),
    recentFaults,
    isDemoData: true,
  });
});

/**
 * Flat city-level markers for the geographic map.
 *
 * Returns one row per city that has projects, with counts and the worst relay health present.
 * There is deliberately no coordinate in this response: the browser resolves a city id to a CITY
 * CENTRE coordinate from its own static table (apps/web/src/lib/mapData.ts). The server never
 * transmits a position, so this endpoint cannot become a location leak even if it is called
 * directly.
 */
mapRouter.get('/markers', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id                AS city_id,
           c.name_en           AS city_name_en,
           c.name_fa           AS city_name_fa,
           pr.id               AS province_id,
           pr.name_en          AS province_name_en,
           pr.name_fa          AS province_name_fa,
           COUNT(DISTINCT p.id)                                                  AS project_count,
           COUNT(DISTINCT r.id)                                                  AS relay_count,
           COUNT(DISTINCT r.id) FILTER (WHERE r.health_status = 'CRITICAL')      AS critical_relays,
           COUNT(DISTINCT r.id) FILTER (WHERE r.health_status = 'OFFLINE')       AS offline_relays,
           COUNT(DISTINCT r.id) FILTER (WHERE r.health_status IN ('WARNING','ATTENTION')) AS warning_relays,
           COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'OPEN' AND a.priority = 'CRITICAL') AS critical_alarms
    FROM cities c
    JOIN provinces pr        ON pr.id = c.province_id
    JOIN projects p          ON p.city_id = c.id
    LEFT JOIN substations sub ON sub.project_id = p.id
    LEFT JOIN switchgear sg  ON sg.substation_id = sub.id
    LEFT JOIN panels pnl     ON pnl.switchgear_id = sg.id
    LEFT JOIN relays r       ON r.panel_id = pnl.id
    LEFT JOIN alarms a       ON a.project_id = p.id
    GROUP BY c.id, c.name_en, c.name_fa, pr.id, pr.name_en, pr.name_fa
    HAVING COUNT(DISTINCT p.id) > 0
    ORDER BY project_count DESC
  `);

  const markers = rows.map((r) => {
    const critical = Number(r.critical_relays) + Number(r.critical_alarms);
    const status =
      critical > 0 ? 'CRITICAL' : Number(r.offline_relays) > 0 ? 'OFFLINE' : Number(r.warning_relays) > 0 ? 'WARNING' : 'HEALTHY';
    return {
      cityId: r.city_id,
      cityNameEn: r.city_name_en,
      cityNameFa: r.city_name_fa,
      provinceId: r.province_id,
      provinceNameEn: r.province_name_en,
      provinceNameFa: r.province_name_fa,
      projectCount: Number(r.project_count),
      relayCount: Number(r.relay_count),
      status,
    };
  });

  res.json({ markers, total: markers.length });
});

/**
 * Project-level pins for the world map.
 *
 * Returns every project with a position, using its explicit pin when one has been placed and
 * falling back to nothing when it has not (the browser then groups it under its city centroid via
 * /markers). Unlike /markers this DOES return coordinates — they are the pins the operator placed
 * themselves; see the policy note at the top of migration 016.
 */
mapRouter.get('/project-pins', async (req, res) => {
  const { country } = req.query as Record<string, string | undefined>;
  const params: any[] = [];
  let where = 'WHERE site_lat IS NOT NULL';
  if (country) {
    params.push(country);
    where += ` AND country_code = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT project_id, code, name, status, health_score, country_code, country_name_en,
            country_name_fa, province_name_en, city_name_en, city_name_fa, location_label,
            site_lat, site_lon, relay_count, critical_relays, offline_relays
     FROM v_project_locations ${where}
     ORDER BY code`,
    params
  );

  const pins = rows.map((r) => ({
    projectId: r.project_id,
    code: r.code,
    name: r.name,
    status: r.status,
    healthScore: r.health_score,
    countryCode: r.country_code,
    countryNameEn: r.country_name_en,
    countryNameFa: r.country_name_fa,
    placeLabel: r.location_label ?? r.city_name_en ?? r.country_name_en,
    lat: Number(r.site_lat),
    lon: Number(r.site_lon),
    relayCount: Number(r.relay_count),
    markerStatus:
      Number(r.critical_relays) > 0 ? 'CRITICAL'
      : Number(r.offline_relays) > 0 ? 'OFFLINE'
      : r.status === 'RUNNING' ? 'HEALTHY'
      : 'WARNING',
  }));

  res.json({ pins, total: pins.length });
});

/** Countries that actually have projects, for the map's country filter. */
mapRouter.get('/countries', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT co.code, co.name_en, co.name_fa, co.centroid_lon, co.centroid_lat,
            COUNT(p.id) AS project_count
     FROM countries co
     LEFT JOIN projects p ON p.country_code = co.code
     GROUP BY co.code, co.name_en, co.name_fa, co.centroid_lon, co.centroid_lat
     ORDER BY project_count DESC, co.name_en`
  );
  res.json({
    countries: rows.map((r) => ({
      code: r.code, nameEn: r.name_en, nameFa: r.name_fa,
      centroidLon: r.centroid_lon != null ? Number(r.centroid_lon) : null,
      centroidLat: r.centroid_lat != null ? Number(r.centroid_lat) : null,
      projectCount: Number(r.project_count),
    })),
  });
});
