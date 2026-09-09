# Observability and Reliability

> **Scope:** Application liveness/readiness, request correlation, bounded resources,
> safe operational diagnostics, and the remaining production monitoring gates.
> **Related:** [Testing](16-testing-architecture.md), [Deployment](12-deployment-architecture.md),
> [Recovery](15-error-handling-and-recovery.md).

## Health and readiness — implemented

`GET /api/health` remains the shallow liveness response
`{"status":"ok","service":"openslate-api"}`. The backend image checks liveness;
a database outage must not trigger restart storms.

`GET /api/ready` returns `200 {"status":"ready"}` or
`503 {"status":"not_ready"}`, always with `Cache-Control: no-store`.
It performs a read-only PostgreSQL probe using runtime credentials and a separate
one-connection pool. Checkout is bounded to 250 ms, connection to one second,
statement execution to 500 ms, and callers wait at most two seconds. One probe
may remain in flight after a caller times out; later requests share that probe
instead of creating replacement work. Resources are disposed at shutdown.

Readiness checks database reachability only. It does not prove schema compatibility,
runtime-role privileges, Auth availability, Realtime delivery, or backup health.
Priority 3 must separately verify these release prerequisites and wire readiness
to traffic admission. Neither endpoint is a public hosted monitoring deployment.

Sources: `backend/app/main.py`, `backend/app/core/readiness.py`,
`backend/tests/test_readiness.py`, `backend/tests/test_runtime_boundaries.py`.

## Correlation and logging — implemented

FastAPI generates a UUIDv7 request ID; incoming caller IDs are ignored. Application
success, domain errors, validation failures, database unavailability, and unexpected
errors return `X-Request-ID`. Failures rejected before application middleware are
outside that guarantee.

Next.js generates its own ID for BFF/session/callback requests, logs individual
backend attempts and their returned IDs, and forwards the final backend ID when
available. Transport/early errors use the Next.js ID. IDs are diagnostics only,
not authorization or mutation deduplication keys. Audit/security writers reuse
the request context; operation IDs retain their separate administrative meaning.

Backend and Next.js append structured JSON lines to their own `logs/YYYY-MM-DD.log`
files, using UTC timestamps and dates. Local defaults are `backend/logs` and
`frontend/logs`, including frontend standalone startup. Each process can override
its directory with server-only `LOG_DIR`; use an absolute path to avoid working
directory ambiguity. Both directories are excluded from Git and Docker build
contexts. New directories and files use private permissions where supported.

Entries include timestamps, severity, service, request ID, method, route template,
status/duration, and available fixed reason codes. These identify when an operation
happened, what ran, where it ran, and how it completed. Relevant events add operation
IDs or upstream names; frontend backend-attempt events retain both request IDs.
Raw request URLs/query values, bodies, cookies, credentials, SQL parameters, and
provider/exception payloads are excluded. Unknown endpoints use a fixed label.

Terminals show compact request summaries: time, severity, service, method, endpoint,
status, and duration. Client errors use warning severity and server errors use error
severity; failures retain diagnostic IDs and available reasons. Successful backend
health probes and frontend backend-attempt details stay in files. Next.js suppresses
its duplicate BFF/session/callback access lines; page/build output and warnings remain.
Backend Uvicorn access logging is disabled to avoid raw query logging.
Unexpected exceptions are caught at the application request boundary before the
server's generic traceback path.

Daily files append across restarts without renaming shared files. Writes are
synchronous and use local filesystem append semantics, without a background queue;
slow or network storage can delay logging. A write failure produces a rate-limited
safe terminal signal without changing the application response. Later events retry
the destination and announce recovery. Read-only containers need a writable
`LOG_DIR` mount. Daily splitting does not provide retention or a disk-space limit:
operators own collection, capacity, retention, and persistent storage. No historical
logs are automatically deleted, and no collector, metrics exporter, or tracing SDK
is added.

