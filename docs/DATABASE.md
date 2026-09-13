# Database Model — Simorgh Grid

PostgreSQL 16 (+ TimescaleDB extension when available). Migrations are plain numbered SQL files in
`db/migrations/`, applied in order by `db/migrate.ts` (no ORM migration DSL — this keeps the schema legible to
a DBA reviewing it directly, and keeps the door open to either Node or .NET backends per the spec's stated
options).

## Entity map

```
provinces ──< cities ──< projects >── customers
                              │
                              ├──< substations ──< switchgear ──< panels ──< breakers
                              │                                       │
                              │                                       └──< relays ──< protection_functions
                              │
                              ├──< events (hypertable)            relays ──< telemetry_samples (hypertable)
                              ├──< faults ──< fault_timeline_entries
                              │         └──< comtrade_records
                              ├──< alarms ──< alarm_comments
                              │         └── alarm_correlation_groups
                              ├──< work_orders ──< work_order_attachments / work_order_status_history
                              └──< project_health_scores

faults ──< ai_analyses ──< ai_recommendation_approvals
users ──< ai_chat_sessions ──< ai_chat_messages
users ──< notifications
audit_log (append-only, references users)
substations ──1:1── site_location_restricted   (access-controlled, see below)
```

## Why these choices

- **`overall_progress` is a generated column**, not application-computed, so it can never drift from the seven
  workstream progress fields — any client (web, mobile, a future BI tool) reading the row gets a consistent
  number.
- **`events` and `telemetry_samples` are TimescaleDB hypertables** (with a plain-Postgres fallback so local dev
  without the Timescale image still works — see migration 001). This is where the volume actually lives: 150+
  relays continuously reporting.
- **`faults` is a first-class table distinct from `events`**, matching the spec: an `event` is one line of SOE;
  a `fault` is the engineering object that groups the relevant events, carries acknowledgement/root-cause/
  resolution workflow state, and is what work orders and AI analyses attach to.
- **Money/precision fields use `NUMERIC`, not `FLOAT`**, because these are metered electrical quantities
  (current, voltage, frequency) feeding engineering decisions and reports — not chart-only approximations.
- **`is_demo_data` on every synthetic-data-bearing table** so a query, a report, or the UI can filter or badge
  demo rows and they can never be mistaken for live field data (spec §27).
- **Every enum is a real Postgres `ENUM` type**, not a free-text column, so invalid statuses are a constraint
  violation at write time, not a bug discovered in the UI.

## Location privacy (read this before adding any column)

`projects`, `substations`, and `events`/`faults` store `province_id` + `city_id` — foreign keys into small
reference tables — and **nothing more precise**. The only table permitted to hold `latitude`/`longitude`/
`address` is `site_location_restricted` (migration `011`), which:

- is 1:1 with `substations` (not projects, not relays — one restricted row per physical site),
- is never joined by any view or endpoint used by the map, dashboards, executive view, mobile app, or AI,
- requires the `location:read_precise` permission (`users.can_read_precise_location`), enforced in the API
  service layer, and
- has every read written to `audit_log`.

Do not add a coordinate or address column anywhere else. If a future feature seems to need one, it belongs in
`site_location_restricted` or a sibling access-controlled table, not on `projects`/`substations` directly.

## RBAC & data-access roles

Three Postgres roles (migration `013`) enforce the platform's core security invariant — **read vs. control
separation, and AI is advisory-only** — at the database layer, independent of any bug in application code:

| Role                     | Used by            | Access |
|--------------------------|---------------------|--------|
| `simorgh_api`            | Backend API          | Read/write on operational tables; append-only on `audit_log`; **no access** to `site_location_restricted` |
| `simorgh_ai_readonly`    | AI service            | `SELECT` only, everywhere except `site_location_restricted`, `refresh_tokens`, `users` |
| `simorgh_edge_gateway`   | Simorgh Edge Gateway   | `INSERT` on `events`/`telemetry_samples`; narrow `UPDATE` of relay/breaker status columns only — cannot touch faults, work orders, users, or restricted location, ever |

Application-level RBAC (`users.role`) is enforced by Express middleware (`apps/api/src/middleware/rbac.ts`) on
top of this — the DB roles are the last line of defense, not the only one.

## Seeding

`db/seed/generate-demo-data.ts` populates every table above with realistic, internally-consistent synthetic
data (§13 of `ARCHITECTURE.md`) and is idempotent — re-running it truncates and regenerates only rows flagged
`is_demo_data = true`, never touching real data a future integration might add alongside it.
