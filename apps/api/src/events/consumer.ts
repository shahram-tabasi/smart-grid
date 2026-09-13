import { pool } from '../db/pool';
import {
  UnifiedEvent,
  EventEnvelope,
  KAFKA_TOPICS,
  CONSUMER_GROUPS,
  TIME_SYNC_TRUST_RANK,
} from '@simorgh/shared';

/**
 * Event ingestion and processing.
 *
 * Accepts normalised events from gateways over either transport (Kafka consumer, or the HTTP
 * ingest endpoint) and funnels both into one processing path, so there is exactly one place where
 * an event becomes a database row.
 *
 * Two properties matter here and are handled explicitly:
 *
 *  1. IDEMPOTENCE. A gateway that retries after a network wobble will re-send events it already
 *     delivered. Events are upserted on eventId, so a retry cannot create a duplicate trip.
 *
 *  2. LOCATION PRIVACY. The envelope carries provinceId/cityId and nothing finer, and
 *     sanitiseEvent() below strips any coordinate-shaped field that somehow appears in a payload
 *     before it reaches the database. This is a belt-and-braces check: the schema has no column
 *     for it either, but an ingest boundary is exactly where an untrusted producer should be
 *     validated rather than trusted.
 */

export interface ProcessResult {
  accepted: number;
  duplicates: number;
  rejected: Array<{ eventId?: string; reason: string }>;
}

/** Fields that must never arrive from a gateway. Present as a guard, not because we expect them. */
const FORBIDDEN_LOCATION_FIELDS = [
  'latitude',
  'longitude',
  'lat',
  'lon',
  'lng',
  'coordinates',
  'gps',
  'address',
  'streetAddress',
  'postalCode',
];

function sanitiseEvent(raw: any): { event: UnifiedEvent | null; reason?: string } {
  if (!raw || typeof raw !== 'object') return { event: null, reason: 'payload is not an object' };
  if (!raw.eventId || !raw.eventType || !raw.timestamp) {
    return { event: null, reason: 'missing eventId, eventType or timestamp' };
  }

  // Reject rather than silently strip: a gateway sending coordinates is a misconfiguration that
  // someone needs to know about, and quietly accepting it would hide a privacy regression.
  for (const field of FORBIDDEN_LOCATION_FIELDS) {
    if (field in raw) {
      return { event: null, reason: `payload contains forbidden location field "${field}"` };
    }
    if (raw.measurements && field in raw.measurements) {
      return { event: null, reason: `measurements contain forbidden location field "${field}"` };
    }
  }

  const ts = new Date(raw.timestamp);
  if (Number.isNaN(ts.getTime())) return { event: null, reason: 'timestamp is not a valid date' };

  // A timestamp far in the future usually means a relay clock is wrong; accepting it would corrupt
  // the ordering of every fault timeline it appears in.
  if (ts.getTime() > Date.now() + 5 * 60 * 1000) {
    return { event: null, reason: 'timestamp is more than 5 minutes in the future (check relay clock)' };
  }

  return { event: raw as UnifiedEvent };
}

/**
 * Resolve the equipment hierarchy for an event. Gateways know their relay but not our internal
 * project/city ids, so the backend fills those in from the relay registration.
 */
async function resolveContext(relayId?: string) {
  if (!relayId) return null;
  const { rows } = await pool.query(
    `SELECT r.id AS relay_id, r.panel_id, p.id AS project_id, p.province_id, p.city_id
     FROM relays r
     JOIN panels pnl ON pnl.id = r.panel_id
     JOIN switchgear sg ON sg.id = pnl.switchgear_id
     JOIN substations sub ON sub.id = sg.substation_id
     JOIN projects p ON p.id = sub.project_id
     WHERE r.id::text = $1 OR r.relay_code = $1`,
    [relayId]
  );
  return rows[0] ?? null;
}

const SEVERITY_TO_ALARM_PRIORITY: Record<string, string> = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
};

