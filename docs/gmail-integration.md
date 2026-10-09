# Workspace Gmail integration (COM-118)

## Connection and authorization boundaries

Gmail is a workspace integration, not an account sign-in provider. Only a signed-in workspace owner can begin a connection, and every workspace identifier is resolved through the existing membership/role guard. Workspace members may view the connected-account status but cannot connect or disconnect accounts. The callback has no caller-selected redirect URI or workspace: it uses the workspace and user bound to the one-time server-side OAuth state.

**Live authorization is disabled by default.** `GMAIL_OAUTH_ENABLED=true` is required before credentials activate the connection flow. Set it only after the organization explicitly approves the exact scopes below, workspace mailbox/consent rules, and the data handling policy. This code does not sync messages or store message bodies, and CI never contacts Google.

The authorization-code flow uses PKCE (`S256`), a 256-bit random `state`, a short-lived HttpOnly/SameSite=Lax browser-binding cookie, a ten-minute expiration, atomic single-use consumption, and a confidential-client secret held only in the server environment. The callback also requires the initiating authenticated user session and owner membership to remain active. The Google ID token is signature-verified against Google's fixed JWKS endpoint with an explicit issuer, client audience, RS256 algorithm, short maximum age, verified-email requirement, and one-time nonce binding. Failed, expired, cross-browser, cross-user, wrong-workspace, and replayed callbacks fail closed and return a generic error without exposing provider messages or credentials.

The requested scopes are exactly Gmail read-only access and OpenID Connect identity email:

- `email`
- `https://www.googleapis.com/auth/gmail.readonly`
- `openid`

Granted scopes are checked before activation; additional or missing scopes are rejected. The connector does not request Gmail send/modify permissions. Provider account `sub` and verified email are used only as connection identity; they are not accepted from the browser.

## Secrets and lifecycle

OAuth access and refresh tokens are encrypted with AES-256-GCM before PostgreSQL persistence. Each ciphertext uses a fresh random 96-bit nonce and authentication tag, with authenticated associated data binding it to its OAuth-state or workspace/account identity; the encryption key is separate from the database and OAuth client secret. The short-lived PKCE verifier is also encrypted, while state and browser-cookie values are stored only as SHA-256 hashes. Tokens, authorization codes, message content, and provider error bodies are not returned by integration APIs, included in audit metadata, or written to application logs.

Configure the Google OAuth client with this exact authorized redirect URI:

```text
https://<canonical-app-origin>/api/integrations/gmail/callback
```

Set these server-only environment variables:

```dotenv
GMAIL_OAUTH_ENABLED=false
GMAIL_CLIENT_ID=<Google OAuth client ID>
GMAIL_CLIENT_SECRET=<Google OAuth client secret>
INTEGRATION_ENCRYPTION_KEY=<base64 for exactly 32 random bytes>
```

Generate the encryption key with `openssl rand -base64 32`; store it in the deployment secret manager. Keep `BETTER_AUTH_URL` set to the canonical HTTPS origin so the callback URI is stable. Do not place these values in client bundles, browser storage, source control, job payloads, or logs. Replacing the encryption key without first decrypting and re-encrypting every connected credential makes those integrations unusable; the current envelope is versioned `v1`, but automatic key rotation is not implemented.

The current owner-only same-origin disconnect implementation first transitions the integration out of `CONNECTED`, then attempts Google token revocation. On confirmed revocation it clears the encrypted credential and expiry but retains the provider account identity and immutable audit history; if revocation cannot be confirmed, it keeps the encrypted credential in an unusable `REVOCATION_PENDING` state for a manual owner retry. This is a description of gated code, not an approved retention/deletion policy. Do not enable live authorization until the organization explicitly decides whether these identity, credential, and audit retention behaviors are acceptable. Automatic scheduled revocation retry is not implemented.

## Data boundary

The OAuth connection step does not fetch or persist mail content. It stores the provider account identity, granted scopes, token expiry, and encrypted credentials. The separate `source_message` table remains identity/timestamp-only. Message body, subject, sender, recipient, excerpt, and retention behavior are not introduced by this increment; see [source-message behavior](source-messages.md). Provider synchronization is a later story and must preserve that boundary until message retention is explicitly defined.

The integration audit table records connect, disconnect-request, failed-revocation-attempt, and completed-disconnect events with actor/workspace/integration identity and status only. It never stores tokens, authorization codes, email body content, or provider error payloads.

## Routes and verification

- `GET /api/workspaces/:workspaceId/integrations/gmail`: membership-protected, no-store connection summaries; never returns account subject or credentials.
- `GET /api/workspaces/:workspaceId/integrations/gmail/connect`: owner-only, same-origin OAuth start; redirects only to Google's fixed authorization endpoint.
- `GET /api/integrations/gmail/callback`: validates and consumes the browser-bound state, exchanges the code, verifies the granted scopes and Google account identity, encrypts the tokens, and returns to the fixed integration page.
- `POST /api/workspaces/:workspaceId/integrations/gmail/:integrationId/disconnect`: owner-only and same-origin; retries a pending provider revocation safely.

Unit tests cover key/config validation, authenticated encryption, fixed OAuth parameters, minimal scopes, signed OpenID-token issuer/audience/age/nonce validation, CSRF origin checks, and browser-cookie parsing. The PostgreSQL integration test exercises nonce/state/browser-token hashing, expiry, browser binding, state replacement, concurrent/replayed single-use consumption, encrypted credential persistence, tenant-scoped revocation transitions, and update/delete/truncate rejection for audit history using a real database. The auth integration suite verifies authentication, tenant/role isolation, configuration-disabled behavior, invalid callbacks, and CSRF rejection.

A live Google OAuth round-trip, provider token exchange, Gmail API synchronization, and confirmed remote revocation have not been externally verified unless a separately recorded environment with valid Google OAuth credentials and provider access is used. CI intentionally has no Google OAuth credentials and does not fabricate provider responses.
