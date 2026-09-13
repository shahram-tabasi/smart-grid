import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { authRouter } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { mapRouter } from './routes/map';
import { projectsRouter } from './routes/projects';
import { relaysRouter } from './routes/relays';
import { faultsRouter } from './routes/faults';
import { alarmsRouter } from './routes/alarms';
import { workOrdersRouter } from './routes/workOrders';
import { aiRouter } from './routes/ai';
import { reportsRouter } from './routes/reports';
import { adminRouter } from './routes/admin';
import { executiveRouter } from './routes/executive';
import { ingestRouter } from './routes/ingest';
import { commsRouter } from './routes/comms';
import { provisioningRouter } from './routes/provisioning';
import { requireAuth } from './middleware/auth';
import { pool } from './db/pool';
import { attachLiveFeed } from './ws/liveFeed';
import { startKafkaConsumer } from './events/consumer';

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' }));
app.use(express.json({ limit: '2mb' }));

// Rate limiting at the API gateway layer (docs/ARCHITECTURE.md §10). In production this sits in
// front of the API (Redis-backed, per API key); this in-process limiter keeps local/dev deployments
// protected without requiring Redis to be running.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/**
 * Public readiness check — the only endpoint that answers without a session.
 *
 * It now checks the DATABASE as well as the process, because "the web server is up" is not the
 * question anyone is actually asking. With the database unreachable this API still answered 200
 * here while every real request failed, and signing in returned a bare "Internal server error" with
 * no hint of the cause. The startup screen runs this before the login form appears, so an operator
 * is told the database is down BEFORE typing credentials rather than after.
 *
 * Deliberately discloses no data: a boolean and a duration, nothing about schema, contents or
 * connection details. Unauthenticated callers learn only whether the system is able to serve.
 */
app.get('/health', async (_req, res) => {
  const started = Date.now();
  let database: 'ok' | 'unreachable' = 'ok';
  try {
    await pool.query('SELECT 1');
  } catch {
    database = 'unreachable';
  }
  const body = {
    status: database === 'ok' ? 'ok' : 'degraded',
    service: 'simorgh-grid-api',
    database,
    databaseLatencyMs: Date.now() - started,
    time: new Date().toISOString(),
  };
  // 503 when it cannot serve, so uptime monitors and container health checks see the failure too
  // instead of a green light in front of a dead system.
  res.status(database === 'ok' ? 200 : 503).json(body);
});

// AUTHENTICATION IS REQUIRED BY DEFAULT.
//
// This used to be the other way round: reads were open unless REQUIRE_AUTH_FOR_READS=true was set.
// The intent was to make a first evaluation frictionless, but the effect was that anyone who could
// reach the server read the whole fleet without signing in — every project, every relay, every
// fault, every alarm, the executive summary, and the map of where the company's panels are. A
// default that has to be remembered in order to be safe is not a safe default, so the flag is now
// inverted: the system is closed, and opening it is the deliberate act.
//
// SIMORGH_PUBLIC_READS=true reopens the read endpoints for an offline demo on a laptop. It logs a
// warning on every start so nobody discovers months later that a server has been running open.
const PUBLIC_READS = process.env.SIMORGH_PUBLIC_READS === 'true';

app.use('/api/auth', authRouter);

if (PUBLIC_READS) {
  // eslint-disable-next-line no-console
  console.warn(
    '[api] WARNING: SIMORGH_PUBLIC_READS=true — dashboard, map, projects, relays, faults, alarms,\n' +
    '      work orders and the executive summary are readable WITHOUT SIGNING IN. Use this only on\n' +
    '      an isolated demo machine. Remove it from .env for any shared or networked deployment.'
  );
}

// Auth is applied unless explicitly opened. requireAuth is a no-op passthrough in the open case, so
// there is exactly one mount per router and no chance of the two branches drifting apart — which is
// how the comms router previously ended up with two different mounts and two different comments.
const guard = PUBLIC_READS ? (_req: any, _res: any, next: any) => next() : requireAuth;

app.use('/api/dashboard', guard, dashboardRouter);
app.use('/api/map', guard, mapRouter);
app.use('/api/projects', guard, projectsRouter);
app.use('/api/relays', guard, relaysRouter);
app.use('/api/faults', guard, faultsRouter);
app.use('/api/alarms', guard, alarmsRouter);
app.use('/api/work-orders', guard, workOrdersRouter);
app.use('/api/executive', guard, executiveRouter);
// The comms router additionally enforces auth per-route where it matters most: OT network
// addresses, the gateway list and the dead-letter queue require a signed-in user even when reads
// are open, because those disclose how to reach the equipment.
app.use('/api/comms', guard, commsRouter);

// These three are never public, even with SIMORGH_PUBLIC_READS set: the copilot answers questions
// over the whole dataset, reports export it, and admin exposes the audit log.
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/reports', requireAuth, reportsRouter);
app.use('/api/admin', requireAuth, adminRouter);
// Provisioning: creating real projects and registering real relays. Every endpoint requires auth
// and a provisioning role; see the router header for why this cannot become a control path.
app.use('/api/provisioning', provisioningRouter);

// Gateway ingest. Authenticated by a per-gateway bearer token inside the router, deliberately
// outside the user JWT scheme — a gateway is not a user and must not reach any other endpoint.
// Its own rate limit is far higher than the user-facing one, because a substation-wide disturbance
// legitimately produces a large burst in a few seconds and throttling that would lose trip events.
app.use(
  '/api/ingest',
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.INGEST_RATE_LIMIT_PER_MINUTE ?? 6000),
    standardHeaders: true,
    legacyHeaders: false,
  }),
  express.json({ limit: '10mb' }),
  ingestRouter
);

app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('[api] unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
attachLiveFeed(server);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] Simorgh Grid API listening on :${PORT} (WebSocket at /ws)`);
});

// Kafka consumer, when EVENT_BUS=kafka. Returns null (and logs why) in every other configuration,
// so a deployment without a broker starts normally and ingests over HTTP instead.
let kafkaConsumer: { stop: () => Promise<void> } | null = null;
startKafkaConsumer()
  .then((c) => {
    kafkaConsumer = c;
  })
  .catch((err) => {
    // A broker problem must not prevent the API from serving the dashboard.
    // eslint-disable-next-line no-console
    console.error('[api] Kafka consumer failed to start; HTTP ingest remains available', err);
  });

async function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[api] ${signal} received, shutting down`);
  await kafkaConsumer?.stop();
  server.close(() => process.exit(0));
  // Force exit if connections do not drain promptly.
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
