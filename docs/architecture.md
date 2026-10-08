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
  └── commitmentos schema (auth, workspace, and membership tables; product tables later)
```

## Boundaries

- Presentation code must not own business rules.
- Workspace APIs use the reusable session, membership, and role guards; owner-only membership mutations also recheck authorization within a transaction and serialize on the workspace row. Future tenant-owned APIs must authorize before accessing workspace resources.
- Provider-specific Gmail, Slack, and Calendar code will normalize into provider-neutral domain inputs.
- AI responses will be treated as untrusted and validated before domain use.
- Database access will be isolated behind the database/domain application boundary.
- Background work will not block HTTP requests.

## Foundation decisions

- Next.js App Router + TypeScript for a single web/API application.
- PostgreSQL as the persistent store.
- Drizzle ORM and Drizzle Kit for typed access and versioned migrations.
- npm as the package manager, with a committed lockfile.
- Vitest for fast unit tests; PostgreSQL-backed checks run separately in CI.
- Docker Compose provides a local PostgreSQL service without requiring it for frontend-only development.

See [ADR-0001](adr/0001-platform-foundation.md) for rationale and consequences.
