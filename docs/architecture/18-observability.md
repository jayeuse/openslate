# Observability

> **Scope:** Current application signals, operator checks, and monitoring limits.

## Application signals

FastAPI exposes `/api/health` as an API-process response; it does not check
dependencies. `/api/ready` returns a bounded, no-store snapshot with fixed component
states (`ready`, `unavailable`, or `not_configured`) and a `required` flag; see
[`main.py`](../../backend/app/main.py) and
[`readiness.py`](../../backend/app/core/readiness.py). The components are the
application PostgreSQL connection, Supabase Auth health, Supabase Storage health, SMTP
configuration, and ClamAV scanner readiness. Database, Auth, Storage, and SMTP are
required. Scanner readiness is required outside development and test, and optional in
those environments. Overall readiness is 200 only when every required component is
ready; otherwise it is 503.

SMTP readiness means the host, port, and sender address are configured; it does not
test email delivery. Scanner readiness requires a successful ClamAV engine probe and a
read-only observation of the scanner worker's existing PostgreSQL advisory lock. It
does not establish queue progress or successful processing of pending files. The
snapshot does not check application-schema compatibility, backups, restore behavior, or
production installation acceptance. A guarded production Compose rehearsal exercised
all-required readiness plus bounded Auth, Storage, and scanner failure/recovery paths.
That container-level evidence does not establish native Linux host boot/reboot behavior,
Windows operation, or whole-installation readiness for a customer deployment.

Requests receive an `X-Request-ID`.
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

Audited application ORM changes and security events are stored in PostgreSQL. They are
application records, not a centralized monitoring or metrics system. The file workflow
exposes durable queued, claimed, clean, rejected, and uncertain states for operational
recovery. SSE carries opaque client invalidations; it is neither an audit stream nor a
monitoring transport.

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

The repository does not provide centralized telemetry, alerting, backup freshness
reporting, a packaged-host diagnostics bundle, or a customer support export workflow.
`/api/ready` is a bounded component signal, not a full installation or release check.
Operators must monitor provider services, disk and volume capacity, SMTP delivery,
ClamAV definitions, worker queue progress, and backup repository/restore readiness
separately. No scheduled backup or hosted operations service is implemented.

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
