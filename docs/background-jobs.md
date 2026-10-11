# Background job foundation (COM-115)

## Runtime boundaries

PostgreSQL is the durable source of truth for job state. `commitmentos.async_job` is also the dispatch outbox: enqueue first validates and inserts a workspace-scoped row with a stable idempotency key and correlation ID, then publishes only the job ID and correlation ID to BullMQ/Redis. If Redis is unavailable after the insert, the API can return an availability error without losing the durable row; a worker periodically republishes due `PENDING`, `QUEUED`, and `RETRYING` rows. Expired worker leases are recovered and eventually dead-lettered rather than left permanently `RUNNING`.

The Redis queue is transport and scheduling, not the product record. Redis messages contain identifiers only; bounded, validated payloads stay in PostgreSQL. Business handlers must remain idempotent because BullMQ provides at-least-once processing, not exactly-once external side effects. A workspace-scoped idempotency key cannot be reused with a different job kind or payload.

## Worker guarantees

- `JOB_MAX_ATTEMPTS` bounds retries. Transient, rate-limit, and timeout failures use capped equal-jitter exponential backoff; the same sampled delay is persisted in PostgreSQL and handed to BullMQ so queue retries cannot race ahead of the durable schedule. A valid provider retry delay is respected up to the 24-hour safety cap. Authentication, permanent, and unknown failures do not retry.
- Each job receives an `AbortSignal` and a database-enforced timeout/lease. Processors performing network I/O must pass the signal through and must not continue consequential work after abort.
- Permanent/exhausted jobs are persisted as `DEAD_LETTER` with a sanitized failure class/code and are also recorded in the BullMQ dead-letter queue. Raw provider error messages, credentials, and message bodies are not stored in job failure columns or worker logs.
- Structured worker logs carry job ID and correlation ID, never payloads. A Postgres heartbeat records worker readiness. `/api/health/live` reports process liveness; `/api/health/ready` reports PostgreSQL, Redis, and worker-heartbeat readiness and returns `503` if any dependency is unavailable.
- Workers recover due outbox rows at startup and periodically. A stale `RUNNING` job can be reclaimed only after its lease expires; retries still use the persisted attempt bound.

## Operations

Set `REDIS_URL` to a private Redis service; use `rediss://` and provider-managed authentication/TLS in shared environments. `JOBS_QUEUE_NAME`, `JOBS_QUEUE_PREFIX`, and the `JOB_*` settings tune concurrency, retries, timeouts, heartbeat, outbox recovery, and deadline-sweep cadence (`JOB_DEADLINE_SWEEP_INTERVAL_MS`). Run `npm run worker` as a separate process after applying database migrations. The web application can start without a worker, but readiness intentionally remains `503` until Redis and a fresh worker heartbeat are available.

The CI integration suite provisions real PostgreSQL and Redis services. It exercises idempotent concurrent enqueue, duplicate message delivery, replacement of failed Redis deliveries from the PostgreSQL outbox, actual BullMQ processing, correlation, jittered retry timing, rate-limit hints, transient retry exhaustion, timeout cancellation, permanent dead-letter persistence, worker restart after an expired-lease reclaim, overdue deadline scheduling, tenant scoping, lifecycle exclusions, batched updates, atomic system audit rollback, redacted structured logs, and readiness transitions. Local runs require both services; tests fail rather than silently skipping when either dependency is absent.

`PLATFORM_PROBE` remains an infrastructure operation that confirms a workspace row is readable. The worker also schedules `COMMITMENT_DEADLINE_SWEEP` for workspaces with commitments whose explicit due instant has passed. It transitions only `OPEN`, `DUE_SOON`, `WAITING`, or `BLOCKED` commitments to `OVERDUE`, matching the existing lifecycle graph; unconfirmed `DETECTED` rows, null deadlines, and future deadlines remain unchanged. A PostgreSQL transaction locks a bounded batch with `FOR UPDATE SKIP LOCKED` and commits each status mutation with an immutable `SYSTEM` `STATUS_CHANGED` audit event. The update is idempotent and tenant-scoped. `JOB_DEADLINE_SWEEP_INTERVAL_MS` defaults to 60 seconds, so stored status may lag the due instant by up to one sweep interval plus processing time.

No `DUE_SOON` threshold or reminder cadence, recipient, preference, or delivery channel is defined. This work does not send email or other notifications; keep reminders behind explicit product/consent rules and human approval. Provider sync/extraction and communication jobs remain disabled until their respective scopes and content-handling policies are approved.

## Internal metrics (COM-117 observability)

`GET /api/internal/metrics` exposes Prometheus text metrics for durable job counts by status, the number of workers with a fresh ready heartbeat, and the age of the oldest incomplete job. It is disabled with `404` unless `JOBS_METRICS_TOKEN` is configured; when enabled, it requires an exact `Authorization: Bearer …` header and returns `503` if configuration or PostgreSQL is unavailable. The endpoint reports aggregate values only—no workspace, job, correlation, payload, account, or provider identifiers—and always sends `Cache-Control: no-store`. Use a randomly generated URL-safe secret of at least 32 characters (for example, `openssl rand -hex 32`) and restrict the endpoint at the deployment network boundary; the bearer token is defense in depth, not a substitute for network isolation.
