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
| `DUE_SOON`     | `OPEN`, `WAITING`, `BLOCKED`, `OVERDUE`, `COMPLETED`, `DISMISSED`     |
| `WAITING`      | `OPEN`, `DUE_SOON`, `BLOCKED`, `OVERDUE`, `COMPLETED`, `DISMISSED`    |
| `BLOCKED`      | `OPEN`, `DUE_SOON`, `WAITING`, `OVERDUE`, `COMPLETED`, `DISMISSED`    |
| `OVERDUE`      | `OPEN`, `DUE_SOON`, `WAITING`, `BLOCKED`, `COMPLETED`, `DISMISSED`    |
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

Request objects are strict: workspace, creator, timestamps, and status on creation are server-owned. Nullable owner, source, counterparty, deadline, confidence, and excerpt fields remain nullable; an assigned owner must be a member of that workspace. On update, callers cannot write lifecycle timestamps. Status changes are serialized against the stored row and must pass through `transitionCommitment`; invalid or same-state transitions return `409 INVALID_TRANSITION`. Completion requires `completionSignal: true` or completion evidence already stored before the transition request. Completion evidence submitted in the same request is not treated as pre-existing evidence. The service sets `completedAt`; it does not manufacture evidence. `DISMISSED` is the lifecycle alternative to deleting a record; there is no physical-delete endpoint.

The API does not add audit persistence, scheduling, deadline evaluation, AI extraction, or notifications.

## Indexes

Indexes support workspace/status/due-date listing, workspace/owner lookup, and workspace/source-message lookup. The migration is `drizzle/0003_commitment_aggregate.sql`.
