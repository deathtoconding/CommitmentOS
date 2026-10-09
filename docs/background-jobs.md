# Background job foundation (COM-115)

## Runtime boundaries

PostgreSQL is the durable source of truth for job state. `commitmentos.async_job` is also the dispatch outbox: enqueue first validates and inserts a workspace-scoped row with a stable idempotency key and correlation ID, then publishes only the job ID and correlation ID to BullMQ/Redis. If Redis is unavailable after the insert, the API can return an availability error without losing the durable row; a worker periodically republishes due `PENDING`, `QUEUED`, and `RETRYING` rows. Expired worker leases are recovered and eventually dead-lettered rather than left permanently `RUNNING`.

The Redis queue is transport and scheduling, not the product record. Redis messages contain identifiers only; bounded, validated payloads stay in PostgreSQL. Business handlers must remain idempotent because BullMQ provides at-least-once processing, not exactly-once external side effects. A workspace-scoped idempotency key cannot be reused with a different job kind or payload.

## Worker guarantees

- `JOB_MAX_ATTEMPTS` bounds retries. Transient, rate-limit, and timeout failures use exponential backoff (with an explicit, bounded provider retry delay when available); authentication, permanent, and unknown failures do not retry.
- Each job receives an `AbortSignal` and a database-enforced timeout/lease. Processors performing network I/O must pass the signal through and must not continue consequential work after abort.
- Permanent/exhausted jobs are persisted as `DEAD_LETTER` with a sanitized failure class/code and are also recorded in the BullMQ dead-letter queue. Raw provider error messages, credentials, and message bodies are not stored in job failure columns or worker logs.
- Structured worker logs carry job ID and correlation ID, never payloads. A Postgres heartbeat records worker readiness. `/api/health/live` reports process liveness; `/api/health/ready` reports PostgreSQL, Redis, and worker-heartbeat readiness and returns `503` if any dependency is unavailable.
- Workers recover due outbox rows at startup and periodically. A stale `RUNNING` job can be reclaimed only after its lease expires; retries still use the persisted attempt bound.

## Operations

Set `REDIS_URL` to a private Redis service; use `rediss://` and provider-managed authentication/TLS in shared environments. `JOBS_QUEUE_NAME`, `JOBS_QUEUE_PREFIX`, and the `JOB_*` settings tune concurrency, retries, timeouts, heartbeat, and recovery cadence. Run `npm run worker` as a separate process after applying database migrations. The web application can start without a worker, but readiness intentionally remains `503` until Redis and a fresh worker heartbeat are available.

The CI integration suite provisions real PostgreSQL and Redis services. It exercises idempotent concurrent enqueue, recovery from a durable pending outbox row, actual BullMQ processing, correlation, retry/backoff, timeout cancellation, failure classification, dead-letter persistence, and readiness. Local runs require both services; tests fail rather than silently skipping when either dependency is absent.

The initial `PLATFORM_PROBE` handler is an infrastructure operation that confirms a workspace row is readable. Provider sync, extraction, deadline, and communication jobs are added with their respective product workflows; this foundation does not claim those handlers exist.

## Internal metrics (COM-117 observability)

`GET /api/internal/metrics` exposes Prometheus text metrics for durable job counts by status, the number of workers with a fresh ready heartbeat, and the age of the oldest incomplete job. It is disabled with `404` unless `JOBS_METRICS_TOKEN` is configured; when enabled, it requires an exact `Authorization: Bearer …` header and returns `503` if configuration or PostgreSQL is unavailable. The endpoint reports aggregate values only—no workspace, job, correlation, payload, account, or provider identifiers—and always sends `Cache-Control: no-store`. Use a randomly generated URL-safe secret of at least 32 characters (for example, `openssl rand -hex 32`) and restrict the endpoint at the deployment network boundary; the bearer token is defense in depth, not a substitute for network isolation.