export async function processEnvelopes(envelopes: Array<EventEnvelope<UnifiedEvent>>): Promise<ProcessResult> {
  const result: ProcessResult = { accepted: 0, duplicates: 0, rejected: [] };

  for (const env of envelopes) {
    const { event, reason } = sanitiseEvent(env?.payload);
    if (!event) {
      result.rejected.push({ eventId: env?.payload?.eventId, reason: reason ?? 'unknown' });
      await writeDeadLetter(env, reason ?? 'unknown');
      continue;
    }

    try {
      const ctx = await resolveContext(event.relayId);
      const projectId = ctx?.project_id ?? (event.projectId || null);
      const provinceId = ctx?.province_id ?? (env.siteRef?.provinceId || event.provinceId || null);
      const cityId = ctx?.city_id ?? (env.siteRef?.cityId || event.cityId || null);

      if (!projectId || !provinceId || !cityId) {
        result.rejected.push({
          eventId: event.eventId,
          reason: `cannot resolve project/province/city for relay ${event.relayId ?? '(none)'} — is the relay registered?`,
        });
        await writeDeadLetter(env, 'unresolved equipment context');
        continue;
      }

      // Upsert on (gateway_event_id, time) makes redelivery safe. The index is partial and includes
      // "time" so it is valid whether or not events is a TimescaleDB hypertable — see migration 014.
      const { rowCount } = await pool.query(
        `INSERT INTO events (
           gateway_event_id, "time", project_id, province_id, city_id, panel_id, relay_id,
           event_type, protection_function, severity, breaker_status, source_protocol,
           message, measurements, is_demo_data, time_sync_quality, source_path_id, source_reference
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (gateway_event_id, "time") WHERE gateway_event_id IS NOT NULL DO NOTHING`,
        [
          event.eventId,
          event.timestamp,
          projectId,
          provinceId,
          cityId,
          ctx?.panel_id ?? event.panelId ?? null,
          ctx?.relay_id ?? null,
          event.eventType,
          event.protectionFunction ?? null,
          event.severity,
          event.breakerStatus ?? null,
          event.sourceProtocol,
          event.message,
          JSON.stringify(event.measurements ?? {}),
          event.synthetic === true,
          event.timeSyncQuality ?? 'UNKNOWN',
          event.sourcePathId ?? null,
          event.sourceReference ?? null,
        ]
      );

      if (rowCount === 0) {
        result.duplicates += 1;
        continue;
      }
      result.accepted += 1;

      await applySideEffects(event, { projectId, provinceId, cityId, relayId: ctx?.relay_id ?? null });
    } catch (err) {
      result.rejected.push({ eventId: event.eventId, reason: (err as Error).message });
      await writeDeadLetter(env, (err as Error).message);
    }
  }

  return result;
}

/**
 * Derived state: relay comm status, alarms, and the disturbance-record fetch queue.
 * Everything here is a monitoring-side write. Nothing in this function can reach a relay.
 */
