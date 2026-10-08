# Authentication (COM-104)

## Local configuration

Copy `.env.example` to `.env`. For non-local environments, set:

- `BETTER_AUTH_SECRET`: unique random value with at least 32 characters; generate with `openssl rand -base64 32`.
- `BETTER_AUTH_URL`: canonical application origin; use HTTPS in production.
- `BETTER_AUTH_TRUSTED_ORIGINS`: optional comma-separated extra origins. Never populate it from an untrusted request header.
- `DATABASE_URL`: PostgreSQL connection URL.

Do not log, commit, or expose the auth secret, passwords, session cookies, or database credentials.

## Routes

- `/signup`: Zod-validated account registration.
- `/login`: Zod-validated email/password sign-in.
- `/api/auth/[...all]`: Better Auth API, with server-side Zod validation on email/password endpoints.
- `/app`: protected server-rendered route; reads the authoritative database-backed session and redirects to `/login` when absent or revoked.

Authentication answers **who is the user?** Workspace membership and tenant context are implemented separately in COM-105; COM-106 adds reusable membership and role checks, and COM-107 adds owner-only administration for existing registered accounts. Email invitations and enterprise RBAC remain out of scope. See [workspace behavior](workspaces.md).

## Test strategy

- `npm test`: fast unit tests for auth environment and Zod schemas.
- `npm run test:integration`: requires a migrated PostgreSQL database and a production build; launches a local Next server and checks registration, duplicate registration, valid/invalid login, authenticated/unauthenticated `/app`, logout, session invalidation, password hashing, and the COM-105 workspace membership and tenant-isolation APIs.
