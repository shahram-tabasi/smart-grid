// Generates realistic, internally-consistent, clearly-flagged synthetic data for the whole platform:
// >=50 projects, >=15 cities, >=150 relays, >=500 events, >=50 faults, >=20 alarms, >=15 work orders
// (spec §27). Every row this script writes carries is_demo_data = true (or, for events, synthetic = true
// baked into is_demo_data as well) so it can never be confused with live field data.
//
// Idempotent: truncates prior demo data (cascading from the reference tables) before regenerating, so
// `npm run db:seed` is safe to re-run during development.
import 'dotenv/config';
import { Pool, PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import {
  PROVINCES, CITIES, PROJECT_STATUSES, PROJECT_TYPES, RELAY_MANUFACTURERS,
  RELAY_MODELS_BY_MANUFACTURER, PROTECTION_FUNCTION_ANSI, ProtectionFunctionCode,
} from '@simorgh/shared';
import { makeRng, pick, pickWeighted, randInt, randFloat, daysAgo, shuffle, Rng } from './rng';
import {
  CUSTOMERS, FIRST_NAMES, LAST_NAMES, VOLTAGE_LEVELS, PANEL_TYPE_WEIGHTS,
  PanelType, SWITCHGEAR_TYPES,
} from './reference-data';

const rng: Rng = makeRng(20260908); // fixed seed -> reproducible demo dataset

const CITY_ABBR: Record<string, string> = {
  city_tehran: 'TEH', city_shahriar: 'SHR', city_rey: 'REY', city_eslamshahr: 'ESL',
  city_isfahan: 'ESF', city_mobarakeh: 'MOB', city_kashan: 'KSH',
  city_kerman: 'KER', city_sirjan: 'SIR', city_rafsanjan: 'RAF',
  city_shiraz: 'SHZ', city_marvdasht: 'MRV',
  city_mashhad: 'MSH', city_neyshabur: 'NSH',
  city_ahvaz: 'AHV', city_abadan: 'ABD',
  city_tabriz: 'TBZ', city_karaj: 'KRJ', city_qom: 'QOM', city_yazd: 'YAZ',
  city_semnan: 'SEM', city_damghan: 'DAM', city_bandar_abbas: 'BND', city_arak: 'ARK',
};

// Hub cities get more projects, matching the density shown in the spec's map example.
const CITY_WEIGHTS: [string, number][] = CITIES.map((c) => [
  c.id,
  ['city_tehran', 'city_isfahan', 'city_kerman', 'city_shiraz', 'city_mashhad', 'city_ahvaz', 'city_tabriz', 'city_karaj'].includes(c.id) ? 4 : 1,
]);

const PROJECT_COUNT = 56;
const FAULT_COUNT = 58;

const FAULT_TYPE_LABEL: Record<ProtectionFunctionCode, string> = {
  OVERCURRENT: 'Feeder Overcurrent',
  EARTH_FAULT: 'Earth Fault',
  SHORT_CIRCUIT: 'Phase-to-Phase Short Circuit',
  OVERVOLTAGE: 'Overvoltage',
  UNDERVOLTAGE: 'Undervoltage',
  OVERFREQUENCY: 'Overfrequency',
  UNDERFREQUENCY: 'Underfrequency',
  TRANSFORMER_DIFFERENTIAL: 'Transformer Differential Protection Operation',
  BUSBAR_DIFFERENTIAL: 'Busbar Differential Protection Operation',
  BREAKER_FAILURE: 'Breaker Failure',
  NEGATIVE_SEQUENCE: 'Negative Sequence / Phase Unbalance',
  THERMAL_OVERLOAD: 'Thermal Overload',
  MOTOR_PROTECTION: 'Motor Overload / Stall Protection',
  DISTANCE_PROTECTION: 'Distance Protection Operation (Zone 1)',
  DIRECTIONAL_OVERCURRENT: 'Directional Overcurrent',
  LOSS_OF_VOLTAGE: 'Loss of Voltage',
  LOSS_OF_CURRENT: 'Loss of Current / CT Circuit Supervision',
  TRIP_CIRCUIT_FAILURE: 'Trip Circuit Supervision Failure',
};

const PANEL_FUNCTIONS: Record<PanelType, ProtectionFunctionCode[]> = {
  FEEDER: ['OVERCURRENT', 'EARTH_FAULT', 'DIRECTIONAL_OVERCURRENT'],
  TRANSFORMER_FEEDER: ['TRANSFORMER_DIFFERENTIAL', 'OVERCURRENT', 'THERMAL_OVERLOAD'],
  INCOMER: ['UNDERVOLTAGE', 'OVERVOLTAGE', 'LOSS_OF_VOLTAGE', 'BREAKER_FAILURE'],
  BUS_COUPLER: ['BREAKER_FAILURE', 'OVERCURRENT', 'BUSBAR_DIFFERENTIAL'],
  MOTOR: ['MOTOR_PROTECTION', 'THERMAL_OVERLOAD', 'NEGATIVE_SEQUENCE'],
  CAPACITOR_BANK: ['OVERCURRENT', 'NEGATIVE_SEQUENCE'],
};

function fullName() {
  return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
}

function pad(n: number, width: number) {
  return String(n).padStart(width, '0');
}

async function bulkInsert(client: PoolClient, table: string, columns: string[], rows: any[][]) {
  if (rows.length === 0) return;
  const chunkSize = 150;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values: any[] = [];
    const placeholders = chunk
      .map((row, ri) => {
        const base = ri * columns.length;
        const ph = columns.map((_, ci) => `$${base + ci + 1}`).join(',');
        values.push(...row);
        return `(${ph})`;
      })
      .join(',');
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, values);
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('[seed] truncating prior demo data...');
    await client.query(
      'TRUNCATE TABLE provinces, customers, users, company RESTART IDENTITY CASCADE'
    );

    console.log('[seed] reference geography...');
    await bulkInsert(client, 'provinces', ['id', 'name_en', 'name_fa'], PROVINCES.map((p) => [p.id, p.nameEn, p.nameFa]));
    await bulkInsert(client, 'cities', ['id', 'province_id', 'name_en', 'name_fa'], CITIES.map((c) => [c.id, c.provinceId, c.nameEn, c.nameFa]));

    await client.query('INSERT INTO company (id, name) VALUES ($1, $2)', [uuid(), 'Kavir Switchgear & Engineering Co.']);

    console.log('[seed] customers...');
    const customerIds = CUSTOMERS.map(() => uuid());
    await bulkInsert(
      client, 'customers', ['id', 'name', 'industry'],
      CUSTOMERS.map((name, i) => [customerIds[i], name, pick(rng, ['Steel', 'Mining', 'Petrochemical', 'Cement', 'Utilities', 'Manufacturing', 'Textiles'])])
    );

    console.log('[seed] users...');
    const passwordHash = await bcrypt.hash('Demo@1234', 10);
    type SeedUser = { id: string; email: string; fullName: string; role: string };
    const roleQuota: [string, number][] = [
      ['ADMIN', 2], ['EXECUTIVE', 2], ['PROJECT_MANAGER', 7], ['TECHNICAL_MANAGER', 6],
      ['PROTECTION_ENGINEER', 9], ['FIELD_SERVICE_ENGINEER', 7], ['VIEWER', 3],
    ];
    const users: SeedUser[] = [];

    // Fixed sign-in accounts, one per role, with STABLE addresses.
    // These exist so the documentation can name a working account: the staff accounts generated
    // below get random names on every seed run, so they can never be written down. Anyone
    // evaluating the system signs in with one of these; the random staff accounts remain for
    // realistic project-manager / engineer assignment data.
    // Keep this list in sync with the account table in docs/OPERATIONS_MANUAL.md §3.
    const FIXED_ACCOUNTS: Array<{ email: string; fullName: string; role: string }> = [
      { email: 'admin@simorgh.local', fullName: 'Demo Administrator', role: 'ADMIN' },
      { email: 'ceo@simorgh.local', fullName: 'Demo Executive', role: 'EXECUTIVE' },
      { email: 'pm@simorgh.local', fullName: 'Demo Project Manager', role: 'PROJECT_MANAGER' },
      { email: 'tech@simorgh.local', fullName: 'Demo Technical Manager', role: 'TECHNICAL_MANAGER' },
      { email: 'protection@simorgh.local', fullName: 'Demo Protection Engineer', role: 'PROTECTION_ENGINEER' },
      { email: 'field@simorgh.local', fullName: 'Demo Field Service Engineer', role: 'FIELD_SERVICE_ENGINEER' },
      { email: 'viewer@simorgh.local', fullName: 'Demo Viewer', role: 'VIEWER' },
    ];
    for (const acct of FIXED_ACCOUNTS) {
      users.push({ id: uuid(), email: acct.email, fullName: acct.fullName, role: acct.role });
    }

    for (const [role, count] of roleQuota) {
      for (let i = 0; i < count; i++) {
        const name = fullName();
        const emailSlug = name.toLowerCase().replace(/\s+/g, '.');
        users.push({ id: uuid(), email: `${emailSlug}${users.length}@kavir-grid.demo`, fullName: name, role });
      }
    }
    await bulkInsert(
      client, 'users', ['id', 'email', 'password_hash', 'full_name', 'role', 'can_read_precise_location'],
      users.map((u) => [u.id, u.email, passwordHash, u.fullName, u.role, u.role === 'ADMIN'])
    );
    const byRole = (role: string) => users.filter((u) => u.role === role);
    const admin = byRole('ADMIN')[0];

    // ---------------------------------------------------------------------------------------
    // Projects + full equipment hierarchy
    // ---------------------------------------------------------------------------------------
    console.log('[seed] projects + equipment hierarchy...');

    const projectStatusWeights: [string, number][] = [
      ['PLANNING', 3], ['ENGINEERING', 9], ['PROCUREMENT', 5], ['MANUFACTURING', 6], ['FAT', 5],
      ['INSTALLATION', 8], ['COMMISSIONING', 9], ['RUNNING', 44], ['COMPLETED', 8], ['BLOCKED', 3],
    ];
    const STAGE_ORDER = ['ENGINEERING', 'MANUFACTURING', 'FAT', 'INSTALLATION', 'COMMISSIONING'];

    function computeProgress(status: string) {
      let idx: number;
      if (status === 'PLANNING') idx = -1;
      else if (status === 'PROCUREMENT') idx = 0;
      else if (status === 'RUNNING' || status === 'COMPLETED') idx = STAGE_ORDER.length;
      else if (status === 'BLOCKED') idx = randInt(rng, 0, STAGE_ORDER.length - 1);
      else idx = STAGE_ORDER.indexOf(status);

      const values: Record<string, number> = {};
      STAGE_ORDER.forEach((stage, p) => {
        let v: number;
        if (status === 'BLOCKED' && p === idx) v = randInt(rng, 20, 60);
        else if (p < idx) v = randInt(rng, 88, 100);
        else if (p === idx) v = randInt(rng, 15, 85);
        else v = randInt(rng, 0, 8);
        values[stage] = v;
      });
      const installDone = values['INSTALLATION'];
      const commDone = values['COMMISSIONING'];
      const scada = status === 'RUNNING' || status === 'COMPLETED'
        ? randInt(rng, 92, 100)
        : Math.max(0, Math.round((installDone + commDone) / 2 - randInt(rng, 0, 15)));
      const relayIntegration = status === 'RUNNING' || status === 'COMPLETED'
        ? randInt(rng, 95, 100)
        : Math.max(0, Math.round(values['FAT'] * 0.8 + values['INSTALLATION'] * 0.2 - randInt(rng, 0, 10)));

      return {
        engineering: values['ENGINEERING'],
        manufacturing: values['MANUFACTURING'],
        fat: values['FAT'],
        installation: values['INSTALLATION'],
        commissioning: values['COMMISSIONING'],
        scada: Math.min(100, scada),
        relay: Math.min(100, relayIntegration),
      };
    }

    interface SeedRelay {
      id: string; relayCode: string; manufacturer: string; model: string; protocol: string;
      panelId: string; breakerId: string; projectId: string; provinceId: string; cityId: string;
      panelType: PanelType; panelName: string; switchgearName: string; substationName: string;
      commStatus: string; healthStatus: string; healthScore: number; voltageLevel: string;
    }
    const allRelays: SeedRelay[] = [];

    const projectRows: any[] = [];
    const substationRows: any[] = [];
    const switchgearRows: any[] = [];
    const panelRows: any[] = [];
    const breakerRows: any[] = [];
    const relayRows: any[] = [];
    const protectionFunctionRows: any[] = [];
    const cityPanelCounters: Record<string, number> = {};

    interface SeedProject { id: string; code: string; cityId: string; provinceId: string; status: string; }
    const projects: SeedProject[] = [];

    for (let i = 0; i < PROJECT_COUNT; i++) {
      const cityId = pickWeighted(rng, CITY_WEIGHTS);
      const city = CITIES.find((c) => c.id === cityId)!;
      const abbr = CITY_ABBR[cityId];
      const seq = (cityPanelCounters[`proj_${cityId}`] = (cityPanelCounters[`proj_${cityId}`] || 0) + 1);
      const code = `SUB-${abbr}-${pad(seq, 3)}`;
      const customerId = pick(rng, customerIds);
      const projectType = pickWeighted(rng, PROJECT_TYPES.map((t) => [t, t === 'MV_SWITCHGEAR' ? 40 : t === 'SUBSTATION_TURNKEY' ? 20 : 10] as [typeof t, number]));
      const voltageLevel = pick(rng, VOLTAGE_LEVELS);
      const status = pickWeighted(rng, projectStatusWeights);
      const progress = computeProgress(status);
      const pm = pick(rng, byRole('PROJECT_MANAGER'));
      const tm = pick(rng, byRole('TECHNICAL_MANAGER'));
      const startDate = daysAgo(randInt(rng, 90, 900));
      const expected = new Date(startDate.getTime() + randInt(rng, 180, 540) * 86400000);
      const isDoneStatus = status === 'RUNNING' || status === 'COMPLETED';
      const actual = isDoneStatus ? new Date(expected.getTime() + randInt(rng, -30, 45) * 86400000) : null;

      const id = uuid();
      projects.push({ id, code, cityId, provinceId: city.provinceId, status });
      projectRows.push([
        id, code, `${city.nameEn} ${voltageLevel} Switchgear Project`, customerId, city.provinceId, cityId,
        projectType, voltageLevel, pm.id, tm.id,
        startDate.toISOString().slice(0, 10), expected.toISOString().slice(0, 10),
        actual ? actual.toISOString().slice(0, 10) : null,
        status,
        progress.engineering, progress.manufacturing, progress.fat, progress.installation,
        progress.commissioning, progress.scada, progress.relay,
        null, // health_score computed later
        false, false, // requires_engineering_intervention / requires_field_service, computed later
        true, // is_demo_data
      ]);

      // ---- equipment hierarchy ----
      const substationCount = rng() < 0.15 ? 2 : 1;
      for (let s = 0; s < substationCount; s++) {
        const substationId = uuid();
        substationRows.push([substationId, id, `${city.nameEn} ${s === 0 ? 'Main' : 'Secondary'} Substation`, 'SUBSTATION', voltageLevel, true]);

        const switchgearCount = rng() < 0.3 ? 2 : 1;
        for (let sg = 0; sg < switchgearCount; sg++) {
          const switchgearId = uuid();
          const sgVoltage = sg === 0 ? voltageLevel.split('/')[0] : (voltageLevel.split('/')[1] ?? voltageLevel.split('/')[0]);
          const switchgearType = pick(rng, SWITCHGEAR_TYPES);
          switchgearRows.push([switchgearId, substationId, `${sgVoltage} Switchgear`, sgVoltage, switchgearType, 'Kavir Switchgear & Engineering Co.', true]);

          const panelCount = randInt(rng, 3, 8);
          let feederCounter = 0, transformerCounter = 0, motorCounter = 0, capCounter = 0, incomerCounter = 0, couplerCounter = 0;
          for (let p = 0; p < panelCount; p++) {
            const panelType = pickWeighted(rng, PANEL_TYPE_WEIGHTS);
            let panelName: string;
            switch (panelType) {
              case 'FEEDER': panelName = `Feeder ${pad(++feederCounter, 2)}`; break;
              case 'TRANSFORMER_FEEDER': panelName = `Transformer Feeder ${pad(++transformerCounter, 2)}`; break;
              case 'INCOMER': panelName = `Incomer ${pad(++incomerCounter, 2)}`; break;
              case 'BUS_COUPLER': panelName = `Bus Coupler ${pad(++couplerCounter, 2)}`; break;
              case 'MOTOR': panelName = `Motor Feeder ${pad(++motorCounter, 2)}`; break;
              case 'CAPACITOR_BANK': panelName = `Capacitor Bank ${pad(++capCounter, 2)}`; break;
            }
            const panelId = uuid();
            panelRows.push([panelId, switchgearId, panelName, panelType, true]);

            const breakerId = uuid();
            const breakerType = switchgearType === 'GIS' ? 'GIS_CB' : pick(rng, ['VCB', 'SF6']);
            const ratedCurrent = pick(rng, [630, 1250, 1600, 2000, 2500]);
            breakerRows.push([breakerId, panelId, `${panelName} Breaker`, breakerType, ratedCurrent, 'CLOSED', daysAgo(randInt(rng, 1, 200)), randInt(rng, 5, 400), true]);

            if (rng() < 0.9) {
              const manufacturer = pickWeighted<string>(rng, [
                ['Siemens', 30], ['ABB', 20], ['Hitachi Energy', 10], ['Schneider Electric', 15],
                ['SEL', 15], ['GE Multilin', 8], ['Other', 2],
              ]);
              const model = pick(rng, RELAY_MODELS_BY_MANUFACTURER[manufacturer as keyof typeof RELAY_MODELS_BY_MANUFACTURER]);
              const protocol = pickWeighted(rng, [
                ['IEC61850_MMS', 42], ['IEC60870_5_104', 20], ['DNP3', 16], ['MODBUS_TCP', 12],
                ['IEC61850_GOOSE', 6], ['OPC_UA', 4],
              ] as [string, number][]);
              const relayCounterKey = `${abbr}-${panelType}`;
              const relayCounter = (cityPanelCounters[relayCounterKey] = (cityPanelCounters[relayCounterKey] || 0) + 1);
              const typeAbbr = { FEEDER: 'F', TRANSFORMER_FEEDER: 'T', INCOMER: 'I', BUS_COUPLER: 'C', MOTOR: 'M', CAPACITOR_BANK: 'B' }[panelType];
              const relayCode = `${abbr}-${typeAbbr}${pad(relayCounter, 2)}`;
              // Kept low deliberately: with ~7 relays/project on average, even a modest per-relay
              // non-online rate compounds into "most projects have a comm problem" at the project level
              // (v_project_comm_status flags a project if ANY relay is OFFLINE/DEGRADED). This weighting
              // keeps the "projects with comm problems" KPI a plausible minority rather than the majority.
              const commStatus = pickWeighted(rng, [['ONLINE', 94], ['OFFLINE', 3], ['DEGRADED', 2], ['UNKNOWN', 1]] as [string, number][]);
              let healthStatus: string, healthScore: number;
              if (commStatus === 'OFFLINE') { healthStatus = 'OFFLINE'; healthScore = 0; }
              else {
                healthStatus = pickWeighted(rng, [['HEALTHY', 68], ['WARNING', 17], ['ATTENTION', 10], ['CRITICAL', 5]] as [string, number][]);
                healthScore = healthStatus === 'HEALTHY' ? randInt(rng, 85, 100)
                  : healthStatus === 'WARNING' ? randInt(rng, 65, 84)
                  : healthStatus === 'ATTENTION' ? randInt(rng, 40, 64)
                  : randInt(rng, 10, 39);
              }
              const lastComm = commStatus === 'OFFLINE' ? daysAgo(randInt(rng, 1, 30))
                : commStatus === 'DEGRADED' ? daysAgo(0, 6)
                : daysAgo(0, 1);
              const relayId = uuid();
              relayRows.push([
                relayId, panelId, breakerId, relayCode, manufacturer, model, protocol,
                `SN-${randInt(rng, 100000, 999999)}`, `V${randInt(rng, 2, 6)}.${randInt(rng, 10, 99)}`,
                sgVoltage, commStatus, 'IN_SERVICE', 'CLOSED', rng() < 0.9 ? 'Group 1' : 'Group 2',
                lastComm, null, null, 0, 0, healthScore, healthStatus, true,
              ]);
              allRelays.push({
                id: relayId, relayCode, manufacturer, model, protocol, panelId, breakerId,
                projectId: id, provinceId: city.provinceId, cityId, panelType, panelName,
                switchgearName: `${sgVoltage} Switchgear`, substationName: `${city.nameEn} ${s === 0 ? 'Main' : 'Secondary'} Substation`,
                commStatus, healthStatus, healthScore, voltageLevel: sgVoltage,
              });

              for (const fn of PANEL_FUNCTIONS[panelType]) {
                if (rng() < 0.75) {
                  protectionFunctionRows.push([
                    uuid(), relayId, fn, PROTECTION_FUNCTION_ANSI[fn], true,
                    randFloat(rng, 100, 1200, 1), fn.includes('VOLTAGE') ? 'V' : fn.includes('FREQ') ? 'Hz' : 'A',
                    randInt(rng, 50, 2000),
                  ]);
                }
              }
            }
          }
        }
      }
    }

    await bulkInsert(client, 'projects', [
      'id', 'code', 'name', 'customer_id', 'province_id', 'city_id', 'project_type', 'voltage_level',
      'project_manager_id', 'technical_manager_id', 'start_date', 'expected_completion', 'actual_completion',
      'status', 'engineering_progress', 'manufacturing_progress', 'fat_progress', 'installation_progress',
      'commissioning_progress', 'scada_integration_progress', 'relay_integration_progress',
      'health_score', 'requires_engineering_intervention', 'requires_field_service', 'is_demo_data',
    ], projectRows);
    await bulkInsert(client, 'substations', ['id', 'project_id', 'name', 'substation_type', 'voltage_level', 'is_demo_data'], substationRows);
    await bulkInsert(client, 'switchgear', ['id', 'substation_id', 'name', 'voltage_level', 'switchgear_type', 'manufacturer', 'is_demo_data'], switchgearRows);
    await bulkInsert(client, 'panels', ['id', 'switchgear_id', 'name', 'panel_type', 'is_demo_data'], panelRows);
    await bulkInsert(client, 'breakers', ['id', 'panel_id', 'name', 'breaker_type', 'rated_current_a', 'status', 'last_operation_at', 'operation_count', 'is_demo_data'], breakerRows);
    await bulkInsert(client, 'relays', [
      'id', 'panel_id', 'breaker_id', 'relay_code', 'manufacturer', 'model', 'protocol', 'serial_number',
      'firmware_version', 'voltage_level', 'comm_status', 'protection_status', 'breaker_status',
      'active_setting_group', 'last_communication_at', 'last_event_at', 'last_trip_at', 'alarm_count',
      'trip_count', 'health_score', 'health_status', 'is_demo_data',
    ], relayRows);
    await bulkInsert(client, 'protection_functions', ['id', 'relay_id', 'function_code', 'ansi_code', 'enabled', 'pickup_value', 'pickup_unit', 'time_delay_ms'], protectionFunctionRows);

    console.log(`[seed] ${projectRows.length} projects, ${relayRows.length} relays, ${panelRows.length} panels.`);

    // ---------------------------------------------------------------------------------------
    // Events + Faults + Fault Timeline
    // ---------------------------------------------------------------------------------------
    console.log('[seed] events + faults...');

    const eventRows: any[] = [];
    const faultRows: any[] = [];
    const timelineRows: any[] = [];
    const comtradeRows: any[] = [];

    interface SeedFault {
      id: string; faultCode: string; projectId: string; cityId: string; provinceId: string;
      relay: SeedRelay | null; severity: string; timestamp: Date; resolutionStatus: string;
      protectionFunction: ProtectionFunctionCode | null; eventIds: string[]; faultTypeLabel: string;
      assignedEngineerId: string | null; panelName: string;
    }
    const faults: SeedFault[] = [];

    const protEngineers = byRole('PROTECTION_ENGINEER');
    const fieldEngineers = byRole('FIELD_SERVICE_ENGINEER');

    function severityForFunction(fn: ProtectionFunctionCode): string {
      if (['BUSBAR_DIFFERENTIAL', 'TRANSFORMER_DIFFERENTIAL', 'BREAKER_FAILURE'].includes(fn)) return pickWeighted(rng, [['CRITICAL', 70], ['HIGH', 30]]);
      if (['OVERCURRENT', 'EARTH_FAULT', 'SHORT_CIRCUIT', 'DISTANCE_PROTECTION'].includes(fn)) return pickWeighted(rng, [['CRITICAL', 35], ['HIGH', 45], ['MEDIUM', 20]]);
      if (['TRIP_CIRCUIT_FAILURE', 'LOSS_OF_CURRENT', 'LOSS_OF_VOLTAGE'].includes(fn)) return pickWeighted(rng, [['HIGH', 55], ['MEDIUM', 45]]);
      return pickWeighted(rng, [['MEDIUM', 60], ['LOW', 40]]);
    }

    for (let i = 0; i < FAULT_COUNT; i++) {
      const isCommFault = rng() < 0.18 || allRelays.length === 0;
      const relay = allRelays.length ? pick(rng, allRelays) : null;
      const faultTimestamp = daysAgo(randInt(rng, 0, 90), 24);
      const faultId = uuid();
      const faultCode = `FLT-${faultTimestamp.getFullYear()}-${pad(i + 1, 5)}`;
      const eventIdsForFault: string[] = [];

      let severity: string;
      let protectionFunction: ProtectionFunctionCode | null = null;
      let faultTypeLabel: string;
      let tripStatus: string;
      let breakerStatusAfter: string;
      let currentA: number | null = null, voltageKv: number | null = null, freqHz: number | null = null;

      const project = relay ? projects.find((p) => p.id === relay.projectId)! : pick(rng, projects);

      function pushEvent(tsMs: number, type: string, message: string, sev: string, extra: Record<string, any> = {}) {
        const evId = uuid();
        eventIdsForFault.push(evId);
        eventRows.push([
          evId, new Date(tsMs).toISOString(), project.id, project.provinceId, project.cityId,
          relay?.panelId ?? null, relay?.id ?? null, type, protectionFunction, sev,
          extra.breakerStatus ?? null, relay?.protocol ?? 'SYNTHETIC', message,
          JSON.stringify(extra.measurements ?? {}), rng() < 0.6, true,
        ]);
        return evId;
      }

      const t0 = faultTimestamp.getTime();

      if (isCommFault || !relay) {
        severity = pickWeighted(rng, [['HIGH', 40], ['MEDIUM', 45], ['LOW', 15]]);
        faultTypeLabel = 'Relay Communication Loss';
        tripStatus = 'NO_TRIP';
        breakerStatusAfter = 'CLOSED';
        pushEvent(t0, 'COMM_LOST', `Communication heartbeat missed for relay ${relay?.relayCode ?? 'UNKNOWN'}`, severity);
        pushEvent(t0 + 30000, 'SCADA_ALARM', 'SCADA alarm generated — relay communication timeout', severity);
        pushEvent(t0 + 45000, 'ENGINEER_NOTIFIED', 'Engineer notification sent', 'INFO');
        if (rng() < 0.5) pushEvent(t0 + randInt(rng, 60, 600) * 1000, 'COMM_RESTORED', 'Communication restored', 'INFO');
      } else {
        const fnPool = PANEL_FUNCTIONS[relay.panelType];
        protectionFunction = pick(rng, fnPool);
        severity = severityForFunction(protectionFunction);
        faultTypeLabel = FAULT_TYPE_LABEL[protectionFunction];
        tripStatus = pickWeighted(rng, [['TRIPPED', 75], ['ALARM_ONLY', 15], ['NO_TRIP', 10]]);
        currentA = protectionFunction === 'OVERCURRENT' || protectionFunction === 'SHORT_CIRCUIT'
          ? randFloat(rng, 600, 4200, 1) : randFloat(rng, 80, 450, 1);
        voltageKv = randFloat(rng, Number(relay.voltageLevel.replace(/[^\d.]/g, '')) * 0.9 || 30, Number(relay.voltageLevel.replace(/[^\d.]/g, '')) * 1.05 || 34, 2);
        freqHz = randFloat(rng, 49.85, 50.15, 3);

        pushEvent(t0, 'PROTECTION_PICKUP', `Relay ${relay.relayCode} detected abnormal ${protectionFunction === 'OVERCURRENT' ? 'current' : 'measurement'}`, severity === 'CRITICAL' ? 'HIGH' : 'MEDIUM', { measurements: { current_A: currentA, voltage_kV: voltageKv, frequency_Hz: freqHz } });
        pushEvent(t0 + 3, 'PROTECTION_PICKUP', `${FAULT_TYPE_LABEL[protectionFunction]} protection pickup (${PROTECTION_FUNCTION_ANSI[protectionFunction]})`, severity);

        if (tripStatus === 'TRIPPED') {
          breakerStatusAfter = 'OPEN';
          pushEvent(t0 + 20, 'PROTECTION_TRIP', 'Trip command issued', severity, { breakerStatus: 'OPEN' });
          pushEvent(t0 + 50, 'BREAKER_STATE_CHANGE', 'Breaker opened', severity, { breakerStatus: 'OPEN' });
          pushEvent(t0 + 120, 'BREAKER_STATE_CHANGE', 'Trip confirmed by breaker auxiliary contact', severity, { breakerStatus: 'OPEN' });
          pushEvent(t0 + 2100, 'SCADA_ALARM', 'SCADA alarm generated', severity);
          pushEvent(t0 + 14500, 'ENGINEER_NOTIFIED', 'Engineer notification sent', 'INFO');
        } else if (tripStatus === 'ALARM_ONLY') {
          breakerStatusAfter = 'CLOSED';
          pushEvent(t0 + 2000, 'SCADA_ALARM', 'SCADA alarm generated — protection pickup without trip', severity);
          pushEvent(t0 + 12000, 'ENGINEER_NOTIFIED', 'Engineer notification sent', 'INFO');
        } else {
          breakerStatusAfter = 'CLOSED';
          pushEvent(t0 + 800, 'PROTECTION_PICKUP', 'Condition cleared before trip threshold — transient, no trip', 'LOW');
        }
      }

      const ackStatus = pickWeighted(rng, [['UNACKNOWLEDGED', 25], ['ACKNOWLEDGED', 60], ['AUTO_ACKNOWLEDGED', 15]]);
      const acknowledgedBy = ackStatus === 'ACKNOWLEDGED' ? pick(rng, protEngineers).id : null;
      const rootCauseStatus = pickWeighted(rng, [['PENDING', 25], ['AI_SUGGESTED', 40], ['ENGINEER_CONFIRMED', 28], ['INCONCLUSIVE', 7]]);
      const assignedEngineer = rng() < 0.7 ? pick(rng, protEngineers) : null;
      const daysOld = (Date.now() - t0) / 86400000;
      const resolutionStatus = daysOld < 3
        ? pickWeighted(rng, [['OPEN', 55], ['INVESTIGATING', 45]])
        : pickWeighted(rng, [['OPEN', 8], ['INVESTIGATING', 14], ['RESOLVED', 60], ['CLOSED_NO_ACTION', 18]]);

      faultRows.push([
        faultId, faultCode, eventIdsForFault[0] ?? null, faultTimestamp.toISOString(), project.id, project.provinceId, project.cityId,
        relay?.panelId ?? null, relay?.id ?? null, protectionFunction, faultTypeLabel, severity, breakerStatusAfter!,
        currentA, voltageKv, freqHz, tripStatus, ackStatus, acknowledgedBy,
        acknowledgedBy ? new Date(t0 + randInt(rng, 2, 90) * 60000).toISOString() : null,
        rootCauseStatus, assignedEngineer?.id ?? null, resolutionStatus, true,
      ]);

      let seq = 1;
      for (const [idx, evId] of eventIdsForFault.entries()) {
        const evRow = eventRows.find((r) => r[0] === evId)!;
        timelineRows.push([uuid(), faultId, evRow[1], seq++, evRow[12], evId]);
      }

      faults.push({
        id: faultId, faultCode, projectId: project.id, cityId: project.cityId, provinceId: project.provinceId,
        relay, severity, timestamp: faultTimestamp, resolutionStatus, protectionFunction, eventIds: eventIdsForFault,
        faultTypeLabel, assignedEngineerId: assignedEngineer?.id ?? null, panelName: relay?.panelName ?? 'N/A',
      });

      // COMTRADE record for a subset of critical trips — synthetic waveform preview.
      if (relay && tripStatus === 'TRIPPED' && severity === 'CRITICAL' && rng() < 0.4) {
        const points = 120;
        const tripSampleIdx = Math.round(points * 0.2);
        const mkWave = (amp: number, freq: number, phaseDeg: number, faultMultiplier: number) => {
          const arr: number[] = [];
          for (let p = 0; p < points; p++) {
            const t = p / points;
            const inFault = p >= tripSampleIdx && p < tripSampleIdx + points * 0.12;
            const mag = inFault ? amp * faultMultiplier : amp;
            arr.push(Number((mag * Math.sin(2 * Math.PI * freq * t * 4 + (phaseDeg * Math.PI) / 180)).toFixed(2)));
          }
          return arr;
        };
        const tripDigital = Array.from({ length: points }, (_, p) => (p >= tripSampleIdx + points * 0.05 ? 1 : 0));
        comtradeRows.push([
          uuid(), faultId, relay.id, faultTimestamp.toISOString(), 4000, 500, 100, 400,
          JSON.stringify([
            { name: 'IA', unit: 'A', type: 'ANALOG' }, { name: 'IB', unit: 'A', type: 'ANALOG' }, { name: 'IC', unit: 'A', type: 'ANALOG' },
            { name: 'VA', unit: 'kV', type: 'ANALOG' }, { name: 'VB', unit: 'kV', type: 'ANALOG' }, { name: 'VC', unit: 'kV', type: 'ANALOG' },
            { name: 'TRIP', type: 'DIGITAL' }, { name: 'BREAKER_52A', type: 'DIGITAL' },
          ]),
          null, null,
          JSON.stringify({
            IA: mkWave(currentA ?? 400, 50, 0, 6), IB: mkWave(currentA ?? 400, 50, -120, 6), IC: mkWave(currentA ?? 400, 50, 120, 6),
            VA: mkWave(voltageKv ?? 33, 50, 0, 0.4), VB: mkWave(voltageKv ?? 33, 50, -120, 0.4), VC: mkWave(voltageKv ?? 33, 50, 120, 0.4),
            TRIP: tripDigital, BREAKER_52A: tripDigital.map((v) => 1 - v),
          }),
          true,
        ]);
      }
    }

    // Padding: standalone routine events not tied to a fault, so the total comfortably exceeds 500.
    console.log('[seed] routine (non-fault) events...');
    // Sized with margin above the spec's >=500 total-events minimum: fault-derived event counts vary
    // with the RNG's random walk (trip vs. alarm-only vs. no-trip sequences produce different event
    // counts per fault), so this padding is deliberately generous rather than tuned to a bare minimum.
    for (let i = 0; i < 260 && allRelays.length; i++) {
      const relay = pick(rng, allRelays);
      const project = projects.find((p) => p.id === relay.projectId)!;
      const ts = daysAgo(randInt(rng, 0, 90), 24);
      const type = pickWeighted(rng, [['MEASUREMENT', 40], ['BREAKER_STATE_CHANGE', 20], ['COMM_RESTORED', 10], ['SCADA_ALARM', 15], ['ENGINEER_NOTIFIED', 5], ['SETTING_GROUP_CHANGE_DETECTED', 10]] as [string, number][]);
      const messages: Record<string, string> = {
        MEASUREMENT: `Routine load reading recorded on ${relay.relayCode}`,
        BREAKER_STATE_CHANGE: `Breaker on ${relay.panelName} switched during planned maintenance`,
        COMM_RESTORED: `Communication restored for relay ${relay.relayCode}`,
        SCADA_ALARM: `SCADA informational alarm — ${relay.panelName}`,
        ENGINEER_NOTIFIED: `Shift engineer notified of routine status change on ${relay.relayCode}`,
        SETTING_GROUP_CHANGE_DETECTED: `Active setting group change detected on ${relay.relayCode}`,
      };
      eventRows.push([
        uuid(), ts.toISOString(), project.id, project.provinceId, project.cityId, relay.panelId, relay.id,
        type, null, pickWeighted(rng, [['INFO', 70], ['LOW', 20], ['MEDIUM', 10]]),
        null, relay.protocol, messages[type],
        JSON.stringify(type === 'MEASUREMENT' ? { current_A: randFloat(rng, 50, 900, 1), voltage_kV: randFloat(rng, 10, 135, 2), frequency_Hz: randFloat(rng, 49.9, 50.1, 3) } : {}),
        rng() < 0.8, true,
      ]);
    }

    await bulkInsert(client, 'events', [
      'id', 'time', 'project_id', 'province_id', 'city_id', 'panel_id', 'relay_id', 'event_type',
      'protection_function', 'severity', 'breaker_status', 'source_protocol', 'message', 'measurements',
      'acknowledged', 'is_demo_data',
    ], eventRows);
    await bulkInsert(client, 'faults', [
      'id', 'fault_code', 'event_id', 'timestamp', 'project_id', 'province_id', 'city_id', 'panel_id', 'relay_id',
      'protection_function', 'fault_type', 'severity', 'breaker_status', 'current_a', 'voltage_kv', 'frequency_hz',
      'trip_status', 'acknowledgement_status', 'acknowledged_by', 'acknowledged_at', 'root_cause_status',
      'assigned_engineer_id', 'resolution_status', 'is_demo_data',
    ], faultRows);
    await bulkInsert(client, 'fault_timeline_entries', ['id', 'fault_id', 'time', 'sequence_no', 'description', 'event_id'], timelineRows);
    await bulkInsert(client, 'comtrade_records', [
      'id', 'fault_id', 'relay_id', 'recorded_at', 'sample_rate_hz', 'duration_ms', 'pre_fault_ms', 'post_fault_ms',
      'channels', 'cfg_object_key', 'dat_object_key', 'waveform_preview', 'is_demo_data',
    ], comtradeRows);

    console.log(`[seed] ${eventRows.length} events, ${faultRows.length} faults, ${comtradeRows.length} COMTRADE records.`);

    // ---------------------------------------------------------------------------------------
    // Alarms
    // ---------------------------------------------------------------------------------------
    console.log('[seed] alarms...');
    const alarmRows: any[] = [];
    const alarmCommentRows: any[] = [];
    const correlationGroupRows: any[] = [];
    let alarmSeq = 1;

    const openCriticalFaults = faults.filter((f) => ['OPEN', 'INVESTIGATING'].includes(f.resolutionStatus) && ['CRITICAL', 'HIGH'].includes(f.severity)).slice(0, 22);
    for (const f of openCriticalFaults) {
      const priority = f.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
      const status = pickWeighted(rng, [['OPEN', 45], ['ACKNOWLEDGED', 40], ['ESCALATED', 15]] as [string, number][]);
      alarmRows.push([
        uuid(), `ALM-${f.timestamp.getFullYear()}-${pad(alarmSeq++, 5)}`, 'RELAY', f.projectId, f.relay?.id ?? null, f.id,
        priority, status, `${f.faultTypeLabel} — ${f.relay?.relayCode ?? f.panelName}`,
        `${f.faultTypeLabel} detected on ${f.panelName} (${f.relay?.relayCode ?? 'N/A'}). Fault ${f.faultCode}.`,
        null, f.assignedEngineerId, null, null,
        status !== 'OPEN' ? pick(rng, protEngineers).id : null,
        status !== 'OPEN' ? new Date(f.timestamp.getTime() + randInt(rng, 5, 200) * 60000).toISOString() : null,
        status === 'ESCALATED' ? new Date(f.timestamp.getTime() + randInt(rng, 200, 400) * 60000).toISOString() : null,
        null, true,
      ]);
    }

    // Offline-relay comm alarms, with a correlation group for a simulated gateway failure.
    const offlineRelays = allRelays.filter((r) => r.commStatus === 'OFFLINE');
    const gatewayGroup = offlineRelays.length >= 3 ? offlineRelays.slice(0, 3) : [];
    let correlationGroupId: string | null = null;
    if (gatewayGroup.length >= 3 && gatewayGroup.every((r) => r.projectId === gatewayGroup[0].projectId)) {
      correlationGroupId = uuid();
      correlationGroupRows.push([correlationGroupId, 'Site communication gateway failure suspected — multiple relays lost contact simultaneously', new Date().toISOString()]);
    }
    for (const r of offlineRelays.slice(0, 16)) {
      const grouped = gatewayGroup.includes(r) && correlationGroupId;
      alarmRows.push([
        uuid(), `ALM-${new Date().getFullYear()}-${pad(alarmSeq++, 5)}`, 'COMMUNICATION', r.projectId, r.id, null,
        'HIGH', pickWeighted(rng, [['OPEN', 60], ['ACKNOWLEDGED', 40]] as [string, number][]),
        `Relay Offline — ${r.relayCode}`, `Relay ${r.relayCode} (${r.manufacturer} ${r.model}) has not communicated recently.`,
        grouped ? correlationGroupId : null, null, null, null, null, null, null, null, true,
      ]);
    }

    // Project-level alarms for at-risk projects (assigned after health_score computed — placeholder priority MEDIUM here, refined below is not necessary).
    const atRiskProjects = projects.filter((p) => p.status !== 'COMPLETED').slice(0, 10);
    for (const p of atRiskProjects) {
      if (rng() < 0.35) continue;
      alarmRows.push([
        uuid(), `ALM-${new Date().getFullYear()}-${pad(alarmSeq++, 5)}`, 'PROJECT', p.id, null, null,
        'MEDIUM', 'OPEN', 'Project Requires Engineering Intervention', `Project ${p.code} shows elevated fault rate or schedule risk and requires engineering review.`,
        null, null, null, null, null, null, null, null, true,
      ]);
    }

    await bulkInsert(client, 'alarm_correlation_groups', ['id', 'root_cause', 'created_at'], correlationGroupRows);
    await bulkInsert(client, 'alarms', [
      'id', 'alarm_code', 'source_type', 'project_id', 'relay_id', 'fault_id', 'priority', 'status', 'title',
      'message', 'correlation_group_id', 'assigned_to', 'suppressed_by', 'suppression_reason', 'acknowledged_by',
      'acknowledged_at', 'escalated_at', 'closed_at', 'is_demo_data',
    ], alarmRows);

    // A handful of alarm comments (need alarm ids back — re-query the ones we just inserted with codes we generated).
    const { rows: insertedAlarms } = await client.query('SELECT id FROM alarms WHERE is_demo_data = true ORDER BY created_at DESC LIMIT 10');
    for (const a of insertedAlarms) {
      if (rng() < 0.6) {
        alarmCommentRows.push([uuid(), a.id, pick(rng, protEngineers).id, pick(rng, [
          'Investigating — pulling event log from the relay now.',
          'Confirmed protection operation was correct for the fault current seen.',
          'Dispatching field engineer to inspect cabling and CT wiring.',
          'Root cause appears to be a downstream contractor fault, coordinating with site.',
          'Communication restored after gateway restart; monitoring for recurrence.',
        ]), new Date().toISOString()]);
      }
    }
    await bulkInsert(client, 'alarm_comments', ['id', 'alarm_id', 'user_id', 'comment', 'created_at'], alarmCommentRows);

    console.log(`[seed] ${alarmRows.length} alarms.`);

    // ---------------------------------------------------------------------------------------
    // Work Orders
    // ---------------------------------------------------------------------------------------
    console.log('[seed] work orders...');
    const workOrderRows: any[] = [];
    const woStatusHistoryRows: any[] = [];
    const woCandidates = faults.filter((f) => ['CRITICAL', 'HIGH'].includes(f.severity)).slice(0, 24);
    let woSeq = 1;

    const workOrderIdByFault: Record<string, string> = {};
    for (const f of woCandidates) {
      const woId = uuid();
      workOrderIdByFault[f.id] = woId;
      const woCode = `WO-${f.timestamp.getFullYear()}-${pad(woSeq++, 5)}`;
      let status: string;
      if (f.resolutionStatus === 'RESOLVED') status = pickWeighted(rng, [['VERIFIED', 40], ['CLOSED', 60]] as [string, number][]);
      else if (f.resolutionStatus === 'CLOSED_NO_ACTION') status = 'CLOSED';
      else status = pickWeighted(rng, [['ASSIGNED', 25], ['FIELD_INSPECTION', 30], ['REPAIR', 25], ['TEST', 20]] as [string, number][]);
      const priority = f.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
      const engineer = pick(rng, fieldEngineers);
      const created = new Date(f.timestamp.getTime() + randInt(rng, 30, 300) * 60000);
      const due = new Date(created.getTime() + randInt(rng, 2, 10) * 86400000);
      const closed = ['CLOSED'].includes(status) ? new Date(due.getTime() - randInt(rng, 0, 3) * 86400000) : null;
      workOrderRows.push([
        woId, woCode, f.id, f.projectId, f.cityId,
        `${f.panelName} — ${f.relay ? `${f.relay.manufacturer} ${f.relay.model}` : 'Panel'}`,
        `${f.faultTypeLabel} on ${f.panelName} (fault ${f.faultCode}) — inspect and verify protection operation.`,
        priority, engineer.id, due.toISOString().slice(0, 10), status,
        'Auto-generated from fault analysis workflow.',
        ['CLOSED', 'VERIFIED'].includes(status) ? 'Inspection completed, protection operation confirmed correct, equipment returned to service.' : null,
        true, closed ? closed.toISOString() : null,
      ]);

      const progression = ['OPEN', 'ANALYSIS', 'ASSIGNED', 'FIELD_INSPECTION', 'REPAIR', 'TEST', 'VERIFIED', 'CLOSED'];
      const finalIdx = progression.indexOf(status);
      let stepTime = created.getTime();
      for (let s = 0; s <= finalIdx; s++) {
        stepTime += randInt(rng, 30, 400) * 60000;
        woStatusHistoryRows.push([uuid(), woId, s === 0 ? null : progression[s - 1], progression[s], engineer.id, new Date(stepTime).toISOString(), null]);
      }
    }
    await bulkInsert(client, 'work_orders', [
      'id', 'work_order_code', 'fault_id', 'project_id', 'city_id', 'equipment_description', 'problem',
      'priority', 'assigned_engineer_id', 'due_date', 'status', 'notes', 'resolution', 'is_demo_data', 'closed_at',
    ], workOrderRows);
    await bulkInsert(client, 'work_order_status_history', ['id', 'work_order_id', 'from_status', 'to_status', 'changed_by', 'changed_at', 'note'], woStatusHistoryRows);
    console.log(`[seed] ${workOrderRows.length} work orders.`);

    // ---------------------------------------------------------------------------------------
    // AI analyses + approvals
    // ---------------------------------------------------------------------------------------
    console.log('[seed] AI analyses...');
    const aiAnalysisRows: any[] = [];
    const aiApprovalRows: any[] = [];
    const aiCandidates = faults.filter((f) => ['CRITICAL', 'HIGH'].includes(f.severity)).slice(0, 28);
    const aiAnalysisIdByFault: Record<string, string> = {};

    for (const f of aiCandidates) {
      const confidence = randInt(rng, 68, 97);
      const aiId = uuid();
      aiAnalysisIdByFault[f.id] = aiId;
      // The signal that distinguishes "genuine protection operation" from "communication/network issue"
      // is whether a protection function actually operated (f.protectionFunction), NOT whether a relay
      // happens to be attached to the fault — a communication-loss fault still references the relay
      // that went quiet. Branching on f.relay alone previously told engineers a comms-lost fault was a
      // confirmed protection trip. Keep this in sync with the equivalent fix in
      // apps/api/src/services/simorghAi.ts (generateOrFetchRootCauseAnalysis).
      const isProtectionOperation = Boolean(f.protectionFunction);
      const evidence = isProtectionOperation
        ? [
            `${f.faultTypeLabel} pickup recorded on relay ${f.relay!.relayCode} (${f.relay!.manufacturer} ${f.relay!.model})`,
            `Protection function ${f.protectionFunction} (ANSI ${PROTECTION_FUNCTION_ANSI[f.protectionFunction!]}) operated as configured`,
            'Trip sequence timing consistent with a genuine primary protection operation, not a spurious signal',
            'Breaker auxiliary contact feedback confirms open state following the trip command',
          ]
        : ['Communication heartbeat missed beyond the configured supervision timeout', 'No corresponding protection pickup recorded before the loss of communication', 'Pattern consistent with a network/gateway issue rather than a primary electrical fault'];
      const probableCause = isProtectionOperation
        ? `${f.faultTypeLabel} on ${f.panelName}, most likely a genuine electrical fault given the pickup-to-trip sequence and measured fault current.`
        : `Communication path to ${f.relay ? f.relay.relayCode : 'the relay'} interrupted, likely a network/gateway issue rather than a protection event.`;
      const recommendedAction = isProtectionOperation
        ? `Dispatch a protection engineer to review the event record and inspect the ${f.panelName.toLowerCase()} load and downstream cabling before re-energizing.`
        : `Verify the industrial gateway and network path to the site; if communication does not restore automatically, dispatch field service to check the local RTU/gateway.`;
      aiAnalysisRows.push([
        aiId, f.id, f.eventIds[0] ?? null,
        `${f.faultTypeLabel} on ${f.panelName} (${f.faultCode}). ${isProtectionOperation ? `Confidence ${confidence}% that this is a genuine protection operation.` : `Likely a communication/network issue, not an electrical fault.`}`,
        probableCause, confidence, JSON.stringify(evidence), JSON.stringify(f.eventIds),
        recommendedAction, isProtectionOperation ? 'PROTECTION_ENGINEER' : 'FIELD_SERVICE_ENGINEER',
        f.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH', 'simorgh-rules-v1',
      ]);
    }
    await bulkInsert(client, 'ai_analyses', [
      'id', 'fault_id', 'event_id', 'summary', 'probable_cause', 'confidence_score', 'evidence',
      'related_event_ids', 'recommended_action', 'required_engineer_role', 'priority', 'model_version',
    ], aiAnalysisRows);

    for (const f of aiCandidates) {
      const woId = workOrderIdByFault[f.id];
      const aiId = aiAnalysisIdByFault[f.id];
      if (woId && aiId && rng() < 0.6) {
        aiApprovalRows.push([uuid(), aiId, 'APPROVED', pick(rng, [...byRole('TECHNICAL_MANAGER'), ...byRole('PROJECT_MANAGER')]).id, new Date().toISOString(), woId, 'Approved — proceed with field inspection and work order as recommended.']);
      }
    }
    await bulkInsert(client, 'ai_recommendation_approvals', ['id', 'ai_analysis_id', 'decision', 'approved_by', 'approved_at', 'resulting_work_order_id', 'notes'], aiApprovalRows);
    console.log(`[seed] ${aiAnalysisRows.length} AI analyses, ${aiApprovalRows.length} approvals.`);

    // ---------------------------------------------------------------------------------------
    // Notifications + audit log
    // ---------------------------------------------------------------------------------------
    console.log('[seed] notifications + audit log...');
    const notificationRows: any[] = [];
    for (const f of faults.filter((f) => f.severity === 'CRITICAL').slice(0, 16)) {
      const targetUser = f.assignedEngineerId ? users.find((u) => u.id === f.assignedEngineerId) : pick(rng, protEngineers);
      if (!targetUser) continue;
      notificationRows.push([
        uuid(), targetUser.id, pickWeighted(rng, [['DASHBOARD', 70], ['EMAIL', 25], ['SMS', 5]] as [string, number][]),
        `Critical fault: ${f.faultTypeLabel}`, `${f.faultCode} — ${f.faultTypeLabel} on ${f.panelName}. Immediate review recommended.`,
        pickWeighted(rng, [['SENT', 60], ['READ', 40]] as [string, number][]), 'FAULT', f.id,
        f.timestamp.toISOString(), new Date(f.timestamp.getTime() + 60000).toISOString(), null,
      ]);
    }
    await bulkInsert(client, 'notifications', ['id', 'user_id', 'channel', 'title', 'body', 'status', 'related_entity_type', 'related_entity_id', 'created_at', 'sent_at', 'read_at'], notificationRows);

    const auditRows: any[] = [];
    for (let i = 0; i < 25; i++) {
      const u = pick(rng, users);
      auditRows.push([daysAgo(randInt(rng, 0, 60)).toISOString(), u.id, 'LOGIN', 'USER', u.id, JSON.stringify({ method: 'password' }), null]);
    }
    for (const f of faults.filter((f) => f.resolutionStatus !== 'OPEN').slice(0, 20)) {
      auditRows.push([f.timestamp.toISOString(), f.assignedEngineerId ?? admin.id, 'FAULT_ASSIGN', 'FAULT', f.id, JSON.stringify({ faultCode: f.faultCode }), null]);
    }
    for (const row of aiApprovalRows) {
      auditRows.push([new Date().toISOString(), row[3], 'HUMAN_APPROVAL', 'AI_ANALYSIS', row[1], JSON.stringify({ decision: row[2] }), null]);
    }
    await bulkInsert(client, 'audit_log', ['time', 'user_id', 'action', 'entity_type', 'entity_id', 'details', 'ip_address'], auditRows);
    console.log(`[seed] ${notificationRows.length} notifications, ${auditRows.length} audit log entries.`);

    // ---------------------------------------------------------------------------------------
    // Restricted precise-location demo rows (never surfaced by the general API — see docs/ARCHITECTURE.md §9)
    // ---------------------------------------------------------------------------------------
    const { rows: substationsForLocation } = await client.query('SELECT id, name FROM substations WHERE is_demo_data = true');
    const restrictedRows = substationsForLocation.map((s) => [
      uuid(), s.id, `Industrial zone access road, plot ${randInt(rng, 1, 400)} (synthetic demo address)`,
      randFloat(rng, 25.5, 38.5, 6), randFloat(rng, 44.5, 61.0, 6),
      'Demo data — synthetic coordinates, not a real site location.',
    ]);
    await bulkInsert(client, 'site_location_restricted', ['id', 'substation_id', 'address', 'latitude', 'longitude', 'access_notes'], restrictedRows);

    // ---------------------------------------------------------------------------------------
    // Post-processing: derive relay counts, project health scores, and risk flags from the data
    // we just generated, using set-based SQL rather than re-deriving everything in JS.
    // ---------------------------------------------------------------------------------------
    console.log('[seed] post-processing aggregates...');
    await client.query(`
      UPDATE relays r SET
        trip_count = COALESCE((SELECT COUNT(*) FROM faults f WHERE f.relay_id = r.id AND f.trip_status = 'TRIPPED'), 0),
        alarm_count = COALESCE((SELECT COUNT(*) FROM alarms a WHERE a.relay_id = r.id AND a.status <> 'CLOSED'), 0),
        last_trip_at = (SELECT MAX(f."timestamp") FROM faults f WHERE f.relay_id = r.id AND f.trip_status = 'TRIPPED'),
        last_event_at = (SELECT MAX(e."time") FROM events e WHERE e.relay_id = r.id)
    `);
    await client.query(`
      UPDATE relays SET health_status = 'CRITICAL', health_score = LEAST(health_score, 32)
      WHERE id IN (
        SELECT DISTINCT relay_id FROM faults
        WHERE severity = 'CRITICAL' AND resolution_status IN ('OPEN','INVESTIGATING') AND relay_id IS NOT NULL
      ) AND health_status <> 'OFFLINE'
    `);
    await client.query(`
      UPDATE projects p SET health_score = GREATEST(5, LEAST(100, base.score))
      FROM (
        SELECT p2.id,
          (COALESCE((SELECT AVG(r.health_score)::int FROM relays r
                       JOIN panels pnl ON pnl.id = r.panel_id
                       JOIN switchgear sg ON sg.id = pnl.switchgear_id
                       JOIN substations s ON s.id = sg.substation_id
                       WHERE s.project_id = p2.id), 88)
           - (SELECT COUNT(*) FROM faults f WHERE f.project_id = p2.id AND f.severity = 'CRITICAL' AND f.resolution_status IN ('OPEN','INVESTIGATING')) * 10
           - (SELECT COUNT(*) FROM faults f WHERE f.project_id = p2.id AND f.severity = 'HIGH' AND f.resolution_status IN ('OPEN','INVESTIGATING')) * 4
          ) AS score
        FROM projects p2
      ) base
      WHERE p.id = base.id
    `);
    await client.query(`
      UPDATE projects SET requires_engineering_intervention = true
      WHERE id IN (SELECT DISTINCT project_id FROM faults WHERE resolution_status IN ('OPEN','INVESTIGATING') AND severity IN ('CRITICAL','HIGH'))
    `);
    await client.query(`
      UPDATE projects SET requires_field_service = true
      WHERE id IN (SELECT DISTINCT project_id FROM work_orders WHERE status IN ('ASSIGNED','FIELD_INSPECTION','REPAIR'))
    `);
    await client.query(`
      INSERT INTO project_health_scores (project_id, overall, technical, communication, protection, progress, risk_level)
      SELECT id, health_score,
        LEAST(100, GREATEST(0, health_score + (random()*10 - 3)::int)),
        GREATEST(0, LEAST(100, health_score - (random()*12)::int)),
        LEAST(100, GREATEST(0, health_score + (random()*6 - 2)::int)),
        overall_progress,
        CASE WHEN health_score >= 80 THEN 'LOW' WHEN health_score >= 55 THEN 'MEDIUM' ELSE 'HIGH' END
      FROM projects WHERE health_score IS NOT NULL
    `);

    console.log('[seed] done. Summary:');
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(DISTINCT city_id) FROM projects) AS cities,
        (SELECT COUNT(*) FROM relays) AS relays,
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM faults) AS faults,
        (SELECT COUNT(*) FROM alarms WHERE status <> 'CLOSED') AS active_alarms,
        (SELECT COUNT(*) FROM work_orders) AS work_orders
    `);
    console.table(counts.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
