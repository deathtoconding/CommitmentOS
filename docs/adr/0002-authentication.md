# ADR-0002: Authentication with Better Auth

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

COM-104 needs registration, email/password sign-in, logout, persistent sessions, and a protected application route. It must fit Next.js App Router and PostgreSQL/Drizzle without pulling workspace authorization or product workflows into the authentication increment.

## Decision

Use Better Auth 1.7.7 with its Drizzle adapter for server-side authentication and database-backed sessions. Use Zod 4 schemas at the auth route boundary and in the forms. Better Auth's built-in scrypt password hashing and session lifecycle are used rather than custom password or token code.

The app requires `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` at runtime; it does not fall back to a built-in secret. Development permits the local origin and the Arena preview host pattern. Production requires HTTPS for non-loopback origins. Session reads on the protected route bypass cookie cache and revalidate against the session store so logout takes effect immediately.

Email/password sign-up has `autoSignIn: false`. This produces no session during registration and allows Better Auth's generic duplicate-account response to reduce account enumeration. The user then signs in normally. Better Auth's built-in rate limit is enabled in production and tightened for sign-in/sign-up paths.

## Alternatives considered

- Custom password hashing/session implementation: rejected because it increases security-sensitive code and maintenance burden.
- NextAuth/Auth.js: Better Auth has a direct Next.js App Router integration, Drizzle adapter, and matching built-in email/password/session operations.
- Authentication plus workspace RBAC: deferred; workspace authorization belongs in COM-105/106.

## Consequences and limitations

- Auth records share the `commitmentos` PostgreSQL namespace and are covered by Drizzle migrations.
- Sessions are stateful in PostgreSQL and are authoritative on protected route access.
- Email verification and account recovery are not enabled because outbound email delivery is not configured.
- Production rate limiting uses Better Auth's default in-memory storage; horizontally scaled production should move rate-limit storage to a shared backend.
- The local example secret must never be reused in a deployed environment.
- No workspace membership, roles, or authorization policy is created here.
