# ADR-0001: Platform foundation

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

The repository had no application code or existing technology constraints. CommitmentOS needs a web application, durable relational data, testable database migrations, and room to add asynchronous integration processing without prematurely splitting services.

## Decision

Build a TypeScript modular monolith with Next.js App Router, PostgreSQL, Drizzle ORM/Drizzle Kit, npm, Vitest, ESLint, and Prettier. Keep integration and AI processing behind future module boundaries. Use Docker Compose only for local PostgreSQL; the web application and unit tests remain runnable without external services.

The application-owned tables will live in a dedicated PostgreSQL schema named `commitmentos`.

## Alternatives considered

- A custom Node API plus separate frontend: adds a deployable service before the product requires it.
- Microservices: unnecessary operational complexity for the MVP.
- A document database: the product has tenant-scoped relational entities and lifecycle history.
- Introducing Redis and a worker now: deferred until the asynchronous-processing stage needs it.

## Consequences

- One application can be developed and deployed as a unit while preserving domain boundaries.
- PostgreSQL migrations are explicit and reviewable.
- Local database-backed development requires Docker Compose or another PostgreSQL instance.
- Authentication was intentionally deferred from this foundation decision and is now implemented separately in [ADR-0002](0002-authentication.md). Workspace/product tables, queues, and external integrations remain follow-on increments.
