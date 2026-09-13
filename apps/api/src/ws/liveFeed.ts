import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { v4 as uuid } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

/**
 * Real-time delivery layer (docs/ARCHITECTURE.md §11). In a full deployment this subscribes to Redis
 * pub/sub channels fed by the Event Processing Service consuming Kafka. Phase 1's default
 * EVENT_BUS=direct mode (see docker-compose.yml) skips Kafka/Redis for local evaluation: this module
 * both (a) broadcasts real rows whenever a route in this API writes one, and (b) simulates a light,
 * clearly-marked synthetic live feed so the Live Operations screen has something to show against the
 * seeded demo dataset without a real Edge Gateway connected. Nothing here originates from or reaches
 * an actual relay.
 */
export function attachLiveFeed(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    if (token) {
      try {
        // Same rule as requireAuth: a refresh token is not an access token. Without this check a
        // 30-day refresh token opened a live feed, since both were signed with the same key.
        const decoded = jwt.verify(token, JWT_SECRET) as { type?: string; id?: string };
        if (decoded.type === 'refresh' || !decoded.id) throw new Error('Not an access token');
      } catch {
        ws.close(4001, 'Invalid token');
        return;
      }
    }
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Simorgh Grid live feed connected.' }));
    ws.on('close', () => clients.delete(ws));
  });

  function broadcast(payload: unknown) {
    const data = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  async function tickSyntheticEvent() {
    try {
      const { rows: relays } = await pool.query(`
        SELECT r.id, r.relay_code, r.comm_status, r.panel_id, p.id AS project_id, p.code AS project_code,
               p.province_id, p.city_id, c.name_en AS city_name_en, c.name_fa AS city_name_fa
        FROM relays r
        JOIN panels pnl ON pnl.id = r.panel_id
        JOIN switchgear sg ON sg.id = pnl.switchgear_id
        JOIN substations s ON s.id = sg.substation_id
        JOIN projects p ON p.id = s.project_id
        JOIN cities c ON c.id = p.city_id
        ORDER BY random() LIMIT 1
      `);
      const relay = relays[0];
      if (!relay) return;

      const templates = [
        { type: 'BREAKER_STATE_CHANGE', severity: 'INFO', message: `Breaker status changed on ${relay.relay_code}` },
        { type: 'MEASUREMENT', severity: 'INFO', message: `Routine measurement update from ${relay.relay_code}` },
        { type: 'COMM_LOST', severity: 'MEDIUM', message: `Communication interruption detected on ${relay.relay_code}` },
        { type: 'SCADA_ALARM', severity: 'LOW', message: `SCADA informational alarm — ${relay.relay_code}` },
      ];
      const tmpl = templates[Math.floor(Math.random() * templates.length)];
      const eventId = uuid();

      await pool.query(
        `INSERT INTO events (id, project_id, province_id, city_id, panel_id, relay_id, event_type, severity, source_protocol, message, measurements, is_demo_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC',$9,'{}'::jsonb, true)`,
        [eventId, relay.project_id, relay.province_id, relay.city_id, relay.panel_id, relay.id, tmpl.type, tmpl.severity, tmpl.message]
      );

      broadcast({
        type: 'LIVE_EVENT',
        event: {
          id: eventId, time: new Date().toISOString(), eventType: tmpl.type, severity: tmpl.severity,
          message: tmpl.message, projectCode: relay.project_code, cityNameEn: relay.city_name_en,
          cityNameFa: relay.city_name_fa, relayCode: relay.relay_code, isDemoData: true,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ws] synthetic tick failed', err);
    }
  }

  if (process.env.SIMULATE_LIVE_FEED !== 'false') {
    setInterval(tickSyntheticEvent, Number(process.env.LIVE_FEED_INTERVAL_MS ?? 12000));
  }

  return { broadcast };
}
