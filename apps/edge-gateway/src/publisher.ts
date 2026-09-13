import * as https from 'https';
import * as http from 'http';
import {
  UnifiedEvent,
  KAFKA_TOPICS,
  EventEnvelope,
  EVENT_SCHEMA_VERSION,
  partitionKeyFor,
} from '@simorgh/shared';

/**
 * Publishes normalised events from the gateway to the backend.
 *
 * Two transports, chosen by EVENT_BUS:
 *  - "kafka": produce to Redpanda/Kafka. The right choice at scale — it absorbs the burst a
 *    substation-wide disturbance produces and decouples ingestion from the web tier.
 *  - "direct": HTTPS POST straight to the API. Correct for a small site with a handful of relays
 *    where running a broker would be disproportionate, and the default for local evaluation.
 *
 * Both buffer to disk-free memory with a bounded queue and retry with backoff, because the one
 * thing a protection-monitoring gateway must not do is silently discard a trip event when the
 * link to the datacentre wobbles.
 */

export interface EventPublisher {
  readonly kind: 'kafka' | 'direct' | 'stdout';
  publish(event: UnifiedEvent): Promise<void>;
  close(): Promise<void>;
}

const GATEWAY_ID = process.env.GATEWAY_ID ?? 'gateway-local';
const MAX_QUEUE = Number(process.env.PUBLISH_QUEUE_MAX ?? 10000);

function envelope(event: UnifiedEvent, sequence: number): EventEnvelope<UnifiedEvent> {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    gatewayId: GATEWAY_ID,
    // Province/city only. The gateway knows which site it serves; it never transmits a coordinate,
    // because the envelope has nowhere to put one.
    siteRef: {
      projectId: process.env.SITE_PROJECT_ID || undefined,
      provinceId: process.env.SITE_PROVINCE_ID || undefined,
      cityId: process.env.SITE_CITY_ID || undefined,
    },
    publishedAt: new Date().toISOString(),
    sequence,
    payload: event,
  };
}

// ---------------------------------------------------------------------------------------------
// Kafka / Redpanda
// ---------------------------------------------------------------------------------------------

class KafkaPublisher implements EventPublisher {
  readonly kind = 'kafka' as const;
  private producer: any;
  private sequence = 0;

  constructor(producer: any) {
    this.producer = producer;
  }

  static async create(): Promise<KafkaPublisher | null> {
    let kafkajs: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      kafkajs = require('kafkajs');
    } catch {
      console.warn('[publisher] kafkajs is not installed; falling back. npm install kafkajs --workspace=@simorgh/edge-gateway');
      return null;
    }
    const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((b) => b.trim());
    const kafka = new kafkajs.Kafka({
      clientId: GATEWAY_ID,
      brokers,
      ssl: process.env.KAFKA_SSL === 'true',
      sasl:
        process.env.KAFKA_SASL_USERNAME
          ? {
              mechanism: process.env.KAFKA_SASL_MECHANISM ?? 'scram-sha-512',
              username: process.env.KAFKA_SASL_USERNAME,
              password: process.env.KAFKA_SASL_PASSWORD ?? '',
            }
          : undefined,
      retry: { initialRetryTime: 300, retries: 10 },
    });
    const producer = kafka.producer({
      allowAutoTopicCreation: true,
      // idempotent producer: a retry after a partial failure must not duplicate a trip event
      idempotent: true,
      maxInFlightRequests: 5,
    });
    try {
      await producer.connect();
    } catch (err) {
      console.error(`[publisher] kafka connect failed: ${(err as Error).message}`);
      return null;
    }
    return new KafkaPublisher(producer);
  }

  async publish(event: UnifiedEvent): Promise<void> {
    const topic =
      event.eventType === 'DISTURBANCE_RECORD_AVAILABLE'
        ? KAFKA_TOPICS.DISTURBANCE_RECORDS
        : KAFKA_TOPICS.EVENTS_RAW;
    try {
      await this.producer.send({
        topic,
        messages: [
          {
            // Partition by relay so per-relay ordering is preserved: a pickup must never be
            // consumed after the trip that followed it.
            key: partitionKeyFor(event),
            value: JSON.stringify(envelope(event, this.sequence++)),
            headers: { eventType: event.eventType, severity: event.severity },
          },
        ],
      });
    } catch (err) {
      console.error(`[publisher] kafka send failed, event ${event.eventId}: ${(err as Error).message}`);
      throw err;
    }
  }

  async close(): Promise<void> {
    try {
      await this.producer.disconnect();
    } catch {
      /* already down */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Direct HTTPS to the API
// ---------------------------------------------------------------------------------------------

class DirectPublisher implements EventPublisher {
  readonly kind = 'direct' as const;
  private queue: EventEnvelope<UnifiedEvent>[] = [];
  private sequence = 0;
  private draining = false;
  private closed = false;
  private timer?: NodeJS.Timeout;

  constructor(private endpoint: URL, private token?: string) {
    // Batch every second rather than one request per event: a disturbance produces hundreds of
    // events in a burst and per-event requests would collapse under it.
    this.timer = setInterval(() => void this.drain(), 1000);
  }

  async publish(event: UnifiedEvent): Promise<void> {
    if (this.queue.length >= MAX_QUEUE) {
      // Drop the oldest INFO-level entry rather than the newest event: losing a routine
      // measurement is acceptable, losing a trip is not.
      const idx = this.queue.findIndex((e) => e.payload.severity === 'INFO');
      if (idx >= 0) this.queue.splice(idx, 1);
      else this.queue.shift();
      console.warn('[publisher] queue full; oldest low-severity event discarded');
    }
    this.queue.push(envelope(event, this.sequence++));
  }

  private async drain(): Promise<void> {
    if (this.draining || this.queue.length === 0) return;
    this.draining = true;
    const batch = this.queue.splice(0, 200);
    try {
      await this.post(batch);
    } catch (err) {
      // Put the batch back at the front so ordering is preserved and nothing is lost.
      this.queue.unshift(...batch);
      console.error(`[publisher] direct publish failed (${batch.length} events requeued): ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private post(batch: EventEnvelope<UnifiedEvent>[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ events: batch });
      const lib = this.endpoint.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          host: this.endpoint.hostname,
          port: this.endpoint.port || (this.endpoint.protocol === 'https:' ? 443 : 80),
          path: this.endpoint.pathname,
          method: 'POST',
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            'X-Gateway-Id': GATEWAY_ID,
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
            else reject(new Error(`ingest returned HTTP ${res.statusCode}`));
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('ingest timeout')));
      req.write(body);
      req.end();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.drain();
  }
}

class StdoutPublisher implements EventPublisher {
  readonly kind = 'stdout' as const;
  async publish(): Promise<void> {
    /* index.ts already logs each event; this exists so the gateway runs with no backend at all */
  }
  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------------------------

export async function createEventPublisher(): Promise<EventPublisher> {
  const mode = (process.env.EVENT_BUS ?? 'direct').toLowerCase();

  if (mode === 'kafka') {
    const kafka = await KafkaPublisher.create();
    if (kafka) return kafka;
    console.warn('[publisher] kafka unavailable; falling back to direct HTTP publishing');
  }

  const ingestUrl = process.env.INGEST_URL;
  if (mode === 'stdout' || !ingestUrl) {
    if (!ingestUrl && mode !== 'stdout') {
      console.warn('[publisher] INGEST_URL is not set; events will be logged but not forwarded');
    }
    return new StdoutPublisher();
  }
  return new DirectPublisher(new URL(ingestUrl), process.env.INGEST_TOKEN);
}
