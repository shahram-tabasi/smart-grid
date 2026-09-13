# Simorgh Grid — National Electrical Project & Protection Operations Center

**Platform codename:** Simorgh Grid
**Owner:** Electrical switchgear manufacturing & engineering company (multi-project, national footprint — Iran)
**Document status:** Phase 1 architecture baseline. Supersedes nothing; this is the founding design doc.

---

## 1. Purpose

Simorgh Grid is the company's centralized command center, unifying four domains that today live in separate
spreadsheets, vendor tools, and site visits:

1. **Project Management** — every MV/HV switchgear project from PLANNING through RUNNING.
2. **Protection Relay Monitoring / SCADA Integration** — vendor-neutral visibility into every relay, breaker,
   feeder and transformer across every project.
3. **Fault & Alarm Management** — a normalized event pipeline from protection operation to work order closure.
4. **AI Analytics ("Simorgh Power Intelligence" / "Simorgh Grid Copilot")** — advisory root-cause analysis,
   health scoring, and natural-language querying over the above, **never** a control path.

A manager opening the system should immediately answer: *where are our projects, how many are healthy, what
just tripped, why, and what should engineering do about it first.*

## 2. Non-negotiable constraints

These constraints shape every layer below and must not be "optimized away" in later phases:

- **No exact locations, anywhere in the management application.** No GPS, no lat/long, no street address, no
  map pin. The data model stores only `province` and `city` (both FK'd to reference tables) at the
  management-API level. If a precise site address is ever needed for authorized field-service dispatch, it
  lives in a *separate, explicitly-permissioned* table (`site_location_restricted`) that is never joined into
  any endpoint the general application, executive dashboard, AI, or map uses. See §9.
- **Relays are never internet-facing.** The only path from an IED to the cloud application is
  `IED → OT network → industrial gateway → firewall/DMZ → Simorgh Edge Gateway (secure data collector) →
  message bus → backend`. The backend never opens an outbound or inbound connection directly to a relay.
- **Read-only by default.** Phase 1–8 as scoped here implement **monitoring only**. There is no code path from
  the UI, the API, or the AI service that can write a setting or issue a control command to a relay or
  breaker. Control capability, if ever built, requires a separate service, separate credentials, hardware
  interlocks, and out-of-band authorization — explicitly out of scope for this build.
- **AI is advisory only.** The AI service (§8) produces summaries, confidence scores and recommendations. It
  has no write access to relay configuration, no access to control endpoints, and every action it recommends
  requires an explicit human "approve" click that is itself audit-logged.
- **Vendor neutrality.** No relay manufacturer's SDK, protocol quirks, or naming convention may leak past the
  Edge Gateway's driver layer. The backend and frontend only ever see the Unified Event Model (§7).

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SITE / OT NETWORK (per project)                                            │
│                                                                               │
│   Protection Relays / IEDs  (SIPROTEC, ABB/Hitachi, SEL, GE Multilin, ...)   │
│        │ IEC 61850 MMS/GOOSE, IEC 60870-5-104, DNP3, Modbus TCP, OPC UA      │
│        ▼                                                                     │
│   Industrial Gateway (protocol concentration, local buffering)              │
│        │                                                                     │
│        ▼                                                                     │
│   Firewall / DMZ  (one-way-biased, deny-by-default, no inbound to OT)       │
│        │                                                                     │
│        ▼                                                                     │
│   Simorgh Edge Gateway  (per-site or per-region secure data collector)      │
│        - protocol drivers (pluggable, §6)                                   │
│        - normalizes to Unified Event Model (§7)                             │
│        - mutual-TLS outbound only, device-certificate authenticated         │
└──────────────────────────────┬────────────────────────────────────────────┘
                                │  MQTT / HTTPS REST (outbound only, mTLS)
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLOUD / DATA CENTER — Simorgh Grid Platform                                │
│                                                                               │
│   Secure API Gateway (authn, rate limiting, WAF)                            │
│        │                                                                     │
│        ▼                                                                     │
│   Ingestion Service ── Kafka/Redpanda topic: events.raw                     │
│        │                                                                     │
│        ▼                                                                     │
│   Event Processing Service (fault detection, correlation, dedup)            │
│        ├──▶ PostgreSQL (relational: projects, equipment, work orders, RBAC) │
│        ├──▶ TimescaleDB (hypertables: telemetry, events, SOE)               │
│        ├──▶ Redis (cache, pub/sub for live dashboards, rate limits)         │
│        └──▶ S3-compatible Object Storage (COMTRADE, PDFs, reports)          │
│        │                                                                     │
│        ▼                                                                     │
│   Backend API (REST + WebSocket) ── RBAC, audit log, business logic         │
│        │                                            │                       │
│        ▼                                            ▼                       │
│   Web Frontend (Next.js)                     AI Service (Python, advisory)  │
│   Overview / Map / Projects / Relays /       Simorgh Power Intelligence     │
│   Faults / AI / Work Orders / Reports /      Simorgh Grid Copilot           │
│   Admin — dark, RTL+LTR, mobile-responsive   pgvector/Qdrant for retrieval  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why this shape

- **Edge Gateway is the only thing that talks to OT.** It is a separate deployable (own repo folder,
  own container) so a plant network team can review exactly what leaves the site. It never receives inbound
  connections from the cloud.
- **Kafka/Redpanda decouples ingestion from processing.** A burst of GOOSE trip events, or a site coming back
  online after a communication outage and replaying its buffer, cannot overwhelm the API or the database
  directly; it queues.
- **TimescaleDB for anything time-indexed** (telemetry samples, events, SOE records) because the volume here
  (150+ relays × continuous events) is fundamentally a time-series problem — retention policies, continuous
  aggregates, and compression matter from day one.
- **PostgreSQL for everything relational** (org structure, project management, RBAC, work orders) because it's
  the same database engine (fewer moving parts) and because TimescaleDB *is* PostgreSQL.
- **AI service is a separate process, not a library inside the API.** This keeps the "AI never touches
  control" boundary architectural, not just a code convention: the AI service's database role is `GRANT
  SELECT` only, and it has no network route to the Edge Gateway or any relay-facing component at all.

## 4. Repository layout (this monorepo)

```
kavir_monitoring/
├── docs/                     # this file, DATABASE.md, diagrams
├── db/                       # SQL migrations + seed/demo data loader
│   ├── migrations/
│   └── seed/
├── apps/
│   ├── api/                  # Node.js + TypeScript + Express backend (REST + WebSocket)
│   ├── web/                  # Next.js + TypeScript + Tailwind frontend
│   └── edge-gateway/         # Simorgh Edge Gateway — protocol drivers + normalizer (mock adapters in Phase 1)
├── packages/
│   └── shared/                # Shared TypeScript types (Unified Event Model, DTOs, enums)
├── docker-compose.yml
├── .env.example
└── README.md
```

## 5. Technology choices (Phase 1)

| Layer            | Choice                                              | Notes |
|-------------------|-----------------------------------------------------|-------|
| Frontend          | Next.js 14 (App Router) + TypeScript + Tailwind CSS | Dark industrial theme, EN/FA i18n, mobile-responsive |
| Charts            | Recharts                                             | KPI sparklines, trend charts |
| Backend           | Node.js + TypeScript + Express                       | REST + `ws` WebSocket server. (NestJS-equivalent module boundaries are kept even though Express is used, so a later move to NestJS or .NET is a rewrite of wiring, not of business logic.) |
| Relational DB     | PostgreSQL 16                                        | via `docker-compose`, `pg` driver |
| Time-series       | TimescaleDB (Postgres extension, same container)     | hypertables for `telemetry`, `protection_events` |
| Cache / pub-sub   | Redis 7                                              | live dashboard fan-out, rate limiting |
| Streaming         | Kafka/Redpanda                                       | documented in this doc + edge-gateway stub; **not** started by default in Phase 1 `docker-compose` to keep local bring-up light — see §12 Phase 2 |
| Object storage    | S3-compatible (MinIO locally)                        | COMTRADE files, generated reports |
| AI service        | Python interface documented (§8); Phase 1 ships a deterministic Node-side stub behind the same API contract so the UI and API are real today | pgvector planned for retrieval |
| Auth              | JWT (access + refresh), bcrypt password hashing, RBAC middleware | MFA hook point documented, not yet enforced in Phase 1 |
| Containerization  | Docker Compose                                       | `postgres`, `redis`, `minio`, `api`, `web` |

## 6. Relay / protocol driver abstraction

No part of the backend or frontend ever imports a vendor SDK or checks `manufacturer === 'Siemens'` to decide
behavior. The contract:

```ts
// apps/edge-gateway/src/drivers/RelayDriver.ts
interface RelayDriver {
  protocol: 'IEC61850_MMS' | 'IEC61850_GOOSE' | 'IEC60870_5_104' | 'DNP3' | 'MODBUS_TCP' | 'OPC_UA' | 'REST' | 'MQTT';
  connect(target: RelayEndpoint): Promise<void>;
  disconnect(target: RelayEndpoint): Promise<void>;
  readStatus(target: RelayEndpoint): Promise<RelayStatusSnapshot>;
  subscribeEvents(target: RelayEndpoint, onEvent: (e: UnifiedEvent) => void): Unsubscribe;
  // No write/setSetting/control methods exist on this interface at all — by design.
}
```

Each manufacturer/protocol gets a driver implementing this interface and emitting `UnifiedEvent` (§7) only.
Phase 1 ships a `MockRelayDriver` that generates realistic traffic for demo data so the whole system is
demonstrable before any real site is connected (per spec §33/§27). Adding a real driver later — SIPROTEC via
IEC 61850 MMS, SEL via DNP3, etc. — means writing one file that implements this interface; nothing upstream
changes.

## 7. Unified Event Model

Every event the platform stores — a trip, a communication loss, a breaker state change, an alarm — is
normalized to one shape before it reaches Kafka or the database. GPS/location fields are structurally absent;
only `provinceId`/`cityId` (references, not coordinates) travel with an event.

```json
{
  "eventId": "evt_9f2c1a",
  "timestamp": "2026-09-08T09:12:44.128Z",
  "projectId": "SUB-TEH-024",
  "provinceId": "IR-07",
  "cityId": "city_tehran",
  "assetId": "asset_panel_33kv_f01",
  "relayId": "relay_ker_f03",
  "eventType": "PROTECTION_TRIP",
  "protectionFunction": "OVERCURRENT",
  "severity": "CRITICAL",
  "breakerStatus": "OPEN",
  "sourceProtocol": "IEC61850",
  "measurements": { "current_A": 842.3, "voltage_kV": 33.1, "frequency_Hz": 50.02 },
  "acknowledged": false,
  "synthetic": true
}
```

`synthetic: true` marks demo/generated data (§13) so it can never be mistaken for a live field event.

## 8. AI service contract ("Simorgh Power Intelligence" / "Simorgh Grid Copilot")

- Runs as its own service/process with a `SELECT`-only database role and **zero network path** to the Edge
  Gateway, relays, or any control endpoint.
- Input: read access to events, faults, projects, relay health, maintenance history (all via the backend API
  or read replicas — never a direct socket to OT).
- Output: `AIAnalysis` records (`summary`, `probableCause`, `confidenceScore`, `evidence[]`, `relatedEvents[]`,
  `recommendedAction`, `requiredEngineer`, `priority`) and free-text chat answers that always cite the
  underlying data (project IDs, relay IDs, event IDs, counts) rather than asserting conclusions unsupported by
  visible evidence.
- **Hard boundary:** no endpoint in this service, and no tool available to the underlying model, can write a
  relay setting, send a breaker command, or modify protection configuration. Every recommendation surfaces in
  the UI with an explicit human "Approve" action that is audit-logged (`ai_recommendation_approvals` table);
  nothing is auto-applied.
- Phase 1 ships the API contract and a deterministic rule-based implementation (pattern matches on the demo
  event data: repeated trips, comms loss patterns, threshold excursions) behind that contract, so the chat and
  root-cause UI are fully functional today. Swapping in an LLM-backed implementation later (with pgvector/
  Qdrant retrieval over historical events) changes only the internals of `services/ai/*`, not the contract.

## 9. Location privacy enforcement

This is enforced at three layers, not just "the frontend hides a field":

1. **Schema:** `projects` and `substations` store `province_id`, `city_id` (FKs) only. There is no
   `latitude`/`longitude`/`address` column on any table reachable by the general API. A separate table
   `site_location_restricted(substation_id, address, lat, lng)` exists for the narrow, explicitly-authorized
   field-dispatch use case described in the spec, with its own RBAC permission (`location:read_precise`) that
   no default role holds, and every read of it is written to the immutable audit log.
2. **API:** no endpoint under `/api/*` joins or returns `site_location_restricted`. The map endpoint
   (`GET /api/map/provinces`) aggregates counts by `province_id → city_id`, never by project or coordinate.
3. **AI:** the AI service's data access excludes `site_location_restricted` entirely (different DB role), so
   it structurally cannot mention a coordinate even if asked.

## 10. Security architecture (summary — see §20 of the original brief)

- **Network segmentation:** OT network → industrial gateway → firewall/DMZ → Edge Gateway is the only path
  into the platform; the platform never dials back into a site.
- **AuthN/AuthZ:** JWT access/refresh tokens; RBAC roles (`Admin`, `ExecutiveViewer`, `ProjectManager`,
  `ProtectionEngineer`, `FieldServiceEngineer`, `Viewer`); MFA hook documented at the login controller for
  Phase 8 hardening.
  READ vs CONTROL separation: the schema and API have no CONTROL surface at all in this build.
- **Transport:** TLS everywhere; Edge Gateway ↔ Cloud uses mutual TLS with per-device certificates issued from
  a credential vault (documented interface; local dev uses self-signed certs).
- **Audit log:** append-only table (`audit_log`), no `UPDATE`/`DELETE` grants for the application role — only
  `INSERT` and `SELECT`. Logged: logins, alarm acknowledgement, fault assignment, config changes, project
  changes, relay integration changes, permission changes, AI recommendations, human approvals.
- **Rate limiting:** at the API gateway layer (Redis token bucket per API key / user).
- **Secrets:** `.env` for local dev only; documented hook for a real credential vault (e.g. HashiCorp Vault) in
  Phase 8.

## 11. Real-time delivery

The API runs a WebSocket server (`/ws`) that:
- authenticates the connection with the same JWT used for REST,
- subscribes the client to Redis pub/sub channels scoped to what they're allowed to see (`events:global`,
  `events:project:{id}`),
- pushes `UnifiedEvent`s and KPI deltas so the dashboard, live operations screen, and alarm panel update
  without polling.
A polling fallback (`GET /api/events/recent?since=`) exists for clients that can't hold a WebSocket open
(older mobile browsers, restrictive networks).

## 12. Phased delivery (as specified)

| Phase | Scope | Status in this delivery |
|-------|-------|--------------------------|
| 1 | UI + database + demo data + project management | **Delivered** |
| 2 | Real-time event engine + WebSocket | **Delivered** (Redis pub/sub + WS; Kafka documented, not yet wired — see below) |
| 3 | Edge Gateway architecture | **Delivered as architecture + mock adapter** (`apps/edge-gateway`) |
| 4 | IEC 61850 / industrial protocol integration | Designed (driver interface, §6); real drivers are future work — needs a real site to test against |
| 5 | Fault/Event processing | **Delivered** for the normalized model; correlation engine is rule-based, extend in Phase 6+ |
| 6 | AI analytics | **Delivered** as contract + deterministic implementation; LLM/pgvector upgrade is future work |
| 7 | Work orders and notifications | **Delivered** (work orders); notification channels (email/SMS/push) are stubbed interfaces, not wired to a real provider |
| 8 | Security hardening | Architecture + RBAC + audit log delivered; MFA, credential vault, WAF, pen-testing are operational hardening for a real deployment, not a local demo |

Kafka/Redpanda is fully designed into the architecture (§3) but intentionally **not** started in the default
`docker-compose` for Phase 1, to keep `docker compose up` fast for local evaluation. The ingestion service is
written so that turning it on is a config change (`EVENT_BUS=kafka` vs the Phase-1 default `EVENT_BUS=direct`,
which writes straight to Postgres/Redis), not a rewrite.

## 13. Demo data

All demo/synthetic data is generated by `db/seed/generate-demo-data.ts` and tagged `synthetic: true` /
`is_demo_data: true` at the row level. The frontend displays a persistent "DEMO DATA" badge whenever
`is_demo_data` rows are being viewed, so it can never be mistaken for live field data (spec §27).

---

# Phase 2 — Protocol Coverage, Event Bus, and Retrieval-Augmented AI

**Document status:** Phase 2 addendum. Extends the Phase 1 baseline above; nothing in the Phase 1
security model is relaxed.

## P2.1 What changed

| Area | Phase 1 | Phase 2 |
|---|---|---|
| Protocols | 9 identifiers, one mock driver | **30 protocols, 20 concrete drivers** across IEC 61850, IEC 60870-5, DNP3, Modbus, modern IT, vendor-proprietary and auxiliary families |
| Comms model | One endpoint per relay | **Redundant paths per relay** with role ordering, supervision timeouts, automatic failover and cross-path de-duplication |
| Timestamps | Uniform | **Time-sync quality tracked per event**, with the fault timeline marking approximate entries |
| Event transport | In-process broadcast | **Kafka/Redpanda** or batched HTTPS, both idempotent, with a dead-letter queue |
| AI | Deterministic rules | **Retrieval-augmented LLM** with pgvector + full-text hybrid retrieval, and the rule engine retained as a validated fallback |
| Ingest | None (seed only) | **Authenticated gateway ingest** with schema validation, coordinate rejection and clock-sanity checks |

## P2.2 Protocol driver architecture

```
                         ┌──────────────────────────────────────────┐
   OT NETWORK            │            SIMORGH EDGE GATEWAY          │
   (never routable       │                                          │
    from the internet)   │   ConnectionSupervisor                   │
                         │     ├─ path ordering PRIMARY→BACKUP      │
  ┌────────────┐         │     ├─ supervision timeouts + failover   │
  │  Relay A   │◄────────┤     ├─ cross-path de-duplication         │
  │ 61850+103  │  GOOSE  │     └─ best-clock retention              │
  └────────────┘  MMS    │                                          │
                  103    │   DriverRegistry ──► 20 protocol drivers │
  ┌────────────┐         │                       (all READ-ONLY)    │
  │  Relay B   │◄────────┤                                          │
  │ DNP3 + SEL │         │   Normaliser ──► UnifiedEvent            │
  └────────────┘         │                                          │
                         │   Publisher ──► Kafka | HTTPS (outbound  │
  ┌────────────┐         │                        only, mTLS)       │
  │  Switch    │◄────────┤                                          │
  │  SNMP/NTP  │         └───────────────────┬──────────────────────┘
  └────────────┘                             │  outbound only
                         ══════════ FIREWALL / DMZ ══════════
                                             │
                         ┌───────────────────▼──────────────────────┐
                         │  Ingest (token auth, validation, DLQ)    │
                         │  ──► events / alarms / fetch queue       │
                         └──────────────────────────────────────────┘
```

The gateway **never accepts an inbound connection from the backend**. Direction of travel is the
core of the security model: a full compromise of the cloud service yields no route into the
protection network.

## P2.3 Why the capability model exists

`packages/shared/src/protocols.ts` describes each protocol's real characteristics — what it can
carry, how it delivers, what clock accuracy it supports. This drives real behaviour rather than
documentation:

- **Scheduling**: POLL protocols get a poll loop, PUSH protocols get a listener.
- **Trust ranking**: when the same trip arrives on GOOSE (4 ms), MMS (100 ms) and serial -103
  (1.5 s), the supervisor collapses them to one event and keeps the copy from the best clock.
- **Honest presentation**: `bestTimeSyncQuality` versus the measured offset determines whether the
  UI shows a timeline entry as precise or approximate.
- **Configuration validation**: a relay left on a single Modbus path is flagged at commissioning,
  because Modbus has no event buffer and can miss a short trip entirely.

## P2.4 Control safety — four independent layers

The read-only property does not rest on any single mechanism:

1. **Interface** — `RelayDriverV2` has no write/control/operate method and no capability flag
   describing one.
2. **Protocol** — each driver restricts itself at the wire level: DNP3 permits only READ/CONFIRM
   function codes and `buildRequest()` throws otherwise; Modbus permits only the four read
   functions; the IEC 60870-5 ASDU module has no command encoder at all; REST hard-codes GET; MQTT
   has no publish path; SEL whitelists read commands and never escalates to the ACCESS level that
   control requires; TFTP sends only the read opcode.
3. **Database** — `simorgh_ai_readonly` holds SELECT only; `simorgh_api` cannot read
   `site_location_restricted`.
4. **Output validation** — AI output claiming to have performed a control or setting action is
   rejected before storage (`validateLlmOutput`), and the deterministic engine answers instead.

## P2.5 AI: retrieval and guardrails

The Phase 1 contract is unchanged; the engine behind it now does retrieval.

- **Hybrid retrieval**: pgvector cosine similarity fused with Postgres full-text search using
  reciprocal rank fusion. Lexical is not merely a fallback — relay codes, ANSI numbers and IEC
  information numbers match better lexically than semantically.
- **Corpus privacy**: `knowledge_chunks` has a database trigger that *rejects* any chunk containing
  coordinate-shaped text. Retrieved context is pasted into model prompts, so the corpus is exactly
  where a location leak would otherwise become an output leak.
- **Validated output**: an answer is rejected if it contains coordinates, claims an action, cites no
  evidence, or describes a communication-loss fault as a confirmed protection operation. That last
  check is independent of the model and mirrors the real misclassification bug found in Phase 1
  testing.
- **Confidence capping**: when every timeline entry is gateway-stamped, confidence is capped at 75.
  A precise conclusion cannot be drawn from imprecise data.
- **Air-gap friendly**: `AI_LLM_BASE_URL` accepts any OpenAI-compatible endpoint, including a model
  hosted inside the utility's network. Unset, the deterministic engine runs and no data leaves.

## P2.6 Event bus

Topics are partitioned by `relayId` so per-relay ordering is preserved — a pickup must never be
consumed after the trip that followed it. The producer is idempotent, the consumer commits offsets
only after a durable write, and anything unparseable goes to `event_dead_letter` rather than being
dropped. Silently discarding an event from a protection relay is how a real trip goes unrecorded.

`EVENT_BUS=direct` remains supported and is the right choice for a small site: batched HTTPS with a
bounded queue that sheds INFO-level events before it sheds a trip.
