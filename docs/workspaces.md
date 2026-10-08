# Workspaces (COM-105)

## Data model

- `commitmentos.workspace` stores a workspace name and creation timestamp.
- `commitmentos.workspace_member` joins a workspace to an existing Better Auth user. A user can have memberships in multiple workspaces.
- Membership roles are the database enum `OWNER` and `MEMBER`. Workspace creation assigns the creator `OWNER` in the same database transaction that creates the workspace.
- Both membership foreign keys are non-null and cascade on deletion. A unique constraint on `(workspace_id, user_id)` prevents duplicate membership. That composite index serves workspace lookups; a separate `user_id` index supports listing a user's memberships.

## API

All endpoints require an authenticated Better Auth session and return `401 UNAUTHENTICATED` otherwise. Responses are marked `private, no-store`.

- `POST /api/workspaces` — accepts only `{ "name": "..." }`. The name is trimmed and must contain 1–100 characters. The server derives the owner from the session; client-supplied user or role fields are rejected. Returns `201` with the created workspace and `OWNER` role.
- `GET /api/workspaces` — lists only the caller's memberships and their workspaces.
- `GET /api/workspaces/:id` — retrieves a workspace only when the caller has a matching membership. Missing and non-member workspaces both return `404 NOT_FOUND` to avoid disclosing tenant existence.

There is no stored “current workspace” selection in this increment; clients retrieve a workspace by ID, and membership is checked on every request. Member invitations, membership changes, and full authorization policy are deferred.

## Tenant-isolation invariant

The server gets the user ID from the authenticated session, never from request JSON. Workspace listing and lookup join `workspace_member` and filter by that user ID in the same query. A workspace ID supplied by a client is only a selector; it is never proof of access. Future workspace-owned resources must follow the same membership boundary before COM-106 adds broader authorization rules.
