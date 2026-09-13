# Simorgh Grid — Operations Manual

**National Electrical Project & Protection Operations Center**
Version 0.2 (Phase 2) · Kavir Monitoring

---

## Contents

1. [What this system is, and what it deliberately is not](#1-what-this-system-is)
2. [Safety rules that govern everything](#2-safety-rules)
3. [Installing and starting the system](#3-installing-and-starting)
4. [Signing in, roles and what each role can do](#4-roles-and-access)
5. [The screens, one by one](#5-the-screens)
6. [Connecting a relay: the full onboarding procedure](#6-onboarding-a-relay)
7. [Protocol reference: choosing the right channel](#7-protocol-reference)
8. [Daily operating procedures](#8-daily-operating-procedures)
9. [Responding to a fault, end to end](#9-responding-to-a-fault)
10. [Using the AI assistant properly](#10-using-the-ai)
11. [Alarms: acknowledging, suppressing, escalating](#11-alarm-management)
12. [Work orders](#12-work-orders)
13. [Reports and exports](#13-reports)
14. [Administration](#14-administration)
15. [Troubleshooting](#15-troubleshooting)
16. [Maintenance and backups](#16-maintenance)
17. [Glossary](#17-glossary)

---

## 1. What this system is

Simorgh Grid is a **monitoring and management** platform. It gathers data from protection relays,
switchgear and SCADA systems across your projects, normalises everything into one event model, and
gives management, engineering and field teams a single place to see what is happening.

### What it does

- Tracks every electrical project from planning through to running, with progress and health scores.
- Monitors protection relays from any vendor over any of 30 communication protocols.
- Detects, records and correlates faults with millisecond-precision timelines.
- Retrieves and displays COMTRADE disturbance records.
- Provides AI-assisted root-cause analysis, always with the evidence behind it.
- Manages alarms, work orders and the engineering response.
- Keeps an immutable audit log of everything that happens.

### What it deliberately does not do

**It never controls anything.** It cannot open or close a breaker, change a protection setting,
change a setting group, or issue any command to any device. This is not a feature that was left for
later — it is enforced structurally in four independent places:

1. The driver interface (`packages/shared/src/relay-driver-v2.ts`) has no write, control or operate
   method. There is nowhere to put a control action.
2. Every protocol driver restricts itself at the protocol level: DNP3 can emit only READ and
   CONFIRM function codes; Modbus only the four read functions; the REST driver hard-codes the GET
   verb; the MQTT driver has no publish method; the SEL driver whitelists read commands and never
   escalates to the ACCESS level that control requires; TFTP sends only the read opcode.
3. The IEC 60870-5 ASDU module has no encoder for any command type. The only frame it can build is
   a station interrogation, which is a request for data.
4. The database roles enforce it: the AI service runs as `simorgh_ai_readonly`, which holds SELECT
   only. No prompt can talk its way past a missing GRANT.

**It never shows exact locations.** Province, city and general region only. No coordinates, no
addresses, no precise substation positions anywhere in the management interface, the map, the
mobile view, the event model, the AI corpus or the exports. Precise location data lives in one
table (`site_location_restricted`) that the application's own database role cannot read, and is
released only to explicitly authorised technical users.

---

## 2. Safety rules

These are not suggestions. Read them before operating the system.

| Rule | Why |
|---|---|
| The system is **read-only** toward all field equipment. | Any control path from a management network into protection equipment is a safety and security risk. If you need to operate plant, use the proper control system with its own interlocks and authorisation. |
| **AI output is advisory.** A recommendation is a suggestion for a named human role, never an instruction that executes. | An AI that could change a protection setting could de-energise a hospital feeder because of a misread pattern. |
| **Never connect a relay directly to the internet.** Relays sit on the OT network; the Edge Gateway is the only thing that crosses the boundary, and it connects outward only. | The backend never dials into a substation. Even a full compromise of the cloud service gives no route into the protection network. |
| **Check timestamp quality before trusting a sequence.** Entries marked *approximate* were stamped on arrival, not by the relay. | A Modbus-derived ordering can be seconds wrong. Concluding "the breaker opened before the trip" from gateway-stamped data will send you down the wrong path. |
| **A relay with only a Modbus path can miss short trips.** The system warns you about this on the Communications page. | Modbus has no event buffer. Anything shorter than the poll interval never happened as far as Modbus is concerned. |
| **Demo data is labelled.** Every synthetic record carries `is_demo_data = true` and the UI marks it. | Never let demonstration data be mistaken for field data in a report or a decision. |

---

## 3. Installing and starting

### Requirements

- Docker and Docker Compose (the simplest path), **or** Node.js 20+ and PostgreSQL 16.
- 4 GB RAM minimum for the full stack; 8 GB recommended with Kafka.

### Option A — Docker Compose (recommended)

```bash
cd D:\kavir_monitoring          # or wherever you placed the project
copy .env.example .env          # Linux/macOS: cp .env.example .env
```

Edit `.env` and set, at minimum:

```
POSTGRES_PASSWORD=<choose a strong password>
JWT_SECRET=<a long random string>
INGEST_TOKEN=<a long random string for gateways>
```

Then:

```bash
docker compose up -d
```

This starts PostgreSQL (with TimescaleDB), Redis, MinIO, runs the database migrations, seeds the
demo data, and starts the API and the web application.

Open **http://localhost:3000**.

### Option B — running locally without Docker

```bash
npm install
npm run build

# Point at your PostgreSQL instance
set DATABASE_URL=postgres://simorgh:password@localhost:5432/simorgh_grid

npm run db:migrate
npm run db:seed        # demo data — skip this on a real installation

npm run dev:api        # terminal 1 — API on :4000
npm run dev:web        # terminal 2 — web on :3000
```

### First sign-in

The seeded demo accounts all use the password `Demo@1234`. The login page offers them in a
dropdown. **Change or remove these before any real deployment.**

| Account | Role |
|---|---|
| `admin@simorgh.local` | ADMIN |
| `ceo@simorgh.local` | EXECUTIVE |
| `pm@simorgh.local` | PROJECT_MANAGER |
| `tech@simorgh.local` | TECHNICAL_MANAGER |
| `protection@simorgh.local` | PROTECTION_ENGINEER |
| `field@simorgh.local` | FIELD_SERVICE_ENGINEER |
| `viewer@simorgh.local` | VIEWER |

### Useful commands

```bash
npm run protocols          # print the full protocol catalogue as a table
npm run test:guardrails    # run the AI safety guardrail tests
npm run typecheck          # typecheck every workspace
npm run dev:gateway        # run the Edge Gateway in simulator mode
```

---

## 4. Roles and access

| Role | Sees | Can do |
|---|---|---|
| **VIEWER** | Dashboards, projects, faults, alarms (read only) | Nothing that writes |
| **FIELD_SERVICE_ENGINEER** | Everything a viewer sees, plus work orders assigned to them | Acknowledge faults, move work orders through field statuses |
| **PROTECTION_ENGINEER** | All technical detail, relay comms addresses, COMTRADE records, dead-letter queue | Acknowledge and assign faults, create and transition work orders, confirm root causes, approve AI recommendations |
| **PROJECT_MANAGER** | Projects, progress, work orders, alarms | Update project progress, create and assign work orders |
| **TECHNICAL_MANAGER** | Everything technical across all projects | All engineering actions, alarm suppression |
| **EXECUTIVE** | Executive dashboard, national view, summarised KPIs | Read only, plus report export |
| **ADMIN** | Everything, including the audit log, gateways and user management | All actions, user and gateway administration |

Two things are gated more tightly than the table suggests:

- **OT network addresses** (relay IP addresses, serial ports, link addresses) are visible only to
  ADMIN and PROTECTION_ENGINEER. For everyone else the Communications page redacts them. Handing
  out the addressable location of every protection relay is the network-layer equivalent of
  publishing the site coordinates.
- **Precise site locations** require a separate explicit authorisation beyond any role above.

---

## 5. The screens

### Overview (`/overview`)

The command-centre home screen. Auto-refreshes every 15 seconds.

- **KPI tiles**: total projects, running, critical, relays online/offline, open faults, active
  alarms, work orders in progress.
- **Fault trend chart**: fault counts over recent days, split by severity.
- **Attention list**: projects that need engineering intervention or field service.

Everything on this screen is clickable and drills through to the detail behind it.

### National Map (`/map`)

Projects grouped **Province → City → Project**. Each province card shows counts and aggregate
health; opening a city shows the projects there.

There are no pin markers and no coordinates. This is deliberate and is the single most important
privacy property of the system — see §2. If you need to dispatch a crew, the work order carries the
site contact and access details through the proper channel, not the map.

### Projects (`/projects`, `/projects/[id]`)

The list supports filtering by status, province, city and free-text search.

A project detail page shows:
- Status and the progress bars for each phase (engineering, manufacturing, FAT, installation,
  commissioning, SCADA integration, relay integration) plus the computed overall progress.
- Health score 0–100 and its history.
- The **full equipment hierarchy**: Substation → Switchgear → Panel → Breaker → Relay → Protection
  Functions, expandable to any depth.
- Work orders raised against the project.

### Relays (`/relays`, `/relays/[id]`)

Every protection relay with vendor, model, protocol, communication status and health.

Colour coding:

| Colour | Health | Meaning |
|---|---|---|
| Green | HEALTHY | Communicating, no active alarms, no recent trips |
| Yellow | WARNING | Minor issue — occasional comms degradation or a cleared alarm |
| Orange | ATTENTION | Repeated trips or a persistent alarm; needs an engineer to look |
| Red | CRITICAL | Active critical alarm, or a trip that has not been resolved |
| Grey | OFFLINE | Not communicating — you are blind to this relay |

A relay detail page shows live measurements, its protection functions with pickup settings and time
delays (read-only), trip and alarm history, and its communication paths.

### Faults (`/faults`, `/faults/[id]`)

The fault list filters by severity, resolution status, project, city and protection function.

A fault detail page is where most engineering work happens:

- **Fault record**: type, protection function that operated (with ANSI code), fault current,
  voltage, frequency, breaker status, trip status.
- **Fault timeline**: the millisecond sequence of what happened. Read §9 for how to interpret it,
  and note the *approximate* markers.
- **AI analysis panel**: press **Analyze** to generate a root-cause analysis, or read the existing
  one. Always expand the evidence.
- **COMTRADE waveform**: the disturbance record, when one was captured.
- **Actions**: acknowledge, assign to an engineer, raise a work order.

### Communications (`/comms`) — new in Phase 2

Five tabs:

1. **Relay comms health** — which relays are unreachable, and which have no redundant path. By
   default it shows only relays with a problem. This is the screen to check first each morning.
2. **Protocol catalogue** — all 30 supported protocols, what each can carry, and which are in use.
3. **Time synchronisation** — clock quality across the estate, and how many recent events have
   trustworthy timestamps. If this degrades, your fault timelines degrade with it.
4. **Gateways** — the Edge Gateway fleet, their versions and last contact. New gateways appear here
   awaiting approval.
5. **Ingest failures** — events that could not be stored. **This should normally be empty.** Any
   entry here means data from the field was not recorded, and needs investigating.

### Live Operations (`/live`)

A real-time WebSocket feed of events as they arrive. Use it during a disturbance or a commissioning
test.

### Alarms (`/alarms`)

Active alarms by priority, with correlation grouping — related alarms from one root cause are
collapsed together so a single gateway failure does not produce forty separate alarm rows.

### Work Orders (`/work-orders`)

The engineering workflow board, filterable by status.

### AI Assistant (`/ai`)

Simorgh Grid Copilot. See §10.

### Executive (`/executive`)

Management summary: portfolio health, delivery forecast, projects at risk, national fault rates.

### Administration (`/admin`)

Audit log, users, gateways, system configuration.

---

## 6. Onboarding a relay

This is the core commissioning procedure. Follow it in order.

### Step 1 — Establish where the relay sits

Confirm the relay is on the **OT network segment**, reachable by the Edge Gateway, and **not**
routable from the internet or the corporate network. If it is reachable from either, stop and fix
the network before continuing.

### Step 2 — Choose the communication protocol

Use this decision order. Prefer the highest option the relay actually supports:

1. **IEC 61850 (MMS + GOOSE)** — if the relay supports it, use it. MMS carries buffered reports so
   events survive a brief link outage; GOOSE gives millisecond trip signalling. Use both together:
   GOOSE for speed, MMS for detail and file transfer.
2. **IEC 60870-5-103** — the best legacy option for protection specifically. Its information
   numbers are standardised, so protection meaning does not depend on a vendor register map.
3. **DNP3** — good event support with unsolicited reporting and event classes.
4. **IEC 60870-5-104** — solid, widely deployed, millisecond CP56Time2a timestamps.
5. **Vendor protocol** (SEL ASCII, SPA-bus, Courier, EGD) — use when it gives you more than the
   generic options, which for SEL it does.
6. **Modbus** — last resort. See the warning in §2. Always pair it with a second path if the relay
   offers one.

Then add **auxiliary paths** wherever possible:
- **SFTP or IEC 61850 file services** for COMTRADE retrieval.
- **Syslog** for setting changes and failed logins — this is your OT security telemetry.
- **SNMP** on the switches and gateway in the path — this is what tells you whether a silent relay
  is a relay problem or a network problem.
- **NTP or PTP** for the site clock, so your fault timelines mean something.

### Step 3 — Assign a point-map profile

Only needed for semantically poor protocols (Modbus, DNP3, IEC 60870-5-101/104). IEC 61850 is
self-describing and needs no map.

Built-in profiles ship for Siemens SIPROTEC, ABB/Hitachi REx, Schneider MiCOM, SEL and GE Multilin.
They are **starting points taken from typical documentation, not guarantees for your specific
model and firmware.** Verify every address against the relay manual before commissioning.

To create or override a profile, add a row to `point_map_profiles`. The structure is:

```json
{
  "MODBUS_TCP": [
    { "address": 30001, "name": "current_A", "kind": "MEASUREMENT",
      "scale": 0.1, "unit": "A", "dataType": "UINT32", "registerTable": "INPUT" },
    { "address": 10010, "name": "overcurrent_trip", "kind": "PROTECTION_TRIP",
      "dataType": "BOOL", "registerTable": "DISCRETE_INPUT",
      "protectionFunction": "OVERCURRENT" }
  ]
}
```

`kind` must be one of: `MEASUREMENT`, `BREAKER_POSITION`, `PROTECTION_PICKUP`, `PROTECTION_TRIP`,
`DEVICE_HEALTH`, `SETTING_GROUP`, `COUNTER`.

**An unmapped address is ignored, never guessed.** Guessing what a register means is how monitoring
systems invent trips that never happened.

### Step 4 — Configure the path on the gateway

Add the relay to the gateway's site configuration with its paths ordered by preference:

```typescript
{
  relayId: 'THR-F01',
  relayCode: 'THR-F01',
  manufacturer: 'Siemens',
  model: 'SIPROTEC 5 7SJ82',
  pointMapProfileId: 'siemens-siprotec-generic',
  paths: [
    { pathId: 'thr-f01-goose', protocol: 'IEC61850_GOOSE', role: 'PRIMARY',
      addressing: { networkInterface: 'eth0', gooseControlBlock: 'THR-F01/LLN0.gcbTrip' },
      supervisionTimeoutSec: 10, enabled: true },
    { pathId: 'thr-f01-mms', protocol: 'IEC61850_MMS', role: 'PRIMARY',
      host: '10.20.30.11', port: 102,
      addressing: { logicalDevice: 'THR-F01', reportControlBlock: 'THR-F01/LLN0.BR.brcbEvents01' },
      pollIntervalMs: 15000, supervisionTimeoutSec: 60, enabled: true },
    { pathId: 'thr-f01-103', protocol: 'IEC60870_5_103', role: 'BACKUP',
      serial: { devicePath: '/dev/ttyS0', baudRate: 9600, dataBits: 8,
                parity: 'even', stopBits: 1, linkAddress: 1 },
      pollIntervalMs: 5000, supervisionTimeoutSec: 30, enabled: true },
    { pathId: 'thr-f01-sftp', protocol: 'SFTP', role: 'AUXILIARY',
      host: '10.20.30.11', port: 22,
      addressing: { comtradeDirectory: '/COMTRADE', username: 'relay' },
      supervisionTimeoutSec: 300, enabled: true }
  ]
}
```

**Credentials are never written into this configuration.** `credentialsRef` names a vault entry;
the secret is resolved at connection time.

### Step 5 — Validate before going live

Start the gateway. It validates every path and prints problems:

```bash
npm run dev:gateway
```

Fix everything it reports. A typical first run flags missing poll intervals, an unassigned point
map, or a relay left on a single Modbus path.

### Step 6 — Approve the gateway

A gateway registers itself on first contact but arrives **disabled**. Its events are refused until
an administrator enables it on **Communications → Gateways**. This is deliberate: an unknown
gateway should not be able to inject events into a protection monitoring system unreviewed.

### Step 7 — Confirm data is flowing

On **Communications → Relay comms health**, the relay should show connected paths and a recent
"last data" time. On **Live Operations**, you should see its events arriving.

Then verify the meaning, not just the connection: force a known condition (a test pickup during
commissioning) and confirm the event appears with the correct protection function. A relay that is
"connected" but whose register map is wrong is worse than one that is offline, because it looks
healthy while reporting nonsense.

---

## 7. Protocol reference

Run `npm run protocols` for the live table. Summary:

### IEC 61850 family — prefer these

| Protocol | Transport | Delivers | Notes |
|---|---|---|---|
| **MMS** | TCP :102 | Measurements, events, fault records, files, setting group | Buffered reports survive link outages. Needs a native stack bound. |
| **GOOSE** | Layer-2 multicast | Trip/status signals in ~4 ms | Not routable — gateway must be on the station bus VLAN. Needs `CAP_NET_RAW`. |
| **Sampled Values** | Layer-2 multicast | Digital CT/VT stream | Aggregated to RMS at the edge; raw samples never forwarded. Requires PTP. |
| **MMS file services** | TCP :102 | COMTRADE sets | Triggered by a record-available indication. |

### IEC 60870-5 family

| Protocol | Transport | Notes |
|---|---|---|
| **-104** | TCP :2404 | Fully implemented natively. CP56Time2a millisecond timestamps. Monitor direction only. |
| **-101** | Serial RS-485 | Serial ancestor of -104, same ASDU layer. |
| **-103** | Serial RS-485 | **Protection-specific.** Standardised information numbers mean vendor-independent protection semantics. Best legacy choice. |

### DNP3

| Protocol | Transport | Notes |
|---|---|---|
| **DNP3/TCP** | TCP :20000 | Class 0/1/2/3 polling plus unsolicited. Read function codes only. |
| **DNP3/serial** | Serial RS-485 | Same application layer, slower. |

### Modbus — use with care

| Protocol | Transport | Notes |
|---|---|---|
| **Modbus TCP** | TCP :502 | No timestamps, no event queue, no self-description. Events are gateway-stamped. |
| **Modbus RTU / ASCII** | Serial | As above, slower. |

### Modern IT

| Protocol | Transport | Notes |
|---|---|---|
| **OPC UA** | TCP :4840 | Signed and encrypted only. Subscription-based. |
| **MQTT / Sparkplug B** | TCP :8883 | TLS. Subscribe-only. Sparkplug adds explicit birth/death state. |
| **REST** | HTTPS | GET only, by construction. |
| **WebSocket** | WSS | Receive-only stream. |

### Vendor-proprietary

| Protocol | Vendor | Notes |
|---|---|---|
| **SEL ASCII / Fast Meter / Fast SER** | SEL | Rich: metering, sub-millisecond SER, event reports. Read commands whitelisted; never escalates to control access level. |
| **SPA-bus** | ABB | Older SPACOM/REF54x terminals. |
| **Courier** | Schneider MiCOM | K-Bus; may need a KITZ converter. |
| **EGD** | GE | Cyclic UDP, receive-only by nature. |
| **PROFIBUS DP** | Siemens | Via an Ethernet proxy. |

### Auxiliary — do not skip these

| Protocol | Purpose |
|---|---|
| **SNMP** | Health of the network path. Tells you whether a silent relay is a relay or network problem. SNMPv3 authPriv only. |
| **Syslog** | Relay setting changes, failed logins, firmware activity, self-test failures. Your OT security telemetry. |
| **SFTP / FTP / TFTP** | COMTRADE retrieval. SFTP preferred; FTP refused outside the OT segment; TFTP read opcode only. |
| **NTP / PTP** | Clock supervision. Without it your millisecond timeline is a guess. |

---

## 8. Daily operating procedures

### Morning check (5 minutes)

1. **Overview** — note critical projects and open fault count against yesterday.
2. **Communications → Relay comms health** — any relay you are blind to? Any that lost redundancy?
3. **Communications → Ingest failures** — must be empty. Anything here means data was lost.
4. **Alarms** — triage anything unacknowledged overnight.
5. **Work Orders** — anything overdue or stuck in one status.

### Weekly

- Review time-synchronisation health; a site drifting toward SECOND or GATEWAY_STAMPED needs its
  NTP/PTP source checked before it degrades your fault records.
- Review relays flagged as single-path and plan a second path where the relay supports one.
- Export the weekly fault and project reports for the management meeting.

### Monthly

- Review the audit log for setting changes observed on relays (`RELAY_SETTING_CHANGE_OBSERVED`).
  Every one should correspond to planned work. One that does not is a security incident.
- Check point-map profiles against any relay firmware upgrades performed that month.

---

## 9. Responding to a fault

### 1. Read the fault record first

Before anything else, check **whether a protection function operated**.

- **A protection function is named** (e.g. OVERCURRENT 50/51) → protection genuinely operated.
  Treat it as a real electrical event.
- **No protection function** → the relay stopped communicating. This is a communications or device
  problem, **not** a trip. Do not dispatch a crew to inspect healthy switchgear.

This distinction is the single most consequential judgement on this screen, and it is why the AI
analysis is checked against it independently before it is stored.

### 2. Read the timeline, respecting timestamp quality

A typical genuine trip sequence:

```
09:14:22.317   Overcurrent pickup (51P1) — IEC61850_GOOSE
09:14:22.483   Trip command issued          — IEC61850_GOOSE
09:14:22.541   Breaker opened               — IEC61850_MMS
09:14:22.559   Trip confirmed               — IEC61850_MMS
09:14:23.010   SCADA alarm raised
09:14:25.400   Engineer notified
```

Entries marked **approximate** were timestamped when they reached the gateway, not by the relay.
When two approximate entries are milliseconds apart, **their order tells you nothing.** The banner
at the top of the timeline warns you when any entry is affected.

### 3. Check the COMTRADE record

If a disturbance record was captured, look at the waveform. Fault current magnitude and shape
usually distinguish a genuine fault from a CT saturation artefact or a setting problem.

### 4. Run the AI analysis

Press **Analyze**. Read the probable cause, and then **expand the evidence**. See §10.

### 5. Decide and record

- Acknowledge the fault.
- Assign it to the right engineer.
- Raise a work order if field action is needed.
- When resolved, record the confirmed root cause. This matters beyond the paperwork: confirmed root
  causes are indexed into the AI knowledge base, so your engineers' conclusions improve future
  analyses.

---

## 10. Using the AI

Two AI surfaces, one engine.

### Simorgh Power Intelligence — fault root-cause analysis

On any fault page. Produces a summary, probable cause, confidence score, recommended action, and
the required engineer role.

### Simorgh Grid Copilot — the chat assistant (`/ai`)

Ask questions in plain language:

- "Which projects have the highest fault rate this month?"
- "Which relay has the most repeated trips?"
- "Which relay should I inspect first?"
- "Which cities have the highest number of faults?"
- "Which projects are at risk of delay?"
- "What happened in Isfahan today?"
- "Are these alarms related to one root cause?"

### How to use AI output responsibly

**Always expand the evidence.** The system is built so that every substantive conclusion cites the
data behind it. An analysis that cannot cite evidence is rejected by the system before you ever see
it — but you should still read what it did cite.

**Check the confidence and why.** Confidence is capped automatically when the underlying timestamps
are gateway-stamped, because a precise conclusion cannot be drawn from imprecise data.

**Check which engine answered.** The analysis records whether it came from the language model or
the deterministic rule engine. If a model answer was rejected by the safety validation, the
fallback reason is recorded and shown. A deterministic answer is not worse — it is more
conservative.

**The AI cannot act, and it will never tell you it has acted.** If output ever appears to claim it
changed a setting or operated a breaker, that output is rejected automatically. If you somehow see
such a claim, treat it as a defect and report it — the system cannot have done it.

**You remain responsible for the decision.** The AI recommends a role and an action. A qualified
human reviews, approves and performs it.

---

## 11. Alarm management

### Acknowledging

Acknowledging records that a human has seen the alarm. It does not resolve anything.

### Correlation

Alarms sharing a root cause are grouped. A failed gateway that silences twenty relays produces one
correlated group, not twenty independent alarms. Work the group, not the rows.

### Suppression

Suppression requires TECHNICAL_MANAGER or ADMIN, and always records who suppressed it, why, and
when. Use it for known maintenance, never to quieten something you have not understood.

### Escalation

Unacknowledged critical alarms escalate automatically on a timer through the notification channels
configured for the site.

---

## 12. Work orders

The workflow is fixed:

```
OPEN → ANALYSIS → ASSIGNED → FIELD_INSPECTION → REPAIR → TEST → VERIFIED → CLOSED
```

Every transition records who made it, when, and any note. A work order cannot skip to CLOSED
without passing through TEST and VERIFIED — a repair that was never tested is not a completed
repair.

Create work orders from a fault (they inherit the fault context) or standalone from the Work Orders
page.

---

## 13. Reports

Available from the Reports section and from most list screens:

- **Project status report** — progress, health, milestones. PDF or Excel.
- **Fault report** — faults in a period, by project/city/protection function. PDF, Excel or CSV.
- **Relay health report** — fleet condition, trip counts, comms availability.
- **Executive summary** — portfolio view for management.
- **Audit report** — who did what, for compliance.

Every export is watermarked when it contains demo data, and none of them contain precise locations.

---

## 14. Administration

### Users

Create, deactivate and assign roles. Deactivate rather than delete, so the audit trail stays
intact.

### Gateways

Approve new gateways, monitor their versions and last contact, disable a decommissioned one.

### Audit log

Immutable. The database grants allow INSERT and SELECT only — no UPDATE, no DELETE, for any
application role. Watch particularly for `RELAY_SETTING_CHANGE_OBSERVED`, which records a
protection setting change detected on a relay (usually made by someone at the relay itself, not
through this system).

### Configuration

Environment variables of note:

| Variable | Purpose |
|---|---|
| `EVENT_BUS` | `direct` (HTTP) or `kafka`. Use `kafka` for large fleets. |
| `KAFKA_BROKERS` | Broker list when using Kafka. |
| `INGEST_TOKEN` | Bearer token gateways authenticate with. |
| `REQUIRE_AUTH_FOR_READS` | Set `true` to require sign-in for all reads. **Recommended for production.** |
| `AI_LLM_BASE_URL`, `AI_LLM_MODEL`, `AI_LLM_API_KEY` | Language model endpoint. Leave unset to run the deterministic engine only. |
| `AI_EMBEDDING_BASE_URL`, `AI_EMBEDDING_MODEL` | Embedding endpoint for semantic retrieval. |
| `IEC61850_NATIVE_ADAPTER` | Path to the native IEC 61850 stack binding. |
| `SIMULATE` | Gateway simulator mode. Set `false` for real hardware. |

For an air-gapped utility deployment, point the AI variables at a model hosted inside your own
network. The system is built for that case: nothing about the AI path requires an external service.

---

## 15. Troubleshooting

### A relay shows OFFLINE

1. **Communications → Relay comms health** — is it every path or just one?
2. Check whether SNMP reported a network device restart or an interface down at the same time. If
   so, it is a network problem, not a relay problem.
3. Check whether syslog shows anything from the relay (if syslog still arrives, the relay is alive
   and only the primary protocol path is broken).
4. Check the path's `lastErrorMessage` on the relay's Communications tab.
5. If a backup path exists, confirm the system failed over to it — the active path is marked.

### Events are arriving but mean the wrong thing

Almost always a point-map problem on Modbus/DNP3/IEC 60870. Verify the register addresses against
the relay manual. Remember the built-in profiles are typical values, not guarantees for your
firmware.

### Timestamps look wrong or events appear out of order

Check **Communications → Time synchronisation**. If the site clock has drifted, fix NTP/PTP at the
site. Events already recorded keep their honest quality marking.

### Ingest failures are appearing

Open the entry and read the reason:

- *"contains forbidden location field"* — a gateway is sending coordinates. Fix the gateway
  configuration; this is a privacy defect.
- *"timestamp more than 5 minutes in the future"* — a relay clock is wrong.
- *"cannot resolve project/province/city"* — the relay is not registered in the system.
- *"unparseable message"* — version mismatch between gateway and backend.

### The API is not responding

Check the logs. The API is built so that a database error in one route cannot crash the process
(all route handlers wrap async errors), so a total outage usually means the database is unreachable
or the process was not started.

### The AI returns a deterministic answer when a model is configured

Expected behaviour when a model answer failed validation. The recorded `fallback_reason` says
which rule it broke. Common causes: the model produced no evidence citations, or it described a
communication-loss fault as a confirmed protection operation.

---

## 16. Maintenance

### Backups

Back up PostgreSQL daily:

```bash
pg_dump -h localhost -U simorgh simorgh_grid | gzip > simorgh_$(date +%F).sql.gz
```

Back up the object store (MinIO/S3) holding COMTRADE files on the same schedule. A fault record
without its waveform is much less useful a year later.

### Retention

Set retention deliberately. Typical utility practice:

| Data | Retention |
|---|---|
| Events | 2 years |
| Faults and timelines | 10 years |
| COMTRADE records | 10 years |
| Audit log | Indefinite |
| Telemetry samples | 1 year (downsample beyond) |

With TimescaleDB, use compression policies on `events` and `telemetry_samples` rather than deleting.

### Upgrades

1. Back up the database.
2. Stop the API and web services (gateways keep buffering — they retry and do not discard events).
3. `npm run db:migrate`.
4. Start the new version.
5. Confirm on **Communications → Gateways** that gateways reconnect and their buffered events flow.

Gateways and the backend are versioned independently on purpose: gateway fleets in a utility are
not upgraded in lockstep with the datacentre, and the event envelope carries a schema version so an
older gateway keeps working.

---

## 17. Glossary

| Term | Meaning |
|---|---|
| **ANSI code** | Standard device number for a protection function (50 instantaneous overcurrent, 51 time overcurrent, 87 differential, 21 distance, 50BF breaker failure). |
| **BRCB** | Buffered Report Control Block. IEC 61850 mechanism that retains events during a link outage. |
| **COMTRADE** | IEEE/IEC standard format for transient waveform (disturbance) records. |
| **GOOSE** | IEC 61850 layer-2 multicast messaging for fast peer-to-peer signals. |
| **IED** | Intelligent Electronic Device — a protection relay or similar. |
| **INF** | Information Number. Standardised protection semantics in IEC 60870-5-103. |
| **Merging unit** | Device digitising CT/VT signals into a Sampled Values stream. |
| **OT network** | Operational Technology network — the substation network, isolated from IT. |
| **Point map** | Table mapping protocol addresses to their meaning for a relay model. |
| **PTP / IEEE 1588** | Precision Time Protocol, sub-microsecond clock synchronisation. |
| **SER** | Sequential Events Recorder. |
| **Setting group** | One of several stored protection setting sets in a relay. This system reads which is active; it never changes it. |
| **stNum / sqNum** | GOOSE state and sequence numbers. A stNum jump means a missed state change. |
| **Unified Event Model** | The normalised event shape every protocol is translated into. |

---

*Simorgh Grid — Kavir Monitoring. This manual covers Phase 2. Nothing in this system controls
electrical plant; nothing in it exposes a precise site location.*
