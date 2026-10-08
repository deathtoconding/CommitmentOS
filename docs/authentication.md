# Authentication (COM-104)

## Local configuration

Copy `.env.example` to `.env`. For non-local environments, set:

- `BETTER_AUTH_SECRET`: unique random value with at least 32 characters; generate with `openssl rand -base64 32`.
- `BETTER_AUTH_URL`: canonical application origin; use HTTPS in production.
- `BETTER_AUTH_TRUSTED_ORIGINS`: optional comma-separated extra origins. Never populate it from an untrusted request header.
- `DATABASE_URL`: PostgreSQL connection URL.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM`: authenticated email delivery for verification and password-reset messages. Port 465 uses implicit TLS; all other supported ports require STARTTLS. `SMTP_TLS_CA` is an optional path to a private PEM CA bundle.

New accounts must verify their email before sign-in can establish a session. Verification links expire after 24 hours. Each successful link is recorded by a SHA-256 digest in PostgreSQL and can be redeemed only once; the raw verification token is not stored. Concurrent redemption permits at most one request to succeed. A correct-password sign-in attempt can request a fresh link and is rate-limited. The application does not expose a user-editable verification flag. The login page displays a success notice only after the verification callback.

Use `/forgot-password` to request account recovery. The server sends a one-hour, database-backed reset link, returns the same response for existing and unknown addresses, consumes the token on reset, and revokes the user's existing sessions. Auth rate-limit counters are stored in PostgreSQL so limits are shared by application instances. Reset and verification pages/API responses are non-cacheable and use `Referrer-Policy: no-referrer` to reduce bearer-token leakage.

Do not log, commit, or expose the auth secret, SMTP credentials, passwords, session cookies, or database credentials.

## Routes

- `/signup`: Zod-validated account registration.
- `/login`: Zod-validated email/password sign-in, with a link to recovery.
- `/forgot-password`: account-recovery request form with enumeration-safe copy.
- `/reset-password`: single-use password update form; bearer tokens are removed from browser history after hydration.
- `/api/auth/[...all]`: Better Auth API, with server-side Zod validation on email/password endpoints and enforced token consumption/rate limiting.
- `/app`: protected server-rendered route; reads the authoritative database-backed session and redirects to `/login` when absent or revoked.

Authentication answers **who is the user?** Workspace membership and tenant context are implemented separately in COM-105; COM-106 adds reusable membership and role checks, and COM-107 adds owner-only administration for existing registered accounts. Email invitations and enterprise RBAC remain out of scope. See [workspace behavior](workspaces.md).

## Test strategy

- `npm test`: fast unit tests for auth environment, Zod schemas, and token hashing.
- `npm run test:integration`: requires a migrated PostgreSQL database, a production build, and OpenSSL; launches a local TLS-enabled SMTP fixture and Next server, captures and follows real Better Auth verification/recovery links, exercises expiry, concurrent redemption and replay rejection, compares known/unknown recovery responses, validates PostgreSQL-backed abuse limits and redirect rejection, proves unverified sign-in and workspace enrollment are rejected, and checks password/session revocation, duplicate registration, hashing, logout, and tenant isolation.
