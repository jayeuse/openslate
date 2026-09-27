# Data Architecture

> **Scope:** OpenSlate's application schema in self-hosted Supabase PostgreSQL, provider-schema ownership, private file bytes, and schema delivery.

Supabase Database is PostgreSQL and the sole relational datastore. Supabase initializes and owns provider schemas; OpenSlate uses the `public` schema for application tables. FastAPI owns application data access, and Alembic owns application schema changes only. The active Alembic lineage starts at the fresh-install root [`c4ec36fc30cc`](../../backend/migrations/versions/c4ec36fc30cc_self_hosted_supabase_application_.py), which requires that no existing `public` relations be owned by `openslate_owner` except `alembic_version`. Earlier vanilla PostgreSQL revisions remain archived under [`backend/migrations/history/vanilla_postgresql`](../../backend/migrations/history/vanilla_postgresql/); the current lineage does not import an existing installation.

## Ownership and roles

`openslate_owner` owns OpenSlate application objects and runs migrations through `MIGRATION_DATABASE_URL`. `openslate_runtime` is the constrained login used through `DATABASE_URL`; `openslate_app` supplies its application privileges. An operator uses the provider's `supabase_admin` account through `DATABASE_BOOTSTRAP_URL` only for guarded role and privilege provisioning. Keep that bootstrap connection out of the API, worker, frontend, and normal runtime configuration. Supabase retains ownership of the database and its provider schemas; OpenSlate does not transfer them to its application owner.

Application tables use ordinary PostgreSQL ownership and grants. OpenSlate does not use provider RLS to reproduce application role, group, or domain policy. The one provider-table exception supports immediate Auth-session liveness: `openslate_app` receives `USAGE` on `auth` and `SELECT` only on `auth.sessions.id` and `auth.sessions.user_id`, constrained by the operator-owned `openslate_session_liveness` SELECT policy. It has no Auth table-wide read or mutation grant. Supabase Data API routes for OpenSlate application tables are blocked. Alembic reflection is limited to application-owned `public` objects by [`application_migration_scope`](../../backend/app/core/database/migration_scope.py), leaving provider objects outside its schema authority.

## Identity and files

`users` is application-owned and retains the OpenSlate UUID used by application relationships and audit actors. Its nullable unique `supabase_user_id` explicitly binds an eligible local profile to a Supabase Auth subject; it is not a foreign key into the provider-owned `auth` schema. Application `identity_sessions` retain local expiry, CSRF digest, immediate revocation, and provider user/session IDs. Each session stores the digest of an opaque refresh handle and the encrypted current provider access/refresh token pair. OpenSlate rate-limit buckets remain application data. Password hashes, provider email-action tokens, and provider Auth users belong to Supabase Auth rather than an OpenSlate password/action-token table.

Identity bucket cleanup selects at most 100 expired windows in timestamp order
under row locks. The `window_started_at` B-tree supports that cutoff and order;
the fingerprint primary key continues to serve per-budget lookups. Revision
[`38f146d6f952`](../../backend/migrations/history/vanilla_postgresql/38f146d6f952_index_identity_rate_limit_cleanup_window.py)
is part of the archived vanilla PostgreSQL history; the fresh-install Supabase lineage includes the current model state directly.
Inserts and window resets maintain the additional index. Its ordinary
transactional build blocks writes to the bucket table while it runs, so plan
migration timing for the installation's table size and availability needs; a
local build duration is not a production downtime guarantee. See PostgreSQL's
[index build behavior](https://www.postgresql.org/docs/17/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

`files` stores application metadata, immutable object keys, scan state, and nullable `enc_version`. File bytes are stored in the private Supabase Storage `openslate-quarantine` and `openslate-ready` buckets, accessed through the server-only Storage API adapter. FastAPI authorizes upload, download, and deletion; the OpenSlate worker scans quarantined bytes with ClamAV before promotion and makes a clean verdict durable before download is allowed. A file row or guessed object key alone never grants byte access. There is no selectable local-filesystem storage adapter.

OpenView persists owner-private Dashboards and widget configurations in [`dashboards` and `dashboard_widgets`](../../backend/app/systems/openview/dashboards/models.py), with a bounded refresh cadence on each Dashboard. [`openview_chart_preferences`](../../backend/app/systems/openview/charts/models.py) stores one versioned Chart configuration per user. These rows contain settings rather than materialized Record results; each data view queries authorized Records when rendered. The historical revisions [`7d08f4310c7b`](../../backend/migrations/history/vanilla_postgresql/7d08f4310c7b_add_chart_preferences_and_dashboard_.py) and [`a1a581d48771`](../../backend/migrations/history/vanilla_postgresql/a1a581d48771_complete_chart_preference_audit_foreign_.py) describe the earlier vanilla PostgreSQL evolution. The fresh-install Supabase baseline already includes the current preference table, Dashboard checks, and audit foreign key.

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
3. Apply `uv run alembic upgrade head` against the admitted Supabase installation with `MIGRATION_DATABASE_URL` as `openslate_owner`.
4. Run `uv run alembic check`; reflection covers application-owned objects and excludes Supabase provider schemas.

Do not edit an applied baseline or use SQLite as a substitute. The new lineage is for fresh installations. No importer is provided for earlier vanilla PostgreSQL application data, Auth accounts, or local filesystem files.
