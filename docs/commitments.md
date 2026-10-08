# Commitment aggregate (COM-108)

COM-108 establishes persistence and the domain shape. COM-109 implements the domain transition service and lifecycle rules. COM-110 exposes the commitment aggregate through a workspace-scoped HTTP API.

## Workspace and user references

- Every commitment has a required `workspace_id` foreign key to `commitmentos.workspace`; deleting a workspace cascades its commitments.
- `owner_user_id` is nullable because responsibility may be unknown. When present it references an existing user; deleting that user clears the assignment rather than deleting the commitment.
- `created_by` is required and references the user who created the record. User deletion is restricted while they are the recorded creator so attribution is not silently lost.
- `source_message_id` is nullable and opaque in this increment because the source-message model is not yet present. It is indexed together with `workspace_id`; a future source-message model can define that relation.

## Unknown and extracted information

`commitment_text` and `normalized_action` are required, nonblank descriptions of the commitment. Counterparty name/email, due timestamp/timezone, confidence score, source excerpt, completion evidence, and completion timestamp are nullable. Missing owner, deadline, counterparty, or evidence remains unknown rather than being inferred or filled with defaults. Confidence, when present, must be between 0 and 1.

`due_at` and `completed_at` are timezone-aware timestamps. `due_timezone` separately records the intended local timezone when known. Completion fields are independent persistence fields; COM-108 does not infer or enforce completion transitions.

## Status lifecycle (COM-109)

The PostgreSQL enum contains `DETECTED`, `OPEN`, `DUE_SOON`, `WAITING`, `BLOCKED`, `OVERDUE`, `COMPLETED`, and `DISMISSED`. New rows default to `DETECTED`. All subsequent status changes pass through `transitionCommitment` in `src/commitments/lifecycle.ts`.

| Current status | Allowed next statuses                                                 |
| -------------- | --------------------------------------------------------------------- |
| `DETECTED`     | `OPEN`, `DISMISSED`                                                   |
| `OPEN`         | `DUE_SOON`, `WAITING`, `BLOCKED`, `OVERDUE`, `COMPLETED`, `DISMISSED` |
| `DUE_SOON`     | `WAITING`, `BLOCKED`, `OVERDUE`, `COMPLETED`, `DISMISSED`             |
| `WAITING`      | `OPEN`, `DUE_SOON`, `OVERDUE`, `COMPLETED`, `DISMISSED`               |
| `BLOCKED`      | `OPEN`, `DUE_SOON`, `OVERDUE`, `COMPLETED`, `DISMISSED`               |
| `OVERDUE`      | `COMPLETED`, `DISMISSED`                                              |
| `COMPLETED`    | None (terminal)                                                       |
| `DISMISSED`    | None (terminal)                                                       |

Same-state changes and every other unspecified transition are rejected. Moving to `COMPLETED` requires a caller-provided explicit completion signal or existing nonblank completion evidence; the service sets `completed_at` but does not create evidence or define its source. `DUE_SOON` and `OVERDUE` are explicit valid targets only; the lifecycle service does not inspect the clock or evaluate deadlines. Scheduling and automatic deadline evaluation belong to COM-135.

## Workspace-scoped API (COM-110)

All commitment API routes require an authenticated workspace member. Collection and item lookups are scoped by the workspace resolved through membership authorization; item lookups include both the authorized workspace ID and commitment ID, returning the same not-found response for missing and cross-workspace records. Workspace members may list, create, read, and update commitments.

