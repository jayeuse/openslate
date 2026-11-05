# Observability

> **Scope:** Current application signals, operator checks, and monitoring limits.

## Application signals

FastAPI exposes `/api/health` as an API-process response; it does not check
dependencies. `/api/ready` returns a bounded, no-store snapshot with fixed component
states (`ready`, `unavailable`, or `not_configured`) and a `required` flag; see
[`main.py`](../../backend/app/main.py) and
[`readiness.py`](../../backend/app/core/readiness.py). The components are the
application PostgreSQL connection, Supabase Auth health, Supabase Storage health, and SMTP
configuration. All four are required. Overall readiness is 200 only when every required component is
ready; otherwise it is 503.

`GET /api/system/status` ([`manage/health/`](../../backend/app/systems/manage/health/router.py))
gives the same readiness to every signed-in person of the bound organization (admin,
member, or guest; `get_current_user`). It names plain parts, not services: `data`
(database), `signing_in` (auth), `files` (storage), and `email` (smtp), always in that
order, each with `working`, `slow`, `not_working`, or `not_set_up`; a missing component
is `not_working`. A working timed part reads `slow` when the newest three stored samples,
all from the last four minutes, each took over one second; `not_working` always wins.
Email follows recorded send outcomes, never configuration alone: `not_set_up` without
SMTP configuration, `not_working` after a refused send in the last 24 hours that is newer
than the last accepted one, `working` after a send Auth accepted in the last 24 hours, and
`set_up` otherwise. The response also holds the application `version`, the UTC
`checked_at` time of the probe it used, the admin-only `organization` part (its
`storage_used_bytes` sums the bound organization's `ready` and `deleting` file sizes,
trash included until purged), and the installation owner's `installation` part (database
size from a sample at most 10 minutes old, and each worker as `running`, `not_seen`, or
`never_seen`: within 3 minutes for the in-app workers, 5 for the backup runner). Each
process probes
readiness at most once in 30 seconds and returns the cached snapshot with its original
check time until then, including the caller-timeout fallback; there is no bypass
([`service.py`](../../backend/app/systems/manage/health/service.py)). Concurrent misses
share readiness's one in-flight probe. The route ends its request transaction before
the probe and writes no audit row or security event. `/api/health` and `/api/ready` do
not use this cache and stay unauthenticated.

Each API process runs a [sampler](../../backend/app/systems/manage/health/worker.py)
thread (not in `ENVIRONMENT=test` unless `E2E_BACKGROUND_WORKERS` is on). At each UTC
minute plus up to 10 seconds it times the readiness parts inside the shared in-flight
probe (`get_timed_readiness_snapshot`), outside any transaction, and writes one
`system_health_samples` row while it holds a transaction advisory lock; another process
skips that minute. The table has no organization column. While the database refuses the
write, a process keeps up to 1,440 minutes in memory with data `not_working` and writes
them at its next lock win, skipping minutes already stored. Hourly, every process calls
`public.retain_system_health()`, a try-locked owner function that deletes samples and
server errors older than 30 days and server errors beyond the newest 50,000. The runtime
role can only read and insert samples and server errors.

`system_health_signals` holds six installation-wide times
([`signals.py`](../../backend/app/systems/manage/health/signals.py)): when the
record-trigger worker (lane 0), report scheduling, Comms jobs, and provider sign-out last
ran (at most one write a minute per process and worker), and when Auth last accepted or
refused an email. An invitation send records `email_accepted` on success and
`email_failed` on a 5xx or 429; a recovery request records only `email_failed`, and only
on an Auth 5xx, because Auth answers 200 for unknown emails too and an unauthenticated
caller can provoke 4xx and 429 answers. Each write uses its own
session, never raises, and changes no response. The backup runner keeps its own
`runner_last_seen_at`.

`GET /api/system/health-periods` returns the same answer to every signed-in person:
each run in the last 30 days when a part did not work or was slow (three samples or more),
newest first with runs still going first, in offset pages (default 5, at most 100), and
the oldest kept sample time. A run joins samples up to two minutes apart and is still
going while it reaches a newest sample at most three minutes old. Periods, Slow parts and
email outcomes come from a per-process history cache with a 60-second lifetime that holds
no organization data
([`history.py`](../../backend/app/systems/manage/health/history.py)).

The request middleware stores each 5xx response in `server_errors`
([`errors.py`](../../backend/app/systems/manage/health/errors.py)): the request ID, status,
method, route template, time, and the organization the request bound after its address
and MFA checks, never a body, header, query, person, or record value. It stores nothing
for the middleware's database-unavailable 503, nor for `/api/ready`. A process writes at
most 120 rows a minute and pauses for 30 seconds after a failed write; dropped rows are
counted in one `server_error_log_dropped` log line. Row security admits a bound
transaction's own organization and rows of no organization.

Two support files download as JSON attachments named
`slateops-diagnostics-<installation|organization>-YYYYMMDD-HHMMZ.json`, each with its
summary first, and write no audit row or security event. The installation owner's file
(`GET /api/system/diagnostics/installation`) holds the versions (application, schema
revision, PostgreSQL), database size, workers, each organization's file storage total,
30 days of samples, up to 1,000 periods, and up to 1,000 recent server errors with the 30-day
total. It reads each organization in its own bound session and then the errors of no
organization in an unbound one. An organization admin's file
(`GET /api/system/diagnostics/organization`) holds the application version, the periods,
the bound organization's storage, and that organization's own server errors only.

