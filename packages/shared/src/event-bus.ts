/**
 * Event bus topic design and message envelope, shared by the edge gateway (producer) and the API
 * (consumer) so both agree on topic names and payload shape.
 *
 * Phase 1 used an in-process broadcast, which is fine for a demo but wrong for production: it
 * couples ingestion to the web tier, loses events if the API restarts mid-burst, and cannot absorb
 * the burst that a substation-wide disturbance produces (one fault easily generates hundreds of
 * events across dozens of relays within a second). Phase 2 introduces a real log-based bus.
 *
 * Redpanda is the default in docker-compose because it is Kafka-API-compatible with no ZooKeeper
 * and a much smaller footprint, which matters for an on-premise deployment in a utility. Anything
 * speaking the Kafka protocol works.
 */

export const KAFKA_TOPICS = {
  /**
   * Raw normalised events from the gateways. Partitioned by relayId so all events for one relay
   * land on the same partition and therefore keep their relative order — essential, because a
   * pickup must never be processed after the trip it preceded.
   */
  EVENTS_RAW: 'simorgh.events.raw',
  /** Events after enrichment (project/province/city resolved, severity normalised). */
  EVENTS_ENRICHED: 'simorgh.events.enriched',
  /** Correlated faults produced by the fault-assembly stage. */
  FAULTS: 'simorgh.faults',
  /** Alarm lifecycle changes. */
  ALARMS: 'simorgh.alarms',
  /** Gateway/link diagnostics, for the comms health view. */
  DIAGNOSTICS: 'simorgh.diagnostics',
  /** Disturbance record availability notifications, consumed by the COMTRADE fetcher. */
  DISTURBANCE_RECORDS: 'simorgh.disturbance.records',
  /**
   * Anything that could not be processed. A dead-letter topic is not optional in a system that
   * monitors protection equipment: silently dropping an event you failed to parse is how a real
   * trip goes unrecorded.
   */
  DEAD_LETTER: 'simorgh.events.dlq',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export const CONSUMER_GROUPS = {
  EVENT_PROCESSOR: 'simorgh-event-processor',
  FAULT_ASSEMBLER: 'simorgh-fault-assembler',
  ALARM_ENGINE: 'simorgh-alarm-engine',
  LIVE_FEED: 'simorgh-live-feed',
  COMTRADE_FETCHER: 'simorgh-comtrade-fetcher',
} as const;

/**
 * Envelope wrapping every message. The envelope is versioned so a gateway running older firmware
 * can keep publishing while the backend is upgraded — in a utility, gateway fleets are not
 * upgraded in lockstep with the datacentre.
 */
export interface EventEnvelope<T = unknown> {
  /** Schema version of the payload. Consumers must tolerate unknown minor versions. */
  schemaVersion: string;
  /** Identifies the gateway that produced this, for provenance and for per-site rate limiting. */
  gatewayId: string;
  /** Site the gateway serves. Province/city only — never a precise location. */
  siteRef: { projectId?: string; provinceId?: string; cityId?: string };
  /** When the gateway published it (distinct from the event's own timestamp). */
  publishedAt: string;
  /** Monotonic counter per gateway, so a consumer can detect a gap. */
  sequence: number;
  payload: T;
}

export const EVENT_SCHEMA_VERSION = '2.0';

/** Partition key for a UnifiedEvent — relay-level ordering is what we need to preserve. */
export function partitionKeyFor(event: { relayId?: string; projectId?: string }): string {
  return event.relayId ?? event.projectId ?? 'unassigned';
}
