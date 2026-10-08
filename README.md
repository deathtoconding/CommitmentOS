# CommitmentOS

CommitmentOS turns business conversations into tracked commitments so teams can follow through on what they promised.

This repository is being built in dependency-ordered increments. The current increment establishes the application runtime, quality gates, and PostgreSQL foundation; product workflows and integrations are intentionally not implemented yet.

## Stack

- Node.js 22 and npm
- Next.js App Router, React, and TypeScript
- PostgreSQL with Drizzle ORM and Drizzle Kit migrations
- Vitest, ESLint, and Prettier

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- npm 10 or later
- Docker Compose and Docker, only if using the included local PostgreSQL service

## Local development

```bash
npm ci
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:check
npm run dev
```

The web application can be started without PostgreSQL until a database-backed workflow is introduced. Database commands require a reachable PostgreSQL instance configured through `DATABASE_URL`.

Open <http://localhost:3000> after the development server starts.

## Quality checks

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Database setup can be verified with `npm run db:migrate` and `npm run db:check`.

## Database migrations

Add application tables under `src/db/schema/`, then generate and review a migration:

```bash
npm run db:generate -- --name=describe-change
npm run db:migrate
```

The `commitmentos` PostgreSQL schema is reserved for application tables. Do not place credentials in source control; `.env.example` contains local-only development values.

## CI

The GitHub Actions workflow runs formatting, lint, TypeScript checks, unit tests, database migration/smoke checks against an ephemeral PostgreSQL service, and a production build.
