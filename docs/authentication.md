# Authentication (COM-104)

## Local configuration

Copy `.env.example` to `.env`. For non-local environments, set:

- `BETTER_AUTH_SECRET`: unique random value with at least 32 characters; generate with `openssl rand -base64 32`.
- `BETTER_AUTH_URL`: canonical application origin; use HTTPS in production.
- `BETTER_AUTH_TRUSTED_ORIGINS`: optional comma-separated extra origins. Never populate it from an untrusted request header.
- `DATABASE_URL`: PostgreSQL connection URL.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM`: authenticated email delivery for verification messages. Port 465 uses implicit TLS; all other supported ports require STARTTLS. `SMTP_TLS_CA` is an optional path to a private PEM CA bundle.

New accounts must verify their email before sign-in can establish a session. Verification links expire after 24 hours; a correct-password sign-in attempt can request a fresh link and is rate-limited. The application does not expose a user-editable verification flag. The login page displays a success notice only after the verification callback.

Do not log, commit, or expose the auth secret, SMTP credentials, passwords, session cookies, or database credentials.

## Routes

- `/signup`: Zod-validated account registration.
- `/login`: Zod-validated email/password sign-in.
- `/api/auth/[...all]`: Better Auth API, with server-side Zod validation on email/password endpoints.
- `/app`: protected server-rendered route; reads the authoritative database-backed session and redirects to `/login` when absent or revoked.

Authentication answers **who is the user?** Workspace membership and tenant context are implemented separately in COM-105; COM-106 adds reusable membership and role checks, and COM-107 adds owner-only administration for existing registered accounts. Email invitations and enterprise RBAC remain out of scope. See [workspace behavior](workspaces.md).

## Test strategy

- `npm test`: fast unit tests for auth environment and Zod schemas.
- `npm run test:integration`: requires a migrated PostgreSQL database, a production build, and OpenSSL; launches a local TLS-enabled SMTP fixture and Next server, captures and follows real Better Auth verification links, proves unverified sign-in and workspace enrollment are rejected, verifies that valid-link confirmation enables sign-in and membership, and checks duplicate registration, password hashing, session/logout, and tenant isolation.
