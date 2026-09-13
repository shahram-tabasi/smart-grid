import { createRouter } from '../middleware/safeRouter';
import { pool } from '../db/pool';
import { requireAuth, requireRole } from '../middleware/auth';
import { writeAuditLog } from '../middleware/audit';
import { PROTOCOL_CATALOGUE, SourceProtocolV2 } from '@simorgh/shared';

export const provisioningRouter = createRouter();

/**
 * Provisioning: creating real projects and registering real relays.
 *
 * Until this existed, everything in the system came from the demo seed and there was no way to add
 * a real site — which made a field trial impossible.
 *
 * WHAT THIS CAN AND CANNOT DO:
 * it creates *records* — a project, its equipment hierarchy, a relay, and the description of how to
 * reach that relay. It does not touch the relay itself. Registering a communication path tells the
 * Edge Gateway where to *read from*; nothing here can write to, configure or operate any device.
 *
 * LOCATION: every creation endpoint takes provinceId and cityId. There is deliberately no field for
 * an address or coordinate anywhere in this router.
 */

const CAN_PROVISION = ['ADMIN', 'TECHNICAL_MANAGER', 'PROJECT_MANAGER'] as const;
const CAN_PROVISION_EQUIPMENT = ['ADMIN', 'TECHNICAL_MANAGER', 'PROTECTION_ENGINEER'] as const;


/**
 * Insert a row, omitting fields the caller did not supply.
 *
 * This matters more than it looks: several equipment columns are NOT NULL *with a database
 * default*. Passing an explicit NULL for those bypasses the default and fails the constraint, so
 * the value must be left out of the statement entirely for the default to apply.
 */
