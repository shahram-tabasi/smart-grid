# Simorgh Grid

**National Electrical Project & Protection Operations Center** — a centralized command center unifying
project management, protection relay monitoring / SCADA integration, fault & alarm management, and advisory
AI analytics for an electrical switchgear manufacturing and engineering company operating projects across
Iran.

This is **Phase 2** of an 8-phase build (see [Phased delivery](docs/ARCHITECTURE.md#12-phased-delivery-as-specified)).

**New in Phase 2:** 30 relay communication protocols with redundant-path failover, a Kafka/Redpanda
event bus with authenticated gateway ingest, retrieval-augmented AI with pgvector, per-event
time-sync quality tracking, and a Communications console. Full operator documentation is in
**[docs/OPERATIONS_MANUAL.md](docs/OPERATIONS_MANUAL.md)**.

Phase 1 scope:
a real, runnable full-stack application — database, backend API, frontend, demo data, and the architectural
scaffolding (Edge Gateway, driver abstraction, Unified Event Model) that later phases plug real protocol
integrations and a production AI service into, without changing the shape of anything built here.

**Read `docs/ARCHITECTURE.md` and `docs/DATABASE.md` first** — they explain the security invariants (no
precise locations anywhere in the general app, relays never internet-facing, AI is advisory-only, read/control
separation) that shape every layer below, and why.

## Quick start (Docker Compose)

```bash
cp .env.example .env
docker compose up -d --build         # postgres, redis, minio, api, web
docker compose run --rm migrate      # applies db/migrations/*.sql, then seeds demo data
```

- Web: http://localhost:3000
- API health check: http://localhost:4000/health
- Adminer (DB browser): http://localhost:8081 (system: PostgreSQL, server: `postgres`, credentials from `.env`)
- MinIO console: http://localhost:9001

Sign in with any seeded account — see `GET /api/auth/demo-accounts` or the autocomplete on the web app's
login page. **Every demo account's password is `Demo@1234`.** GET endpoints are open without signing in
(so the dashboard is explorable immediately); actions that change state (acknowledge, assign, create a work
order, approve an AI recommendation) require signing in and the right role.

## Quick start (without Docker)

Requires Node 20+ and a local PostgreSQL 16 (TimescaleDB extension optional — migrations fall back to plain
tables if it's not installed; Redis/MinIO are used by later phases and aren't required for Phase 1 to run).

```bash
npm install
cp .env.example .env   # then edit DATABASE_URL to point at your local Postgres
npm run db:migrate
npm run db:seed
npm run dev:api    # apps/api on :4000
npm run dev:web    # apps/web on :3000, in another terminal
```

## What's actually implemented in Phase 1

- **Database**: full PostgreSQL/TimescaleDB schema (`db/migrations/`) — projects, the complete equipment
  hierarchy (substation → switchgear → panel → breaker → relay → protection function), events, faults with
  millisecond-precision timelines, COMTRADE/disturbance records, alarms with correlation grouping, work
  orders with a full status-history workflow, AI analyses + human-approval records, notifications, an
  immutable audit log, and a database-role-enforced (`013_roles_and_grants.sql`) separation between the API,
  the AI service, and the Edge Gateway.
- **Demo data** (`db/seed/generate-demo-data.ts`): 56 projects across 24 cities in 13 provinces, ~190
  protection relays across 6 manufacturers, 500+ historical events, 58 faults with full timelines (and
  synthetic COMTRADE waveforms for a subset of critical trips), 20+ correlated alarms, 24 work orders, 28 AI
  root-cause analyses — every row flagged `is_demo_data = true` and surfaced with a persistent "DEMO DATA"
  badge in the UI so it's never mistaken for live field data.
- **Backend API** (`apps/api`, Express + TypeScript): REST endpoints for dashboard KPIs, the national
  map (province/city aggregation only), projects + hierarchy drill-down, relays, faults + timelines + AI
  analysis, alarms (acknowledge/comment/suppress), work orders (create/transition through the full
  FAULT → ... → CLOSED workflow), the executive summary, reports (CSV today, PDF/XLSX are a documented TODO),
  JWT auth + RBAC, and a WebSocket live feed.
- **AI** (`apps/api/src/services/simorghAi.ts`): **Simorgh Power Intelligence** (root-cause analysis per
  fault: probable cause, confidence score, cited evidence, recommendation) and **Simorgh Grid Copilot**
  (natural-language Q&A, always grounded in the same data the dashboard uses) — both implemented today as a
  deterministic rule-based engine behind the same contract an LLM-backed implementation would use later.
  **Advisory only**: nothing in this codebase lets an AI response write a relay setting or issue a control
  command — see `docs/ARCHITECTURE.md §8`.
- **Frontend** (`apps/web`, Next.js + Tailwind): dark industrial theme; Overview dashboard (auto-refreshing
  KPIs + fault trend), National Map (province → city, no coordinates), Projects (list, detail, full equipment
  drill-down with progress bars), Relays, Faults (with timeline + AI analysis panel + COMTRADE waveform
  preview), Alarms, Work Orders, AI Copilot chat, Executive dashboard, Live Operations (WebSocket), and an
  Administration/audit-log view. EN/FA language toggle with instant RTL switch.
- **Edge Gateway** (`apps/edge-gateway`): the vendor-neutral `RelayDriver` interface (`packages/shared`) and a
  `MockRelayDriver` reference implementation, so the whole platform is demonstrable before any real IEC 61850/
  DNP3/Modbus site is connected. Adding a real driver later means implementing this one interface — nothing
  upstream changes.

## What's intentionally not done yet

Everything phased in `docs/ARCHITECTURE.md §12` beyond what's listed above: a real Kafka/Redpanda event bus
(the app runs in a documented `EVENT_BUS=direct` mode instead), real IEC 61850/DNP3/Modbus/OPC UA drivers
(the mock adapter stands in), an LLM-backed AI implementation with pgvector retrieval, PDF/XLSX report
rendering (CSV works today), real email/SMS/push notification delivery (the `notifications` table and API are
there; wiring a provider is a Phase 7 task), and security hardening like MFA, a real credential vault, and a
WAF (RBAC, JWT, audit logging, rate limiting, and the read/control separation are already in place — the rest
is operational hardening for a real deployment, not a local demo).

## Project structure

```
kavir_monitoring/
├── docs/
│   ├── ARCHITECTURE.md      # read this first — system design, security model, phased roadmap
│   └── DATABASE.md          # schema walkthrough and the "why" behind each modeling choice
├── db/
│   ├── migrations/          # numbered plain-SQL migrations, applied by db/migrate.ts
│   └── seed/                # demo data generator (db/seed/generate-demo-data.ts)
├── packages/shared/         # TypeScript types shared by every app: enums, geography, Unified Event Model,
│                             the RelayDriver interface
├── apps/
│   ├── api/                 # Express + TypeScript backend (REST + WebSocket)
│   ├── web/                 # Next.js + Tailwind frontend
│   └── edge-gateway/        # protocol driver abstraction + MockRelayDriver
├── docker-compose.yml
└── .env.example
```

## Security invariants (do not regress these)

1. **No exact coordinates, addresses, or precise site locations anywhere in the general application.** Only
   province + city. See `docs/ARCHITECTURE.md §9` for the three enforcement layers (schema, API, AI).
2. **Relays are never internet-facing** and the cloud platform never dials back into a site — see the
   architecture diagram in `docs/ARCHITECTURE.md §3`.
3. **Read vs. control separation.** This build implements monitoring only. There is no endpoint, database
   role, or AI tool anywhere in this codebase that writes a relay setting or issues a breaker command.
4. **AI is advisory only.** Every AI recommendation requires an explicit, audit-logged human approval before
   anything downstream (like a work order) is considered actioned.
5. **The audit log is append-only** at the database-role level (`INSERT`/`SELECT` only), not just by
   application convention.

If a future change seems to require weakening any of the above, treat that as a signal to stop and design a
separate, explicitly-scoped subsystem for it — not to loosen these defaults.

---

## Install

**Windows** — double-click `START.bat`, or:

```powershell
.\install.ps1
```

**Linux / macOS**:

```bash
./install.sh
```

The installer checks Docker is actually running, generates real secrets into `.env` (it never ships
fixed ones), starts the stack, waits for the database, applies migrations, seeds demo data, and then
**verifies the API answers before claiming success**. Re-running it is safe: an existing `.env` is
left alone and migrations are idempotent.

| Option | Effect |
|---|---|
| `--no-seed` / `-NoSeed` | schema only, no demo data — for a real deployment |
| `--rebuild` / `-Rebuild` | force an image rebuild after code changes |
| `--reset` / `-Reset` | destroy all data and start clean (asks for confirmation) |

When it finishes: **http://localhost:3000**, sign in as `admin@simorgh.local` / `Demo@1234`.

## Testing without hardware

A built-in IEC 60870-5-104 relay simulator lets the whole pipeline be exercised with no device:

```bash
npm run simulator        # listens on port 2404, pretends to be a SIPROTEC relay
```

Register a relay pointing at it (host `127.0.0.1`, port `2404`, point map *Siemens SIPROTEC generic*),
run the gateway with `SIMULATE=false`, and press ENTER in the simulator to inject a protection trip.
Unlike the gateway's own `SIMULATE` flag, this drives the **real** protocol driver, so the codec is
genuinely exercised.

```bash
npm test                 # AI guardrails (9 checks) + IEC 104 protocol loopback (18 checks)
npm run test:protocol    # driver against simulator over a real socket
```

---

## Phase 2 quick reference

```bash
npm run protocols          # print all 30 supported protocols and their capabilities
npm run test:guardrails    # AI safety guardrail tests (9 checks)
npm run typecheck          # typecheck every workspace
npm run dev:gateway        # Edge Gateway in simulator mode — no hardware needed

docker compose up -d                    # core stack, EVENT_BUS=direct
docker compose --profile kafka up -d    # add Redpanda
docker compose --profile gateway up -d  # add the Edge Gateway simulator
```

### Protocols supported

| Family | Protocols |
|---|---|
| **IEC 61850** | MMS (station bus), GOOSE (layer-2 multicast), Sampled Values 9-2, MMS file services |
| **IEC 60870-5** | -104 (TCP), -101 (serial), **-103 (protection companion standard)** |
| **DNP3** | TCP, serial |
| **Modbus** | TCP, RTU, ASCII |
| **Modern IT** | OPC UA, MQTT, MQTT Sparkplug B, REST, WebSocket |
| **Vendor** | SEL ASCII/Fast Meter/Fast SER, ABB SPA-bus, MiCOM Courier, GE EGD, PROFIBUS DP |
| **Auxiliary** | SNMP, Syslog, FTP, SFTP, TFTP, NTP, PTP/IEEE 1588 |

Auxiliary channels are not an afterthought: SNMP tells you whether a silent relay is a relay
problem or a network problem, syslog carries relay setting changes and failed logins, and NTP/PTP
supervision is what keeps the millisecond fault timeline honest.

### Phase 2 security invariants (added to the Phase 1 list — do not regress these)

6. **No control path exists at any layer.** The driver interface has no write method; each protocol
   driver restricts itself at the wire level (DNP3 read function codes only, Modbus read functions
   only, REST hard-coded GET, MQTT subscribe-only, SEL read-command whitelist with no ACCESS
   escalation, TFTP read opcode only); the IEC 60870-5 module has no command encoder.
7. **The gateway connects outbound only.** The backend never dials into a substation.
8. **Ingest rejects coordinates.** An event carrying a latitude/longitude field is refused and
   dead-lettered, not silently stripped — a gateway sending coordinates is a misconfiguration
   somebody needs to fix.
9. **The AI knowledge corpus rejects coordinates at the database layer**, because retrieved chunks
   are pasted into model prompts.
10. **AI output is validated before storage.** Answers that claim an action, contain coordinates,
    cite no evidence, or call a communication loss a confirmed protection operation are rejected,
    and the deterministic engine answers instead.
11. **Nothing is silently dropped.** Unprocessable events go to a dead-letter queue that is visible
    in the UI.