SMTP readiness means the host, port, and sender address are configured; it does not
test email delivery. The snapshot does not check application-schema compatibility, backups, restore behavior, or
production installation acceptance. A guarded production Compose rehearsal exercised
all-required readiness plus bounded Auth and Storage failure/recovery paths.
That container-level evidence does not establish native Linux host boot/reboot behavior,
Windows operation, or whole-installation readiness for a customer deployment.

Requests receive an `X-Request-ID`. Error JSON bodies repeat it as `request_id` (see
[Error Handling and Recovery](15-error-handling-and-recovery.md)).
[`observability.py`](../../backend/app/core/observability.py) emits application JSON
logs using an allowlist of event names and fields such as request ID, route template,
method, status, duration, operation ID, actor ID, upstream, and reason code. Exception
text, query values, credentials, connection strings, file paths, and file contents are
not included. Events distinguish HTTP failures, database availability, upstream
failures, invalidation delivery, security-event ingestion, operational checks, and SMTP
delivery failures; they are bounded diagnostics, not a complete service-health
inventory. The internal provider gateway logs omit request paths, query strings,
referrers, and headers so invitation tokens and provider keys are not written to those
access logs; see the [Supabase operations guide](../../infra/supabase/README.md).

Audited application ORM changes and security events are stored in PostgreSQL. Access
shows administrator Security Events and People session/activity monitoring; these are
application records, not centralized host telemetry or metrics. SSE carries opaque
client invalidations; it is neither an audit stream nor a monitoring transport.

Access Security configures separate session and security-event retention periods,
each defaulting to 365 days with strict 1–3650 day bounds. The
[identity worker](../../backend/app/systems/access/identity/provider_signout_worker.py)
has independent bounded maintenance passes for eligible terminal sessions and old
events; each deletion and its safe maintenance proof commit atomically. Event deletion
uses the narrow database-owned retention routine, preserving ordinary append-only
permissions. Durable per-user sign-in/activity history is independent of session cleanup.

## Administrative operation diagnostics

From `backend/`, `uv run python operations/check_operational_health.py`
([`check_operational_health.py`](../../backend/operations/check_operational_health.py))
checks administrative security events in a read-only transaction with a five-second
statement timeout. Resolve and verify the configured database target before running it.
The command reports unresolved, partial, or clock-skewed operations; it does not
reconcile them. Exit codes are `0` for no detected issue, `1` for operator attention,
and `2` when visibility is unavailable. Its coverage is administrative events, not
complete application or host health.

## Monitoring gaps

The repository does not provide centralized telemetry, alerting, or a packaged-host
diagnostics bundle. The support files above hold application diagnostics only, with no
host disk or log figures.
`/api/ready` is a bounded component signal, not a full installation or release check.
Operators must monitor provider services, disk and volume capacity, SMTP delivery,
and backup repository/restore readiness separately. Saved backup cadence/retention
and queued exports are implemented through the [bounded host runner](../../infra/supabase/RESTORE.md#run-the-installation-backup-policy)
when invoked. It installs no host scheduler; operators must arrange invocation.
Centralized backup freshness monitoring and a hosted operations service remain absent.

## Performance investigation

Use a separate disposable Supabase provider stack, application database, and private
Storage for seeding, workload tests, migrations, and plan inspection. Follow the
ownership checks in `backend/tests/supabase_runtime.py`; a loopback address or separate
schema alone does not establish isolation. Keep owner credentials out of application
processes and benchmark reports, and disable external delivery before synthetic
workloads.

Record the revision and working-tree changes, migration head, nonsecret configuration,
versions, dataset distribution, workload mix, concurrency, and cache conditions.
Separate first-call observations from repeated steady-state samples. Compare identical
fixtures and report variation, errors, and throughput alongside latency. Component
timing does not establish HTTP or production capacity; exercise the real authentication
and middleware path separately.

Count executed SQL with scoped SQLAlchemy engine listeners, removing them when
measurement ends. Cursor execution timing excludes later fetch/decoding and response
serialization, especially for streamed cursors. Measure whole-operation wall time and
profile Python allocations in separate samples so allocation tracing does not distort
reported latency. Do not log bind values or private record contents.

For representative generated SQL, retain `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` only
after verifying the disposable target. `ANALYZE` executes the statement; plain `EXPLAIN`
supplies estimates only. Inspect actual versus estimated rows, loop counts, filtered
rows, sorts/spills, and buffers. A sequential scan of a small table or most of a module
is not itself a defect. SQL plans also omit some client transfer, JSON decoding, and
response costs.

Evaluate indexes against the exact predicate, ordering, and distribution, plus write
overhead, storage, build locks, and overlap. Runtime-defined JSON fields do not imply
one index per field. A JSONB GIN index supports particular containment and existence
operators; it does not automatically accelerate arbitrary typed casts, sorting, or
aggregation. See the PostgreSQL [JSON indexing
documentation](https://www.postgresql.org/docs/17/datatype-json.html#JSON-INDEXING).

Retain rerunnable procedures, nonsecret fixture identities, before/after source hashes,
raw samples, and plans with the task's verification artifacts. Publish results
separately from this architecture guide. Test isolation and owning gates are described
in [Testing Architecture](16-testing-architecture.md).
