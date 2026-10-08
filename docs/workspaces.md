# Workspaces and authorization (COM-105/106)

## Data model

- `commitmentos.workspace` stores a workspace name and creation timestamp.
- `commitmentos.workspace_member` joins a workspace to an existing Better Auth user. A user can have memberships in multiple workspaces.
- Membership roles are the database enum `OWNER` and `MEMBER`. Workspace creation assigns the creator `OWNER` in the same database transaction that creates the workspace.
- Both membership foreign keys are non-null and cascade on deletion. A unique constraint on `(workspace_id, user_id)` prevents duplicate membership. That composite index serves workspace lookups; a separate `user_id` index supports listing a user's memberships.

## Reusable authorization checks

`src/workspaces/authorization.ts` centralizes the authorization boundary:

- `requireSession(headers)` validates the Better Auth session and returns `401` when absent.
- `requireWorkspaceMember(headers, workspaceId)` checks membership and returns the authenticated session, membership, and workspace context. Unknown and non-member workspace IDs both return `404`.
- `requireWorkspaceRole(headers, workspaceId, allowedRoles)` builds on the membership check and returns `403` when a member lacks a required role.

Workspace API handlers use these guards instead of reimplementing session, membership, or role checks. Guard errors are generic and marked `private, no-store`.

## API

All endpoints require an authenticated Better Auth session and return `401 UNAUTHENTICATED` otherwise. Responses are marked `private, no-store`.

- `POST /api/workspaces` — accepts only `{ "name": "..." }`. The name is trimmed and must contain 1–100 characters. The server derives the owner from the session; client-supplied user or role fields are rejected. Returns `201` with the created workspace and `OWNER` role.
- `GET /api/workspaces` — lists only the caller's memberships and their workspaces.
- `GET /api/workspaces/:id` — retrieves a workspace only when the caller has a matching membership. Missing and non-member workspaces both return `404 NOT_FOUND` to avoid disclosing tenant existence.

There is no stored “current workspace” selection; clients retrieve a workspace by ID, and membership is checked on every request. Member invitations and membership changes are deferred to COM-107. COM-106 establishes reusable membership/role checks but does not add enterprise RBAC or administrative policy.

## Tenant-isolation invariant

The server gets the user ID from the authenticated session, never from request JSON. Workspace listing and lookup join `workspace_member` and filter by that user ID in the same query. A workspace ID supplied by a client is only a selector; it is never proof of access. Every future workspace-owned resource must use `requireWorkspaceMember` or `requireWorkspaceRole` before data access.
