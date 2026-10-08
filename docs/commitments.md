# Commitment aggregate (COM-108)

COM-108 establishes persistence and the domain shape. COM-109 implements the domain transition service and lifecycle rules; the commitment API belongs to COM-110.

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

## Indexes

Indexes support workspace/status/due-date listing, workspace/owner lookup, and workspace/source-message lookup. The migration is `drizzle/0003_commitment_aggregate.sql`.