| Method  | Route                                           | Behavior                                                                                                        |
| ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/workspaces/:id/commitments`               | List commitments for the authorized workspace, newest first.                                                    |
| `POST`  | `/api/workspaces/:id/commitments`               | Create in the authorized workspace; the server sets the creator and the database defaults status to `DETECTED`. |
| `GET`   | `/api/workspaces/:id/commitments/:commitmentId` | Read one commitment scoped to the authorized workspace.                                                         |
| `PATCH` | `/api/workspaces/:id/commitments/:commitmentId` | Update editable fields and optionally request a lifecycle transition.                                           |

Mutation JSON request bodies are capped at 256 KiB; larger payloads receive `413 PAYLOAD_TOO_LARGE`. Request objects are strict: workspace, creator, timestamps, and status on creation are server-owned. Nullable owner, source, counterparty, deadline, confidence, and excerpt fields remain nullable; an assigned owner must be a member of that workspace. On update, callers cannot write lifecycle timestamps. Status changes are serialized against the stored row and must pass through `transitionCommitment`; invalid or same-state transitions return `409 INVALID_TRANSITION`. Completion requires `completionSignal: true` or completion evidence already stored before the transition request. Completion evidence submitted in the same request is not treated as pre-existing evidence. The service sets `completedAt`; it does not manufacture evidence. `DISMISSED` is the lifecycle alternative to deleting a record; there is no physical-delete endpoint.

COM-110 itself adds no audit persistence, scheduling, deadline evaluation, AI extraction, or notifications; COM-111 adds the audit trail below.

## Immutable audit trail (COM-111)

API-created commitments receive a `CREATED` event. API updates persist `EDITED`, `REASSIGNED`, `DEADLINE_CHANGED`, `STATUS_CHANGED`, `CONFIRMED`, `DISMISSED`, `COMPLETED`, and `COMPLETION_EVIDENCE_RECORDED` events as applicable. The event types also reserve `FOLLOW_UP_GENERATED`, `APPROVED`, and `SENT` for later stories; no such events are fabricated before those workflows exist.

Each event records the workspace, commitment, authenticated actor, type, occurrence time, and structured details. The composite workspace/commitment foreign key prevents cross-tenant associations. All commitment updates and their audit records share one database transaction; failed event insertion rolls back the mutation. The migration does not backfill history for records created before COM-111. Event details record changed field names and relevant owner/deadline/status values, but do not duplicate commitment text, source excerpts, or completion-evidence contents.

PostgreSQL triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` on audit events. The workspace-scoped read endpoint is `GET /api/workspaces/:id/commitments/:commitmentId/audit-events`, available to workspace members. It uses a validated keyset cursor and a page size of 1–100 (default 50), and returns 404 for missing or cross-workspace commitments. The `0004_commitment_audit_events` migration also prevents deleting users, workspaces, or commitments referenced by immutable audit history.

## Commitment inbox (COM-113)

The authenticated `/app/inbox` page resolves the active workspace against memberships for the current server-verified session before querying commitments. It uses the authorized workspace ID rather than treating a query-string workspace ID or client state as authority. The list is ordered newest first by the existing workspace-scoped query. It presents the commitment/action text, lifecycle status, whether an owner is assigned, and the deadline when present; unknown deadlines and owners remain explicitly unknown. The inbox does not render source excerpts, provider message IDs, counterparty email addresses, completion evidence, or other message-body content. Empty workspaces receive a dedicated empty state, and the app's loading/error boundaries cover pending and failed loads.

Deadline display uses the stored IANA timezone when valid, including timezone-database daylight-saving transitions. If the stored timezone is missing or invalid, the exact instant is displayed in UTC; the UI does not infer a local timezone or deadline. Each list item opens the workspace-scoped detail route added in COM-114.

## Commitment detail (COM-114)

The authenticated `/app/commitments/:commitmentId` page resolves the requested workspace against memberships for the current server-verified session, then loads the record with both the authorized workspace ID and commitment ID. Missing, cross-workspace, and nonmember requests render the same generic not-found state. The page shows the stored commitment/action text, status, known owner/deadline/counterparty name, creation time, and a read-only audit timeline. It does not render source excerpts, provider message IDs, counterparty email, or completion-evidence contents. Audit history is scoped to the same workspace and commitment, ordered newest first, and uses a validated keyset cursor to load older events.

## Indexes

Indexes support workspace/status/due-date listing, workspace/owner lookup, and workspace/source-message lookup. The migration is `drizzle/0003_commitment_aggregate.sql`.
