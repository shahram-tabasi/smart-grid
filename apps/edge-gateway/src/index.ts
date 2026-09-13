import 'dotenv/config';
import { RelayCommProfile, PROTOCOL_CATALOGUE, SourceProtocolV2 } from '@simorgh/shared';
import { DriverRegistry } from './protocols/registry';
import { ConnectionSupervisor } from './supervisor';
import { createEventPublisher, GATEWAY_ID } from './publisher';

/**
 * Simorgh Edge Gateway.
 *
 * In a real deployment this process runs at (or near) a site, speaks to IEDs over OT-side
 * protocols, normalises everything into the Unified Event Model, and forwards it OUTBOUND ONLY
 * (mTLS) to the cloud ingestion service — see docs/ARCHITECTURE.md §3 and §6. It never accepts
 * inbound connections from the cloud, which is what keeps the protection network unreachable from
 * the internet.
 *
 * Phase 2 adds the full protocol driver set, redundant-path supervision with failover, and a real
 * event-bus publisher (Kafka/Redpanda, or direct HTTP for small sites).
 *
 * Run it with SIMULATE=true (the default) to see normalised UnifiedEvents on stdout without any
 * hardware. Point it at real devices by supplying a site configuration file.
 */

function demoProfiles(): RelayCommProfile[] {
  // A demonstration site showing the redundancy model: each relay has a fast primary, a slower
  // backup on a different protocol, and auxiliary channels for files, health and time.
  return [
    {
      relayId: 'DEMO-RELAY-01',
      relayCode: 'THR-F01',
      manufacturer: 'Siemens',
      model: 'SIPROTEC 5 7SJ82',
      pointMapProfileId: 'siemens-siprotec-generic',
      paths: [
        {
          pathId: 'thr-f01-goose',
          protocol: 'IEC61850_GOOSE',
          role: 'PRIMARY',
          addressing: { networkInterface: 'eth0', gooseControlBlock: 'THR-F01/LLN0.gcbTrip' },
          supervisionTimeoutSec: 10,
          enabled: true,
        },
        {
          pathId: 'thr-f01-mms',
          protocol: 'IEC61850_MMS',
          role: 'PRIMARY',
          host: '10.20.30.11',
          port: 102,
          addressing: { logicalDevice: 'THR-F01', reportControlBlock: 'THR-F01/LLN0.BR.brcbEvents01' },
          pollIntervalMs: 15000,
          supervisionTimeoutSec: 60,
          enabled: true,
        },
        {
          pathId: 'thr-f01-103',
          protocol: 'IEC60870_5_103',
          role: 'BACKUP',
          serial: { devicePath: '/dev/ttyS0', baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1, linkAddress: 1 },
          pollIntervalMs: 5000,
          supervisionTimeoutSec: 30,
          enabled: true,
        },
        {
          pathId: 'thr-f01-sftp',
          protocol: 'SFTP',
          role: 'AUXILIARY',
          host: '10.20.30.11',
          port: 22,
          addressing: { comtradeDirectory: '/COMTRADE', username: 'relay' },
          supervisionTimeoutSec: 300,
          enabled: true,
        },
        {
          pathId: 'thr-f01-syslog',
          protocol: 'SYSLOG',
          role: 'AUXILIARY',
          host: '10.20.30.11',
          port: 514,
          supervisionTimeoutSec: 3600,
          enabled: true,
        },
        {
          pathId: 'site-ntp',
          protocol: 'NTP',
          role: 'AUXILIARY',
          host: '10.20.30.1',
          port: 123,
          pollIntervalMs: 60000,
          supervisionTimeoutSec: 300,
          enabled: true,
        },
      ],
    },
    {
      relayId: 'DEMO-RELAY-02',
      relayCode: 'THR-F02',
      manufacturer: 'SEL',
      model: 'SEL-751',
      pointMapProfileId: 'sel-generic',
      paths: [
        {
          pathId: 'thr-f02-dnp3',
          protocol: 'DNP3_TCP',
          role: 'PRIMARY',
          host: '10.20.30.12',
          port: 20000,
          addressing: { masterAddress: 1, outstationAddress: 12 },
          pollIntervalMs: 30000,
          supervisionTimeoutSec: 90,
          enabled: true,
        },
        {
          pathId: 'thr-f02-sel',
          protocol: 'SEL_ASCII',
          role: 'BACKUP',
          host: '10.20.30.12',
          port: 23,
          pollIntervalMs: 10000,
          supervisionTimeoutSec: 60,
          enabled: true,
        },
        {
          pathId: 'thr-f02-snmp',
          protocol: 'SNMP',
          role: 'AUXILIARY',
          host: '10.20.30.2',
          port: 161,
          addressing: { version: '3', securityName: 'simorgh' },
          pollIntervalMs: 30000,
          supervisionTimeoutSec: 300,
          enabled: true,
        },
      ],
    },
    {
      relayId: 'DEMO-RELAY-03',
      relayCode: 'THR-M01',
      manufacturer: 'Schneider Electric',
      model: 'MiCOM P123',
      pointMapProfileId: 'schneider-micom-generic',
      paths: [
        {
          pathId: 'thr-m01-modbus',
          protocol: 'MODBUS_TCP',
          role: 'PRIMARY',
          host: '10.20.30.13',
          port: 502,
          addressing: { unitId: 1 },
          pollIntervalMs: 5000,
          supervisionTimeoutSec: 30,
          enabled: true,
        },
      ],
    },
  ];
}

