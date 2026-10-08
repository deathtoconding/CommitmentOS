# Commitment aggregate (COM-108)

COM-108 establishes persistence and the domain shape only. Lifecycle rules, transitions, and the commitment API belong to COM-109 and COM-110 respectively.

## Workspace and user references

- Every commitment has a required `workspace_id` foreign key to `commitmentos.workspace`; deleting a workspace cascades its commitments.
- `owner_user_id` is nullable because responsibility may be unknown. When present it references an existing user; deleting that user clears the assignment rather than deleting the commitment.
- `created_by` is required and references the user who created the record. User deletion is restricted while they are the recorded creator so attribution is not silently lost.
- `source_message_id` is nullable and opaque in this increment because the source-message model is not yet present. It is indexed together with `workspace_id`; a future source-message model can define that relation.

## Unknown and extracted information

`commitment_text` and `normalized_action` are required, nonblank descriptions of the commitment. Counterparty name/email, due timestamp/timezone, confidence score, source excerpt, completion evidence, and completion timestamp are nullable. Missing owner, deadline, counterparty, or evidence remains unknown rather than being inferred or filled with defaults. Confidence, when present, must be between 0 and 1.

`due_at` and `completed_at` are timezone-aware timestamps. `due_timezone` separately records the intended local timezone when known. Completion fields are independent persistence fields; COM-108 does not infer or enforce completion transitions.

## Status and indexes

The PostgreSQL enum contains `DETECTED`, `OPEN`, `DUE_SOON`, `WAITING`, `BLOCKED`, `OVERDUE`, `COMPLETED`, and `DISMISSED`. New rows default to `DETECTED`. This default is only an initial persisted value; status transition rules are not implemented here.

Indexes support workspace/status/due-date listing, workspace/owner lookup, and workspace/source-message lookup. The migration is `drizzle/0003_commitment_aggregate.sql`.
