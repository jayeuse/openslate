# Observability

> **Scope:** Current signals and limits.

FastAPI provides bounded readiness checks, request identifiers, and allowlisted structured operational logs. Audit rows capture application ORM changes. Security events capture relevant local identity operations. Logs and events must not include passwords, cookie values, bearer tokens, connection strings, file paths, or file contents.

File and scanner signals distinguish queued, claimed, clean, rejected, and uncertain states. SSE uses opaque invalidation signals; it is not an audit stream or monitoring transport. Caddy can provide gateway logs when its disabled `gateway` profile is explicitly started for a production preview, deployment, or production-level acceptance; it is not started in daily development.

The repository does not establish centralized telemetry, packaged-host diagnostics, alerting, backup freshness reporting, or a customer support export workflow. The future installer design requires explicit consent before diagnostic export or support upload.

## Administrative operation diagnostics

From `backend/`, `uv run python operations/check_operational_health.py` checks
administrative security events in a read-only transaction with a five-second
statement timeout. Resolve and verify the configured database target before
running it. The command reports unresolved, partial or clock-skewed operations;
it does not reconcile them. Exit codes are `0` for no detected issue, `1` for
operator attention and `2` when visibility is unavailable. Its coverage is
backend administrative events, not complete application or host health.

## Performance investigation

Use a separate disposable PostgreSQL instance and storage for seeding, workload
tests, migrations and executing plans. Follow the runner's ownership checks in
`backend/tests/postgres_runtime.py`; a loopback address or separate schema does
not establish isolation. Keep owner credentials out of application processes
and benchmark reports. Inspect worker startup and disable external delivery
before executing synthetic workloads.

Record the revision and working-tree changes, migration head, nonsecret
configuration, versions, dataset distribution, workload mix, concurrency and
cache conditions. Separate first-call observations from repeated steady-state
samples. Compare identical fixtures and report variation, errors and throughput
alongside latency. Component timing does not establish HTTP or production
capacity; exercise the real authentication and middleware path separately.

Count executed SQL with scoped SQLAlchemy engine listeners, removing them when
the measurement ends. Cursor execution timing excludes later fetch/decoding and
response serialization, especially for streamed cursors. Measure whole-operation
wall time and profile Python allocations in separate samples so allocation
tracing does not distort reported latency. Do not log bind values or private
record contents.

For representative generated SQL, retain `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
only after verifying the disposable target. `ANALYZE` executes the statement;
plain `EXPLAIN` supplies estimates only. Inspect actual versus estimated rows,
loop counts, filtered rows, sorts/spills and buffers. A sequential scan of a
small table or most of a module is not itself a defect. SQL plans also omit some
client transfer, JSON decoding and response costs.

Evaluate indexes against the exact predicate, ordering and distribution, plus
write overhead, storage, build locks and overlap. Runtime-defined JSON fields do
not imply one index per field. A JSONB GIN index supports particular containment
and existence operators; it does not automatically accelerate arbitrary typed
casts, sorting or aggregation. See the PostgreSQL
[JSON indexing documentation](https://www.postgresql.org/docs/17/datatype-json.html#JSON-INDEXING).

Retain rerunnable procedures, nonsecret fixture identities, before/after source
hashes, raw samples and plans with the task's verification artifacts. Publish
results separately from this architecture guide. The owning integration gate
and database guards are described in [Testing Architecture](16-testing-architecture.md).