async function insertRow(
  table: string,
  data: Record<string, unknown>,
  returning: string
): Promise<any> {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null);
  const cols = entries.map(([k]) => k);
  const params = entries.map(([, v]) => v);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${returning}`,
    params
  );
  return rows[0];
}

// ---------------------------------------------------------------------------------------------
// Reference data (for populating the creation forms)
// ---------------------------------------------------------------------------------------------

provisioningRouter.get('/reference', async (_req, res) => {
  const [{ rows: provinces }, { rows: cities }, { rows: customers }, { rows: users }, { rows: pointMaps }] =
    await Promise.all([
      pool.query(
        `SELECT id, name_en, name_fa, coalesce(country_code, 'IR') AS country_code, is_user_created
         FROM provinces ORDER BY coalesce(country_code,'IR'), name_en`
      ),
      pool.query('SELECT id, province_id, name_en, name_fa, is_user_created FROM cities ORDER BY name_en'),
      pool.query('SELECT id, name FROM customers ORDER BY name'),
      pool.query("SELECT id, full_name, role FROM users WHERE is_active ORDER BY role, full_name"),
      pool.query('SELECT profile_id, display_name, manufacturer, models FROM point_map_profiles ORDER BY manufacturer'),
    ]);

  // Protocols, annotated with what a commissioning engineer needs to choose well.
  const protocols = Object.values(PROTOCOL_CATALOGUE).map((p) => ({
    protocol: p.protocol,
    tier: p.tier,
    displayName: p.displayName,
    family: p.family,
    transport: p.transport,
    defaultPort: p.defaultPort ?? null,
    implementation: p.implementation,
    deliveryMode: p.deliveryMode,
    needsHost: ['TCP', 'UDP'].includes(p.transport),
    needsSerial: p.transport.startsWith('SERIAL'),
    needsPointMap: ['MODBUS', 'DNP3', 'IEC60870'].includes(p.family),
    carriesFaultRecords: p.capabilities.faultRecords,
    carriesEvents: p.capabilities.sequenceOfEvents,
    notes: p.notes,
  }));

  const { rows: countries } = await pool.query(
    'SELECT code, name_en, name_fa FROM countries ORDER BY name_en'
  );

  res.json({ countries, provinces, cities, customers, users, pointMaps, protocols });
});

// ---------------------------------------------------------------------------------------------
// User-created locations
//
// Iranian provinces and their counties are seeded (db/migrations/017). Everywhere else is created
// on demand: Electro Kavir ships panels worldwide and has branches outside Iran, so the form has to
// accept "Germany / Berlin / Berlin" without anyone editing a seed file first. Pre-loading a world
// gazetteer would be orders of magnitude more data than this application needs and would still be
// missing the specific town a panel ships to.
//
// These create location LABELS only. They record no address and no coordinates — the site privacy
// rule in docs/ARCHITECTURE.md §9 is unaffected, and a province/city pair remains the most precise
// location this system stores for a utility substation.
// ---------------------------------------------------------------------------------------------

/** Turns a display name into a stable, collision-resistant id. */
function slugify(prefix: string, name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  // Latin-only names give a readable id; a purely Persian name would slug to nothing useful, so
  // fall back to a random suffix rather than producing an empty or ambiguous key.
  const safe = /^[a-z0-9_]+$/.test(base) && base.length > 0 ? base : Math.random().toString(36).slice(2, 10);
  return `${prefix}${safe}`;
}

provisioningRouter.post('/locations/provinces', requireAuth, requireRole(...CAN_PROVISION), async (req, res) => {
  const { nameEn, nameFa, countryCode } = req.body ?? {};
  if (!nameEn || !countryCode) {
    return res.status(400).json({ error: 'nameEn and countryCode are required' });
  }

  const { rows: country } = await pool.query('SELECT code FROM countries WHERE code = $1', [countryCode]);
  if (!country[0]) return res.status(400).json({ error: `Unknown country code "${countryCode}"` });

  // Case-insensitive match, so "berlin" does not become a second Berlin next to "Berlin".
  const { rows: dup } = await pool.query(
    'SELECT id, name_en FROM provinces WHERE country_code = $1 AND lower(name_en) = lower($2)',
    [countryCode, nameEn]
  );
  if (dup[0]) return res.json({ province: dup[0], created: false });

  let id = slugify(`${String(countryCode).toLowerCase()}_`, String(nameEn));
  const { rows: clash } = await pool.query('SELECT id FROM provinces WHERE id = $1', [id]);
  if (clash[0]) id = `${id}_${Math.random().toString(36).slice(2, 6)}`;

  const { rows } = await pool.query(
    `INSERT INTO provinces (id, name_en, name_fa, country_code, is_user_created)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, name_en, name_fa, country_code, is_user_created`,
    [id, String(nameEn).trim(), String(nameFa || nameEn).trim(), countryCode]
  );

  await writeAuditLog({
    userId: req.user!.id, action: 'CREATE', entityType: 'PROVINCE', entityId: id, ipAddress: req.ip,
  });
  res.status(201).json({ province: rows[0], created: true });
});

provisioningRouter.post('/locations/cities', requireAuth, requireRole(...CAN_PROVISION), async (req, res) => {
  const { nameEn, nameFa, provinceId } = req.body ?? {};
  if (!nameEn || !provinceId) {
    return res.status(400).json({ error: 'nameEn and provinceId are required' });
  }

  const { rows: prov } = await pool.query('SELECT id FROM provinces WHERE id = $1', [provinceId]);
  if (!prov[0]) return res.status(400).json({ error: `Unknown provinceId "${provinceId}"` });

  const { rows: dup } = await pool.query(
    'SELECT id, name_en FROM cities WHERE province_id = $1 AND lower(name_en) = lower($2)',
    [provinceId, nameEn]
  );
  if (dup[0]) return res.json({ city: dup[0], created: false });

  let id = slugify('city_', String(nameEn));
  const { rows: clash } = await pool.query('SELECT id FROM cities WHERE id = $1', [id]);
  if (clash[0]) id = `${id}_${Math.random().toString(36).slice(2, 6)}`;

  const { rows } = await pool.query(
    `INSERT INTO cities (id, province_id, name_en, name_fa, is_user_created)
     VALUES ($1, $2, $3, $4, true)
     RETURNING id, province_id, name_en, name_fa, is_user_created`,
    [id, provinceId, String(nameEn).trim(), String(nameFa || nameEn).trim()]
  );

  await writeAuditLog({
    userId: req.user!.id, action: 'CREATE', entityType: 'CITY', entityId: id, ipAddress: req.ip,
  });
  res.status(201).json({ city: rows[0], created: true });
});

// ---------------------------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------------------------

provisioningRouter.post('/projects', requireAuth, requireRole(...CAN_PROVISION), async (req, res) => {
  const {
    code, name, customerId, provinceId, cityId, projectType, voltageLevel,
    projectManagerId, technicalManagerId, startDate, expectedCompletion, status,
  } = req.body ?? {};

  if (!code || !name || !provinceId || !cityId) {
    return res.status(400).json({ error: 'code, name, provinceId and cityId are required' });
  }

  const { rows: cityCheck } = await pool.query(
    'SELECT id FROM cities WHERE id = $1 AND province_id = $2',
    [cityId, provinceId]
  );
  if (!cityCheck[0]) {
    return res.status(400).json({ error: 'cityId does not belong to provinceId' });
  }

  const { rows: existing } = await pool.query('SELECT id FROM projects WHERE code = $1', [code]);
  if (existing[0]) return res.status(409).json({ error: `A project with code "${code}" already exists` });

  const { rows } = await pool.query(
    `INSERT INTO projects (
       code, name, customer_id, province_id, city_id, project_type, voltage_level, status,
       project_manager_id, technical_manager_id, start_date, expected_completion, is_demo_data)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'OTHER')::project_type,$7,COALESCE($8,'PLANNING')::project_status,$9,$10,$11,$12, FALSE)
     RETURNING id, code, name, status`,
    [
      code, name, customerId ?? null, provinceId, cityId, projectType ?? null, voltageLevel ?? null,
      status ?? null, projectManagerId ?? null, technicalManagerId ?? null,
      startDate ?? null, expectedCompletion ?? null,
    ]
  );

  await writeAuditLog({
    userId: req.user!.id, action: 'PROJECT_CREATE', entityType: 'PROJECT',
    entityId: rows[0].id, details: { code, name }, ipAddress: req.ip,
  });
  res.status(201).json(rows[0]);
});

// ---------------------------------------------------------------------------------------------
// Equipment hierarchy
// ---------------------------------------------------------------------------------------------

provisioningRouter.post('/substations', requireAuth, requireRole(...CAN_PROVISION_EQUIPMENT), async (req, res) => {
  const { projectId, name, substationType, voltageLevel } = req.body ?? {};
  if (!projectId || !name) return res.status(400).json({ error: 'projectId and name are required' });

  const row = await insertRow(
    'substations',
    { project_id: projectId, name, substation_type: substationType, voltage_level: voltageLevel, is_demo_data: false },
    'id, name'
  );
  await writeAuditLog({ userId: req.user!.id, action: 'SUBSTATION_CREATE', entityType: 'SUBSTATION', entityId: row.id, ipAddress: req.ip });
  res.status(201).json(row);
});

provisioningRouter.post('/switchgear', requireAuth, requireRole(...CAN_PROVISION_EQUIPMENT), async (req, res) => {
  const { substationId, name, voltageLevel, switchgearType, manufacturer } = req.body ?? {};
  if (!substationId || !name || !voltageLevel) {
    return res.status(400).json({ error: 'substationId, name and voltageLevel are required (e.g. voltageLevel "20kV")' });
  }

  const row = await insertRow(
    'switchgear',
    { substation_id: substationId, name, voltage_level: voltageLevel, switchgear_type: switchgearType, manufacturer, is_demo_data: false },
    'id, name'
  );
  await writeAuditLog({ userId: req.user!.id, action: 'SWITCHGEAR_CREATE', entityType: 'SWITCHGEAR', entityId: row.id, ipAddress: req.ip });
  res.status(201).json(row);
});

provisioningRouter.post('/panels', requireAuth, requireRole(...CAN_PROVISION_EQUIPMENT), async (req, res) => {
  const { switchgearId, name, panelType } = req.body ?? {};
  if (!switchgearId || !name) return res.status(400).json({ error: 'switchgearId and name are required' });

  const row = await insertRow(
    'panels',
    { switchgear_id: switchgearId, name, panel_type: panelType, is_demo_data: false },
    'id, name'
  );
  await writeAuditLog({ userId: req.user!.id, action: 'PANEL_CREATE', entityType: 'PANEL', entityId: row.id, ipAddress: req.ip });
  res.status(201).json(row);
});

provisioningRouter.post('/relays', requireAuth, requireRole(...CAN_PROVISION_EQUIPMENT), async (req, res) => {
  const { panelId, relayCode, manufacturer, model, firmwareVersion, serialNumber, voltageLevel } = req.body ?? {};
  if (!panelId || !relayCode || !manufacturer || !model || !voltageLevel) {
    return res.status(400).json({
      error: 'panelId, relayCode, manufacturer, model and voltageLevel are required (e.g. voltageLevel "20kV")',
    });
  }

  const { rows: dup } = await pool.query('SELECT id FROM relays WHERE relay_code = $1', [relayCode]);
  if (dup[0]) return res.status(409).json({ error: `A relay with code "${relayCode}" already exists` });

  // A newly registered relay starts OFFLINE with UNKNOWN comms: nothing has been read from it yet,
  // and claiming otherwise would put a green light on a device we have never contacted.
  const row = await insertRow(
    'relays',
    {
      panel_id: panelId,
      relay_code: relayCode,
      manufacturer,
      model,
      voltage_level: voltageLevel,
      firmware_version: firmwareVersion,
      serial_number: serialNumber,
      comm_status: 'UNKNOWN',
      health_status: 'OFFLINE',
      is_demo_data: false,
    },
    'id, relay_code'
  );

  await writeAuditLog({
    userId: req.user!.id, action: 'RELAY_CREATE', entityType: 'RELAY',
    entityId: row.id, details: { relayCode, manufacturer, model }, ipAddress: req.ip,
  });
  res.status(201).json({
    ...row,
    nextStep: 'Register at least one communication path: POST /api/provisioning/relays/{relayId}/paths',
  });
});

// ---------------------------------------------------------------------------------------------
// Communication paths
// ---------------------------------------------------------------------------------------------

/**
 * Register how the gateway should reach a relay.
 *
 * This is a READ configuration: it tells the gateway which protocol to speak and where to listen.
 * The drivers behind these protocols have no write capability (see docs/ARCHITECTURE.md P2.4), so
 * registering a path cannot create a control channel.
 */
provisioningRouter.post('/relays/:relayId/paths', requireAuth, requireRole(...CAN_PROVISION_EQUIPMENT), async (req, res) => {
  const {
    pathId, protocol, role, host, port, serialDevice, serialBaudRate, serialLinkAddress,
    credentialsRef, addressing, pollIntervalMs, supervisionTimeoutSec, pointMapProfileId, enabled,
  } = req.body ?? {};

  if (!pathId || !protocol) return res.status(400).json({ error: 'pathId and protocol are required' });

  const descriptor = PROTOCOL_CATALOGUE[protocol as SourceProtocolV2];
  if (!descriptor) return res.status(400).json({ error: `Unknown protocol "${protocol}"` });

  const { rows: relayRows } = await pool.query(
    'SELECT id, relay_code, manufacturer FROM relays WHERE id::text = $1 OR relay_code = $1',
    [req.params.relayId]
  );
  const relay = relayRows[0];
  if (!relay) return res.status(404).json({ error: 'Relay not found' });

  // Validate the path the same way the gateway will, so a misconfiguration is caught here with a
  // clear message rather than as a silent connection failure at 3am.
  const problems: string[] = [];
  const needsHost = ['TCP', 'UDP'].includes(descriptor.transport);
  const needsSerial = descriptor.transport.startsWith('SERIAL');
  if (needsHost && !host) problems.push(`${descriptor.displayName} needs a host address.`);
  if (needsSerial && !serialDevice) problems.push(`${descriptor.displayName} needs a serial device (e.g. /dev/ttyS0 or COM3).`);
  if (descriptor.transport === 'ETHERNET_LAYER2' && !addressing?.networkInterface) {
    problems.push(`${descriptor.displayName} is layer-2 multicast and needs addressing.networkInterface (the station-bus interface).`);
  }
  if (descriptor.deliveryMode === 'POLL' && !pollIntervalMs) {
    problems.push(`${descriptor.displayName} is poll-based; set pollIntervalMs.`);
  }
  if (['MODBUS', 'DNP3', 'IEC60870'].includes(descriptor.family) && !pointMapProfileId) {
    problems.push(
      `${descriptor.displayName} carries values at numeric addresses with no built-in meaning. Assign a point-map profile, or no data can be interpreted.`
    );
  }
  if (problems.length) return res.status(400).json({ error: 'Path configuration is incomplete', problems });

  const { rows: dup } = await pool.query(
    'SELECT id FROM relay_comm_paths WHERE relay_id = $1 AND path_id = $2',
    [relay.id, pathId]
  );
  if (dup[0]) return res.status(409).json({ error: `Path "${pathId}" already exists for this relay` });

  const { rows } = await pool.query(
    `INSERT INTO relay_comm_paths (
       relay_id, path_id, protocol, role, host, port, serial_device, serial_baud_rate,
       serial_link_address, credentials_ref, addressing, poll_interval_ms,
       supervision_timeout_s, point_map_profile_id, enabled)
     VALUES ($1,$2,$3,COALESCE($4,'PRIMARY')::comm_path_role,$5,$6,$7,$8,$9,$10,COALESCE($11,'{}'::jsonb),$12,COALESCE($13,60),$14,COALESCE($15,TRUE))
     RETURNING id, path_id, protocol, role`,
    [
      relay.id, pathId, protocol, role ?? null, host ?? null, port ?? descriptor.defaultPort ?? null,
      serialDevice ?? null, serialBaudRate ?? null, serialLinkAddress ?? null,
      credentialsRef ?? null, addressing ? JSON.stringify(addressing) : null,
      pollIntervalMs ?? null, supervisionTimeoutSec ?? null, pointMapProfileId ?? null, enabled ?? null,
    ]
  );

  await pool.query(
    `INSERT INTO relay_comm_path_status (path_row_id, state) VALUES ($1, 'DISCONNECTED')
     ON CONFLICT (path_row_id) DO NOTHING`,
    [rows[0].id]
  );

  // Keep the relay's headline protocol in step with its primary path, so existing screens that
  // show a single protocol per relay stay truthful.
  if ((role ?? 'PRIMARY') === 'PRIMARY') {
    await pool.query('UPDATE relays SET protocol = $2, updated_at = now() WHERE id = $1', [relay.id, protocol]);
  }

  await writeAuditLog({
    userId: req.user!.id, action: 'COMM_PATH_CREATE', entityType: 'RELAY',
    entityId: relay.id, details: { pathId, protocol, role: role ?? 'PRIMARY' }, ipAddress: req.ip,
  });

  const warnings: string[] = [];
  if (descriptor.family === 'MODBUS') {
    warnings.push(
      'Modbus has no event buffer: a trip shorter than the poll interval can be missed entirely, and its timestamps are assigned on arrival rather than by the relay. Add a protection-grade path (IEC 61850, IEC 60870-5-103 or DNP3) if this relay supports one.'
    );
  }
  if (descriptor.implementation === 'ADAPTER_REQUIRED') {
    warnings.push(
      `${descriptor.displayName} needs a native stack or vendor SDK bound on the gateway before it talks to real hardware; until then it runs in simulator mode.`
    );
  }

  res.status(201).json({ ...rows[0], warnings });
});

/** Full provisioning tree for a project — used to confirm what was actually created. */
provisioningRouter.get('/projects/:projectId/tree', requireAuth, async (req, res) => {
  const { rows: proj } = await pool.query(
    `SELECT p.id, p.code, p.name, p.status, pr.name_en AS province, c.name_en AS city
     FROM projects p JOIN provinces pr ON pr.id = p.province_id JOIN cities c ON c.id = p.city_id
     WHERE p.id::text = $1 OR p.code = $1`,
    [req.params.projectId]
  );
  if (!proj[0]) return res.status(404).json({ error: 'Project not found' });

  const { rows } = await pool.query(
    `SELECT sub.id AS substation_id, sub.name AS substation_name,
            sg.id AS switchgear_id, sg.name AS switchgear_name,
            pnl.id AS panel_id, pnl.name AS panel_name,
            r.id AS relay_id, r.relay_code, r.manufacturer, r.model, r.comm_status, r.health_status,
            cp.path_id, cp.protocol, cp.role, cp.enabled, cps.state
     FROM substations sub
     LEFT JOIN switchgear sg ON sg.substation_id = sub.id
     LEFT JOIN panels pnl ON pnl.switchgear_id = sg.id
     LEFT JOIN relays r ON r.panel_id = pnl.id
     LEFT JOIN relay_comm_paths cp ON cp.relay_id = r.id
     LEFT JOIN relay_comm_path_status cps ON cps.path_row_id = cp.id
     WHERE sub.project_id = $1
     ORDER BY sub.name, sg.name, pnl.name, r.relay_code, cp.path_id`,
    [proj[0].id]
  );

  res.json({ project: proj[0], rows });
});

/**
 * Set or clear a project's map position.
 *
 * Called when the operator drops a pin on the world map. Passing null coordinates clears the pin
 * and the project falls back to city-level grouping.
 */
provisioningRouter.put('/projects/:projectId/location', requireAuth, requireRole(...CAN_PROVISION), async (req, res) => {
  const { lat, lon, countryCode, locationLabel } = req.body ?? {};

  const hasCoords = lat !== undefined && lat !== null && lon !== undefined && lon !== null;
  if (hasCoords) {
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN) || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
      return res.status(400).json({ error: 'lat must be between -90 and 90, lon between -180 and 180' });
    }
  }

  if (countryCode) {
    const { rows: c } = await pool.query('SELECT code FROM countries WHERE code = $1', [countryCode]);
    if (!c[0]) return res.status(400).json({ error: `Unknown country code "${countryCode}"` });
  }

  const { rows } = await pool.query(
    `UPDATE projects
        SET site_lat = $2, site_lon = $3,
            country_code = COALESCE($4, country_code),
            location_label = COALESCE($5, location_label),
            updated_at = now()
      WHERE id::text = $1 OR code = $1
      RETURNING id, code, site_lat, site_lon, country_code, location_label`,
    [
      req.params.projectId,
      hasCoords ? Number(lat) : null,
      hasCoords ? Number(lon) : null,
      countryCode ?? null,
      locationLabel ?? null,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });

  await writeAuditLog({
    userId: req.user!.id, action: hasCoords ? 'PROJECT_LOCATION_SET' : 'PROJECT_LOCATION_CLEAR',
    entityType: 'PROJECT', entityId: rows[0].id,
    details: { lat: rows[0].site_lat, lon: rows[0].site_lon, countryCode: rows[0].country_code },
    ipAddress: req.ip,
  });
  res.json(rows[0]);
});

/** Projects list for the map's "assign a location" picker. */
provisioningRouter.get('/projects', requireAuth, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT project_id, code, name, status, country_code, country_name_en,
            city_name_en, location_label, site_lat, site_lon, has_pin
     FROM v_project_locations ORDER BY has_pin, code`
  );
  res.json({ projects: rows });
});