/**
 * Field mode: load the real relay/comm-path configuration from the backend instead of the
 * hardcoded demo profiles. This is the same INGEST_URL/INGEST_TOKEN/GATEWAY_ID the event
 * publisher already uses (see publisher.ts) — the config endpoint lives one path segment over,
 * at .../api/ingest/config rather than .../api/ingest/events.
 */
async function loadFieldProfiles(): Promise<RelayCommProfile[]> {
  const ingestUrl = process.env.INGEST_URL;
  if (!ingestUrl) {
    console.error('[edge-gateway] INGEST_URL is not set; cannot load relay configuration in field mode');
    return [];
  }
  const configUrl = new URL('config', ingestUrl);
  try {
    const response = await fetch(configUrl, {
      headers: {
        'X-Gateway-Id': GATEWAY_ID,
        ...(process.env.INGEST_TOKEN ? { Authorization: `Bearer ${process.env.INGEST_TOKEN}` } : {}),
      },
    });
    if (!response.ok) {
      console.error(`[edge-gateway] failed to load relay configuration: HTTP ${response.status} from ${configUrl}`);
      return [];
    }
    const body = (await response.json()) as { relays: RelayCommProfile[] };
    console.log(`[edge-gateway] loaded ${body.relays.length} relay(s) from ${configUrl}`);
    return body.relays;
  } catch (err) {
    console.error(`[edge-gateway] failed to load relay configuration: ${(err as Error).message}`);
    return [];
  }
}

/** Reports path diagnostics back so the platform's "Relay comms health" view reflects reality. */
async function reportHeartbeat(ingestUrl: string, diagnostics: ReturnType<ConnectionSupervisor['allDiagnostics']>) {
  const heartbeatUrl = new URL('heartbeat', ingestUrl);
  try {
    const response = await fetch(heartbeatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Id': GATEWAY_ID,
        ...(process.env.INGEST_TOKEN ? { Authorization: `Bearer ${process.env.INGEST_TOKEN}` } : {}),
      },
      body: JSON.stringify({ diagnostics }),
    });
    if (!response.ok) {
      console.warn(`[edge-gateway] heartbeat rejected: HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`[edge-gateway] heartbeat failed: ${(err as Error).message}`);
  }
}

async function main() {
  const simulate = process.env.SIMULATE !== 'false';
  const registry = new DriverRegistry({ simulate });
  const supervisor = new ConnectionSupervisor({ registry });
  const publisher = await createEventPublisher();

  console.log(
    `[edge-gateway] starting in ${simulate ? 'SIMULATOR' : 'FIELD'} mode; publishing via ${publisher.kind}`
  );
  console.log(`[edge-gateway] ${Object.keys(PROTOCOL_CATALOGUE).length} protocols available in the catalogue`);

  supervisor.on('event', (event) => {
    void publisher.publish(event);
    console.log(
      `[edge-gateway] ${event.eventType} ${event.severity} via ${event.sourceProtocol} ` +
        `(clock: ${event.timeSyncQuality}) — ${event.message}`
    );
  });

  supervisor.on('pathChanged', (change) => {
    console.warn(
      `[edge-gateway] path change for ${change.relayCode}: ${change.from ?? 'none'} -> ${change.to ?? 'none'} (${change.reason})`
    );
  });

  const profiles = simulate ? demoProfiles() : await loadFieldProfiles();
  for (const profile of profiles) {
    const problems = await supervisor.addRelay(profile);
    for (const p of problems) console.warn(`[edge-gateway] config check (${profile.relayCode}): ${p}`);
  }

  supervisor.start();

  const ingestUrl = process.env.INGEST_URL;
  const heartbeatTimer = ingestUrl
    ? setInterval(() => void reportHeartbeat(ingestUrl, supervisor.allDiagnostics()), 15000)
    : undefined;

  const shutdown = async () => {
    console.log('[edge-gateway] shutting down...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    supervisor.stop();
    for (const profile of profiles) await supervisor.removeRelay(profile.relayId);
    await publisher.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[edge-gateway] running. Press Ctrl+C to stop.');
}

/** Printed by `npm run protocols` — the catalogue as an operator-readable table. */
export function printProtocolCatalogue() {
  const rows = Object.values(PROTOCOL_CATALOGUE).map((d) => ({
    protocol: d.protocol as SourceProtocolV2,
    name: d.displayName,
    family: d.family,
    transport: d.transport,
    delivery: d.deliveryMode,
    impl: d.implementation,
    faultRecords: d.capabilities.faultRecords ? 'yes' : 'no',
    files: d.capabilities.disturbanceFiles ? 'yes' : 'no',
    clock: d.capabilities.bestTimeSyncQuality,
  }));
  console.table(rows);
}

if (process.argv.includes('--catalogue')) {
  printProtocolCatalogue();
} else {
  main().catch((err) => {
    console.error('[edge-gateway] fatal error', err);
    process.exit(1);
  });
}