async function applySideEffects(
  event: UnifiedEvent,
  ctx: { projectId: string; provinceId: string; cityId: string; relayId: string | null }
) {
  if (!ctx.relayId) return;

  if (event.eventType === 'COMM_LOST') {
    await pool.query(
      `UPDATE relays SET comm_status = 'OFFLINE', health_status = 'OFFLINE', updated_at = now() WHERE id = $1`,
      [ctx.relayId]
    );
  } else if (event.eventType === 'COMM_RESTORED') {
    await pool.query(
      `UPDATE relays SET comm_status = 'ONLINE', updated_at = now() WHERE id = $1`,
      [ctx.relayId]
    );
  } else {
    // Any event at all is proof of life.
    await pool.query(
      `UPDATE relays SET last_communication_at = now(), comm_status =
         CASE WHEN comm_status = 'OFFLINE' THEN 'ONLINE' ELSE comm_status END,
         updated_at = now()
       WHERE id = $1`,
      [ctx.relayId]
    );
  }

  if (event.eventType === 'PROTECTION_TRIP') {
    await pool.query(
      `UPDATE relays SET trip_count = trip_count + 1, last_trip_at = $2, updated_at = now() WHERE id = $1`,
      [ctx.relayId, event.timestamp]
    );
  }

  if (event.eventType === 'SETTING_GROUP_CHANGE_DETECTED' || /setting change/i.test(event.message)) {
    // A protection setting change is security-relevant and always audited, whether or not it was
    // made through this platform (it usually was not — someone changed it on the relay).
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'RELAY_SETTING_CHANGE_OBSERVED', 'RELAY', $1, $2)`,
      [ctx.relayId, JSON.stringify({ message: event.message, sourceProtocol: event.sourceProtocol })]
    );
  }

  // Raise an alarm for anything an operator must see.
  const alarmWorthy = ['PROTECTION_TRIP', 'COMM_LOST', 'DEVICE_SELF_TEST_FAILED', 'TIME_SYNC_DEGRADED', 'GOOSE_SEQUENCE_ANOMALY'];
  if (alarmWorthy.includes(event.eventType) && ['CRITICAL', 'HIGH'].includes(event.severity)) {
    // alarm_code is derived from the gateway event id so a redelivered event cannot raise a second
    // alarm for the same occurrence.
    const alarmCode = `ALM-${event.eventId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24).toUpperCase()}`;
    await pool.query(
      `INSERT INTO alarms (alarm_code, source_type, project_id, relay_id, priority, status, title, message, is_demo_data)
       VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7,$8)
       ON CONFLICT (alarm_code) DO NOTHING`,
      [
        alarmCode,
        event.eventType === 'COMM_LOST' ? 'COMMUNICATION' : event.eventType === 'PROTECTION_TRIP' ? 'PROTECTION' : 'DEVICE',
        ctx.projectId,
        ctx.relayId,
        SEVERITY_TO_ALARM_PRIORITY[event.severity] ?? 'MEDIUM',
        event.eventType.replace(/_/g, ' '),
        event.message,
        event.synthetic === true,
      ]
    );
  }

  if (event.eventType === 'DISTURBANCE_RECORD_AVAILABLE') {
    await pool.query(
      `INSERT INTO disturbance_fetch_queue (relay_id, remote_id, source_protocol, requested_at, status)
       VALUES ($1,$2,$3, now(), 'PENDING')
       ON CONFLICT (relay_id, remote_id) DO NOTHING`,
      [ctx.relayId, event.sourceReference ?? event.eventId, event.sourceProtocol]
    );
  }
}

async function writeDeadLetter(env: any, reason: string) {
  try {
    await pool.query(
      `INSERT INTO event_dead_letter (gateway_id, reason, raw_payload) VALUES ($1,$2,$3)`,
      [env?.gatewayId ?? 'unknown', reason, JSON.stringify(env ?? {})]
    );
  } catch {
    // Dead-lettering must never itself throw and take down ingestion.
  }
}

/**
 * Kafka consumer. Started only when EVENT_BUS=kafka; otherwise the HTTP ingest route is the only
 * entry point and this stays dormant.
 */
export async function startKafkaConsumer(): Promise<{ stop: () => Promise<void> } | null> {
  if ((process.env.EVENT_BUS ?? 'direct').toLowerCase() !== 'kafka') return null;

  let kafkajs: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    kafkajs = require('kafkajs');
  } catch {
    console.warn('[consumer] kafkajs not installed; Kafka ingestion disabled');
    return null;
  }

  const kafka = new kafkajs.Kafka({
    clientId: 'simorgh-api',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((b: string) => b.trim()),
    ssl: process.env.KAFKA_SSL === 'true',
  });
  const consumer = kafka.consumer({ groupId: CONSUMER_GROUPS.EVENT_PROCESSOR });

  try {
    await consumer.connect();
    await consumer.subscribe({ topic: KAFKA_TOPICS.EVENTS_RAW, fromBeginning: false });
    await consumer.subscribe({ topic: KAFKA_TOPICS.DISTURBANCE_RECORDS, fromBeginning: false });
  } catch (err) {
    console.error(`[consumer] kafka subscribe failed: ${(err as Error).message}`);
    return null;
  }

  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }: any) => {
      const envelopes: Array<EventEnvelope<UnifiedEvent>> = [];
      const offsets: string[] = [];
      for (const message of batch.messages) {
        if (!isRunning() || isStale()) break;
        try {
          envelopes.push(JSON.parse(message.value.toString('utf8')));
          offsets.push(message.offset);
        } catch {
          await writeDeadLetter({ gatewayId: 'unknown' }, 'unparseable Kafka message');
          resolveOffset(message.offset);
        }
      }
      if (envelopes.length) {
        const res = await processEnvelopes(envelopes);
        if (res.rejected.length) {
          console.warn(`[consumer] ${res.rejected.length} event(s) rejected in batch`);
        }
      }
      // Only commit offsets after the batch is durably written — otherwise a crash mid-batch
      // silently loses events.
      offsets.forEach((o) => resolveOffset(o));
      await heartbeat();
    },
  });

  console.log('[consumer] Kafka event consumer running');
  return {
    stop: async () => {
      try {
        await consumer.disconnect();
      } catch {
        /* already down */
      }
    },
  };
}

/** Ranking helper used by the fault-timeline assembler to order mixed-quality timestamps. */
export function timestampTrust(event: UnifiedEvent): number {
  return TIME_SYNC_TRUST_RANK[event.timeSyncQuality ?? 'UNKNOWN'];
}