/**
 * Test whether a relay is reachable, before committing a path.
 *
 * This is a pure reachability probe: open a TCP connection to the protocol port, then close it. It
 * sends no protocol bytes, so it cannot disturb the device — the relay sees a connection that opened
 * and closed, which is the same thing any port scan or health check does.
 *
 * Why it exists: the single most common failure when commissioning is a network problem — wrong IP,
 * wrong VLAN, protocol not enabled on the relay, firewall in the way. Discovering that here, with a
 * clear message, is far better than saving a path and later wondering why the relay shows OFFLINE.
 *
 * Note the honest limitation, reported in the response: a successful TCP connect proves the port is
 * open. It does NOT prove the relay speaks the protocol you selected, nor that your point map is
 * right. Only real data can show that.
 */
provisioningRouter.post('/test-connection', requireAuth, requireRole(...CAN_PROVISION_EQUIPMENT), async (req, res) => {
  const { host, port, protocol } = req.body ?? {};

  const descriptor = protocol ? PROTOCOL_CATALOGUE[protocol as SourceProtocolV2] : undefined;
  if (protocol && !descriptor) return res.status(400).json({ error: `Unknown protocol "${protocol}"` });

  if (descriptor && descriptor.transport.startsWith('SERIAL')) {
    return res.json({
      reachable: null,
      message: `${descriptor.displayName} runs over a serial link. Reachability cannot be tested from the server — the gateway will report the link state once it starts.`,
    });
  }
  if (descriptor && descriptor.transport === 'ETHERNET_LAYER2') {
    return res.json({
      reachable: null,
      message: `${descriptor.displayName} is layer-2 multicast with no IP address to connect to. The gateway must sit on the station-bus VLAN; it will report whether it receives traffic.`,
    });
  }

  const targetPort = Number(port ?? descriptor?.defaultPort);
  if (!host || !Number.isFinite(targetPort) || targetPort <= 0 || targetPort > 65535) {
    return res.status(400).json({ error: 'host and a valid port are required' });
  }

  // Refuse to probe anything but a plain host — this endpoint must not become a way to make the
  // server issue arbitrary requests on someone's behalf.
  if (!/^[a-zA-Z0-9._-]+$/.test(String(host))) {
    return res.status(400).json({ error: 'host must be a hostname or IP address' });
  }

  const net = await import('net');
  const started = Date.now();
  const timeoutMs = 5000;

  const result = await new Promise<{ reachable: boolean; latencyMs?: number; reason?: string }>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (r: { reachable: boolean; latencyMs?: number; reason?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true, latencyMs: Date.now() - started }));
    socket.once('timeout', () => finish({ reachable: false, reason: 'timeout' }));
    socket.once('error', (err: any) => finish({ reachable: false, reason: err?.code ?? err?.message ?? 'error' }));
    socket.connect(targetPort, String(host));
  });

  // Translate the socket error into something a commissioning engineer can act on.
  let message: string;
  if (result.reachable) {
    message = `Port ${targetPort} on ${host} is open (${result.latencyMs} ms). This proves the network path works — it does not yet prove the relay speaks ${descriptor?.displayName ?? 'this protocol'}.`;
  } else if (result.reason === 'ECONNREFUSED') {
    message = `${host} answered but refused port ${targetPort}. The device is reachable, so the network is fine — the protocol is probably not enabled on the relay, or it is listening on a different port.`;
  } else if (result.reason === 'timeout' || result.reason === 'EHOSTUNREACH' || result.reason === 'ENETUNREACH') {
    message = `No response from ${host}:${targetPort} within ${timeoutMs / 1000}s. Usual causes: wrong IP address, the relay is on a different VLAN or subnet from this server, or a firewall is blocking it.`;
  } else if (result.reason === 'ENOTFOUND' || result.reason === 'EAI_AGAIN') {
    message = `The name "${host}" could not be resolved. Use the relay's IP address instead.`;
  } else {
    message = `Could not reach ${host}:${targetPort} (${result.reason}).`;
  }

  res.json({
    reachable: result.reachable,
    latencyMs: result.latencyMs ?? null,
    reason: result.reason ?? null,
    message,
    // Said plainly so nobody reads a green tick as "commissioning complete".
    caveat: result.reachable
      ? 'A successful connection confirms the network path only. Verify the readings against the relay display before trusting the data.'
      : null,
    testedFrom: 'api-server',
  });
});
