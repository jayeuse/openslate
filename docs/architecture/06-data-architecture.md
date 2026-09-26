# Data Architecture

> **Scope:** Application-owned PostgreSQL schema, private file bytes, and schema delivery.

PostgreSQL is the sole relational datastore. FastAPI owns application data access; Alembic owns schema changes. The current vanilla PostgreSQL baseline is a new root revision for disposable development data and seeds the required `admin` and `member` roles.

## Ownership and roles

`openslate_owner` owns the database objects and runs migrations through `MIGRATION_DATABASE_URL`. `openslate_runtime` is the constrained login used through `DATABASE_URL`; provisioning is a separate bootstrap operation. `DATABASE_BOOTSTRAP_URL` is restricted to provisioning and never belongs in FastAPI settings, browser configuration, logs, or backups.

The application uses ordinary PostgreSQL ownership and grants. There are no managed schemas, row-level policies, or external identity foreign keys. FastAPI remains the domain authorization boundary.

## Identity and files

`users` is application-owned. Identity models add credentials, sessions, action tokens, and rate-limit buckets. Session and action-token state makes revocation, one-time links, refresh rotation, and password recovery enforceable in PostgreSQL.

Identity bucket cleanup selects at most 100 expired windows in timestamp order
under row locks. The `window_started_at` B-tree supports that cutoff and order;
the fingerprint primary key continues to serve per-budget lookups. Revision
[`38f146d6f952`](../../backend/migrations/versions/38f146d6f952_index_identity_rate_limit_cleanup_window.py)
adds only this index, preserving retention, admission and locking behavior.
Inserts and window resets maintain the additional index. Its ordinary
transactional build blocks writes to the bucket table while it runs, so plan
migration timing for the installation's table size and availability needs; a
local build duration is not a production downtime guarantee. See PostgreSQL's
[index build behavior](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

`files` stores metadata, object keys, scan state, and nullable `enc_version`. Private bytes are written under a server-only `FILES_STORAGE_ROOT`: quarantine before scanning and immutable ready objects after promotion. A file row alone never grants byte access.

OpenView persists owner-private Dashboards and widget configurations in [`dashboards` and `dashboard_widgets`](../../backend/app/systems/openview/dashboards/models.py), with a bounded refresh cadence on each Dashboard. [`openview_chart_preferences`](../../backend/app/systems/openview/charts/models.py) stores one versioned Chart configuration per user. These rows contain settings rather than materialized Record results; each data view queries authorized Records when rendered. The forward revisions [`7d08f4310c7b`](../../backend/migrations/versions/7d08f4310c7b_add_chart_preferences_and_dashboard_.py) and [`a1a581d48771`](../../backend/migrations/versions/a1a581d48771_complete_chart_preference_audit_foreign_.py) add the preference table, Dashboard checks, and audit foreign key.

## Record reads and projections

The shared Record query compiler retains bound JSONB filters, database sorting,
exact counts and offset pagination. Query, grouped/windowed results, CSV export
and report capture select Record metadata plus the requested top-level JSON
keys through `sandbox/records/query.py`. A correlated `jsonb_each` and
`jsonb_object_agg` projection keeps explicit JSON nulls and nested values while
omitting absent keys; an empty column selection returns an empty object. Filter
and sort fields need not be returned. See PostgreSQL's
[JSON functions](https://www.postgresql.org/docs/17/functions-json.html).

Filtered or searched interactive pages evaluate matching Record IDs once in a
materialized CTE, then reuse them for the exact total and ordered page in one
statement. Empty pages retain the total, including offsets beyond the last match.
The intermediate set contains all matching IDs, so its memory or temporary-file
cost grows with selectivity; it does not materialize full Record JSON. Unfiltered
pages retain their separate count and page queries. See PostgreSQL's
[CTE materialization rules](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION).

Projected rows are separate read values, never partially populated `Record`
entities in the session identity map. Report grouping can additionally select
its grouping field without changing the requested output columns. CSV and
report capture keep their independent repeatable-read transactions and existing
row/byte limits. Grouped aggregate snapshots fetch at most their bucket limit
plus one; this detects overflow and supplies the exact complete-result count
without running the grouping query again just to count it.

Relationship pages select joined metadata and archive flags without loading
Record JSON. Lifecycle field-purge planning uses the JSONB top-level key-existence
operator and selects matching Record IDs, including archived Records. Execution
still locks, replans and performs individual audited ORM mutations. These read
changes add no per-field indexes or materialized result cache; index selection
for dynamic fields still requires workload-specific query-plan evidence.

## Schema workflow

1. Change the registered SQLAlchemy model.
2. Generate and review an Alembic revision from `backend/`.
3. Apply `uv run alembic upgrade head` with the owner connection.
4. Run `uv run alembic check` and the disposable PostgreSQL integration path.

Do not edit an applied baseline or use SQLite as a substitute. Current development data is disposable; no importer is provided for earlier deployments.
