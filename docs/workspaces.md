# Workspaces and authorization (COM-105–107)

## Data model

- `commitmentos.workspace` stores a workspace name and creation timestamp.
- `commitmentos.workspace_member` joins a workspace to an existing Better Auth user. A user can have memberships in multiple workspaces.
- Membership roles are the database enum `OWNER` and `MEMBER`. Workspace creation assigns the creator `OWNER` in the same database transaction that creates the workspace.
- `commitmentos.workspace_audit_event` records immutable workspace-creation and membership-administration events with an actor, target user, event type, timestamp, and minimized role details.
- Both membership foreign keys are non-null and cascade on deletion. A unique constraint on `(workspace_id, user_id)` prevents duplicate membership. That composite index serves workspace lookups; a separate `user_id` index supports listing a user's memberships.

## Reusable authorization checks

`src/workspaces/authorization.ts` centralizes the request authorization boundary:

- `requireSession(headers)` validates the Better Auth session and returns `401` when absent.
- `requireWorkspaceMember(headers, workspaceId)` checks membership and returns the authenticated session, membership, and workspace context. Unknown and non-member workspace IDs both return `404`.
- `requireWorkspaceRole(headers, workspaceId, allowedRoles)` builds on the membership check and returns `403` when a member lacks a required role.

Workspace API handlers use these guards instead of reimplementing session, membership, or role checks. Guard errors and successful workspace API responses are marked `private, no-store`.

## API

All endpoints require an authenticated Better Auth session and return `401 UNAUTHENTICATED` otherwise. JSON mutation bodies are streamed with a 256 KiB limit; oversized requests receive `413 PAYLOAD_TOO_LARGE`. Workspace IDs are treated only as selectors; access is established from the authenticated user and that workspace's membership.

- `POST /api/workspaces` — accepts only `{ "name": "..." }`. The name is trimmed and must contain 1–100 characters. The server derives the owner from the session; client-supplied user or role fields are rejected. Returns `201` with the created workspace and `OWNER` role.
- `GET /api/workspaces` — lists only the caller's memberships and their workspaces.
- `GET /api/workspaces/:id` — retrieves a workspace only when the caller has a matching membership. Missing and non-member workspaces both return `404 NOT_FOUND` to avoid disclosing tenant existence.
- `GET /api/workspaces/:id/members` — any workspace member can list the workspace's member account details and roles. The query is scoped to the authorized workspace.
- `POST /api/workspaces/:id/members` — `OWNER` only. Accepts `{ "email": "..." }` and adds an already-registered account whose email address is verified as `MEMBER`. Unknown and unverified accounts both return `404 USER_NOT_FOUND`; duplicate membership returns `409 ALREADY_MEMBER`. This increment does not send invitations or create pending invite tokens. Email-verification delivery is not implemented yet, so this guard intentionally fails closed until a verified enrollment flow exists.
- `PATCH /api/workspaces/:id/members/:userId` — `OWNER` only. Accepts `{ "role": "OWNER" | "MEMBER" }` and updates the selected member's role.
- `DELETE /api/workspaces/:id/members/:userId` — `OWNER` only. Removes the selected membership.

A member who attempts administration receives `403 FORBIDDEN`; unknown workspaces and target memberships return `404 NOT_FOUND`. The final `OWNER` cannot be demoted or removed (`409 FINAL_OWNER_REQUIRED`). Every owner-only mutation rechecks authorization inside a database transaction and locks the workspace row. Demotions and removals count owners before applying the change, serializing concurrent membership mutations so they cannot remove or demote the final owner.

## Immutable workspace-administration history

Workspace creation, member addition, role changes, and member removal append rows to `commitmentos.workspace_audit_event` in the same PostgreSQL transaction as the mutation. Events are attributed to the authenticated actor and identify the target user; details contain only roles and do not copy account emails or names. Foreign keys retain the referenced workspace and users, and database triggers reject update, delete, and truncate operations. If an audit insert fails, the corresponding workspace or membership mutation rolls back. The current application does not expose a workspace-audit read route or UI.

There is no server-trusted “current workspace” value. The COM-112 shell may carry the selected `workspaceId` in the page URL as a UI selector only; each `/app` server page resolves it against memberships queried for the authenticated session user. Unknown and non-member selections render the same not-found state, and changing the URL alone never grants access. App pages are dynamically rendered with `private, no-store` response headers; section navigation uses full document requests, and pages restored from the browser back-forward cache are reloaded, so a previous workspace's client data is not reused after switching. Workspace APIs continue to run their own membership guard on every request.

COM-112 adds an authenticated `/app` shell with Inbox, Commitments, Dashboard, Integrations, and Settings navigation, a server-populated active-workspace selector, account menu, responsive navigation, and loading/empty/error/success states. The shell story itself does not implement provider behavior or dashboard data. COM-113 adds a server-rendered commitment inbox that only queries the workspace resolved from the current session's membership and avoids rendering source excerpts or provider identifiers. COM-114's commitment detail route repeats server-side membership resolution before the workspace-scoped record lookup and renders only the read-only audit events for that commitment. Logout uses Better Auth to invalidate the session and then performs a full navigation to the public sign-in page. COM-107 implements existing-account membership management, but not invitation email, pending invitations, or broader RBAC policy.

## Tenant-isolation invariant

The server gets the user ID from the authenticated session, never from request JSON. Workspace listing and lookup join `workspace_member` and filter by that user ID in the same query. Member listings filter by the workspace returned from the membership guard. Membership mutations validate the actor's owner role again within their database transaction. Every future workspace-owned resource must use `requireWorkspaceMember` or `requireWorkspaceRole` before data access.
