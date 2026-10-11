# Architecture baseline

## Current architecture

CommitmentOS starts as a modular monolith. The Next.js application is the web runtime and will host the user interface and application API. PostgreSQL is the durable system of record. Long-running ingestion and AI work will be introduced through background workers in a later stage; it is not part of this foundation increment.

```text
Browser
  │
  ▼
Next.js application
  │
  ├── Auth UI and Better Auth route handler
  ├── workspace APIs using reusable session/membership/role guards
  └── Drizzle database adapter

PostgreSQL
  ├── commitmentos schema (auth, workspace, membership, commitments, source-message identity metadata, and durable job/outbox state)
  └── source of truth for job idempotency, status, retries, leases, and worker heartbeats

Redis / BullMQ
  └── transport and delayed retry scheduling; messages contain job/correlation IDs only

Background worker (separate process)
  ├── claims workspace-scoped durable jobs from PostgreSQL
  ├── applies bounded retries, backoff, timeouts, and dead-letter handling
  └── publishes readiness through a PostgreSQL heartbeat
```

## Boundaries

- Presentation code must not own business rules.
- Commitment domain types are independent of persistence; the Drizzle schema maps them to PostgreSQL enums and workspace-scoped tables.
- Workspace APIs use the reusable session, membership, and role guards; owner-only membership mutations also recheck authorization within a transaction and serialize on the workspace row. Future tenant-owned APIs must authorize before accessing workspace resources.
- Provider-specific Gmail, Slack, and Calendar code will normalize into provider-neutral domain inputs.
- AI responses will be treated as untrusted and validated before domain use.
- Source-message identity is tenant-scoped and content-free in the current persistence model; message bodies require a separately approved retention and protection policy before they can be stored.
- Database access will be isolated behind the database/domain application boundary.
- Background work will not block HTTP requests.

## Foundation decisions

- Next.js App Router + TypeScript for a single web/API application.
- PostgreSQL as the persistent store.
- Drizzle ORM and Drizzle Kit for typed access and versioned migrations.
- npm as the package manager, with a committed lockfile.
- Vitest for fast unit tests; PostgreSQL-backed checks run separately in CI.
- Docker Compose provides local PostgreSQL and Redis services without requiring them for frontend-only development.
- PostgreSQL is the durable background-job outbox/source of truth; BullMQ/Redis only transports due work and schedules retries. Workers are separate processes with readiness heartbeats.

See [ADR-0001](adr/0001-platform-foundation.md) for rationale and consequences.