Sources: `backend/app/core/observability.py`, `backend/app/core/log_sink.py`,
`backend/app/core/middleware/request_context.py`, `frontend/src/lib/reliability.ts`,
`frontend/src/lib/server-logger.ts`, `frontend/src/lib/log-routes.ts`,
`frontend/src/lib/session-response.ts`, `frontend/src/app/bff/[...path]/route.ts`.

## Resource bounds — implemented application defaults

| Boundary | Default |
| --- | --- |
| API/BFF/session JSON request | 1 MiB; declared size plus incremental byte counting; 413 on overflow |
| Buffered BFF response | 8 MiB; controlled 502 rather than truncation |
| BFF/session deadline | 60 seconds, including request reads and provider work; abortable provider fetch |
| Application DB pool/process | 5 connections + 5 overflow, 5-second checkout |
| Runtime DB connection/statement | 3 seconds / 15 seconds |
| Backend Supabase HTTP stages | Explicit maximum 10-second stage settings, no retry |
| Backend image admission/keep-alive | 32 concurrent requests / 5 seconds |

These server-only settings are initial bounds, not a throughput guarantee or a
shared rate budget. Every backend process also reserves one readiness connection.
Priority 3 must budget all application processes, probes, administrative jobs,
and platform connections together.

A BFF timeout or oversized response may occur after a mutation commits. Clients
must inspect state/use existing reconciliation before resubmitting. The BFF retains
only its existing single refresh/replay following 401; there is no timeout or
5xx mutation replay. Historical audit responses may exceed the response cap;
operators must narrow the query or review the limit, never assume silent truncation.

## Failure and operation diagnostics — implemented, delivery not configured

Database failures, upstream failures, unexpected exceptions, and failed post-commit
Realtime invalidation emit safe diagnostics. Realtime remains best effort: its
failure does not reverse a committed domain transaction. SecurityEvent persistence
and ingestion failures log independently of the SecurityEvent database, avoiding
recursive event writes. High-impact durable-attempt requirements remain intact.

Run from `backend/`:

```sh
uv run python scripts/check_operational_health.py
```

The checker uses the runtime connection and a read-only transaction with a
five-second statement timeout. It reports at most 100 references, plus truncation,
for old unmatched attempts, partial outcomes, and excessive future clock skew.
It matches operation ID, producer source, and event type/stage; unrelated successes
cannot close an attempt. The grace period is five minutes using database time.
It emits no event metadata and performs no reconciliation or mutation.

- Exit **0**: no issue detected within implemented coverage.
- Exit **1**: operator attention required, including partial outcomes.
- Exit **2**: the check failed; visibility is unavailable.

Coverage is explicitly `backend_administrative_events_only`. Priority 4's Next.js
SecurityEvent producers remain absent; runtime diagnostic logs do not replace them.
A partial operation remains visible until its same-operation terminal state changes;
operator alert deduplication/acknowledgment belongs to the monitoring system.

## Mandatory production gates — not implemented by Priority 5

Before production traffic, Priority 3 must provide evidence of:

1. Private FastAPI/PostgreSQL, canonical scheme/Host and trusted client-address handling.
2. Non-bypassable aggregate rate and concurrency controls covering Next.js and FastAPI.
3. Schema/drift and runtime-role checks, connection budget, and readiness traffic gating.
4. Log collection, retention, an operator-owned checker schedule, and actual alert receipt
   for both attention and visibility failure, including monitoring-delivery failure.
5. Representative-volume query-plan/latency checks for the operation checker; a timeout
   is failed visibility, not a healthy report. Add indexes only on measured evidence.
6. Explicit acknowledgment of backend-only security-event coverage until Priority 4
   producers, Priority 3 server-only key delivery, and ingestion acceptance tests exist.

No scheduler, notification destination, shared limiter, or hosted monitoring stack
is installed here. The disposable full-stack CI gate verifies application behavior;
it cannot prove hosted network, secret, backup, or alert delivery controls.
