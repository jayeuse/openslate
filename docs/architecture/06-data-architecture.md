# Data Architecture

> **Scope:** OpenSlate's application schema in self-hosted Supabase PostgreSQL, provider-schema ownership, private file bytes, and schema delivery.

Supabase Database is PostgreSQL and the sole relational datastore. Supabase initializes and owns provider schemas; OpenSlate uses the `public` schema for application tables. FastAPI owns application data access, and Alembic owns application schema changes only. The active fresh-install root [`089c54b88aa6`](../../backend/migrations/versions/089c54b88aa6_schema_redesign_fresh_root.py) requires that no existing `public` relations be owned by `openslate_owner` except `alembic_version`. The prior Supabase baseline and schema-redesign revisions are preserved unchanged under [`history/schema_redesign`](../../backend/migrations/history/schema_redesign/); earlier vanilla PostgreSQL revisions remain under [`history/vanilla_postgresql`](../../backend/migrations/history/vanilla_postgresql/). Neither archive is active. This root does not import an existing installation; never stamp an existing database onto it.

## Ownership and roles

`openslate_owner` owns OpenSlate application objects and runs migrations through `MIGRATION_DATABASE_URL`. `openslate_runtime` is the constrained login used through `DATABASE_URL`; `openslate_app` supplies its application privileges. An operator uses the provider's `supabase_admin` account through `DATABASE_BOOTSTRAP_URL` only for guarded role and privilege provisioning. Keep that bootstrap connection out of the API, worker, frontend, and normal runtime configuration. Supabase retains ownership of the database and its provider schemas; OpenSlate does not transfer them to its application owner.

Application tables use ordinary PostgreSQL ownership and grants. OpenSlate does not use provider RLS to reproduce application role, group, or domain policy. The one provider-table exception supports immediate Auth-session liveness: `openslate_app` receives `USAGE` on `auth` and `SELECT` only on `auth.sessions.id` and `auth.sessions.user_id`, constrained by the operator-owned `openslate_session_liveness` SELECT policy. It has no Auth table-wide read or mutation grant. Supabase Data API routes for OpenSlate application tables are blocked. Alembic reflection is limited to application-owned `public` objects by [`application_migration_scope`](../../backend/app/core/database/migration_scope.py), leaving provider objects outside its schema authority.

## Identity and files

`users` is application-owned and retains the OpenSlate UUID used by application relationships and audit actors. Its nullable unique `supabase_user_id` explicitly binds an eligible local profile to a Supabase Auth subject; it is not a foreign key into the provider-owned `auth` schema. Application `identity_sessions` retain local expiry, CSRF digest, immediate revocation, and provider user/session IDs. Each session stores the digest of an opaque refresh handle and the encrypted current provider access/refresh token pair. OpenSlate rate-limit buckets remain application data. Password hashes, provider email-action tokens, and provider Auth users belong to Supabase Auth rather than an OpenSlate password/action-token table.

[`users`](../../backend/app/systems/access/users/models.py) stores account color mode, motion, and keyboard shortcut preferences; the [`WorkspaceProfile`](../../backend/app/systems/manage/workspace/models.py) stores the shared organization look and security policy. Text size and density remain device-local. Durable per-user sign-in/activity history in [`identity_mfa_observations`](../../backend/app/systems/access/identity/models.py) is independent of session cleanup; its current MFA evidence remains bound to the observed provider identity.

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

[`files`](../../backend/app/systems/platform/files/models.py) stores application metadata, immutable object keys, lifecycle state, and nullable `enc_version` for Record and Board attachments, department library documents, and workspace logos. File bytes are stored in the private Supabase Storage `openslate-ready` bucket, accessed through the server-only Storage API adapter. FastAPI authorizes upload, download, and deletion. An upload passes file-type validation, and its row becomes `ready` with digest and size in the same request; only a `ready` row permits download. A file row or guessed object key alone never grants byte access. There is no selectable local-filesystem storage adapter.

[`in_app_notifications`](../../backend/app/systems/platform/scheduling/models.py) stores recipient-specific source references and read state, with access rechecked on read. [Backup policies, runs, and exports](../../backend/app/systems/manage/backups/models.py) persist operation state and source/completion metadata. An export passphrase is encrypted while queued and cleared when its claim commits; the finished encrypted archive lives in the confined host export directory, mounted read-only into the API, separately from Storage file bytes.

OpenView persists department Dashboards and widget configurations in [`dashboards` and `dashboard_widgets`](../../backend/app/systems/openview/dashboards/models.py). Each Dashboard has a required `department_id` (foreign key to `departments`, `ON DELETE RESTRICT`), a non-negative `position` and a bounded refresh cadence. [`saved_views`](../../backend/app/systems/openview/views/models.py) and [`reports`](../../backend/app/systems/openview/reports/models.py) belong to a module and have no owner or audience columns. The partial unique index `uq_saved_views_module_default` on `saved_views (module_id) WHERE is_default AND NOT is_deleted` allows one active default view for each module. These rows contain settings rather than materialized Record results; each data view queries authorized Records when rendered. The archived revision [`22c73bf93a9d`](../../backend/migrations/history/schema_redesign/22c73bf93a9d_make_openview_content_belong_to_.py) removed the personal tables `dashboard_defaults`, `saved_view_defaults` and `openview_chart_preferences` during development. The active root creates the final shared structure directly. The historical revisions [`7d08f4310c7b`](../../backend/migrations/history/vanilla_postgresql/7d08f4310c7b_add_chart_preferences_and_dashboard_.py) and [`a1a581d48771`](../../backend/migrations/history/vanilla_postgresql/a1a581d48771_complete_chart_preference_audit_foreign_.py) describe the earlier vanilla PostgreSQL evolution.

`report_run_eligible_users` records the module readers at the time each run is created. A run read also requires current read access on the module.

[`charts`](../../backend/app/systems/openview/charts/models.py) stores shared, revisioned chart definitions with source `module_id`, derived `department_id`, query and presentation configuration. The forward migration [`c64062dacada`](../../backend/migrations/versions/c64062dacada_add_saved_charts_and_widget_query_.py) adds that table and widget `chart_id`/query support after the fresh root. The removal of the old personal chart-preference table does not mean that current Charts are page-local only. Results are queried at read time under current access; saved definitions contain no materialized Record output.

## Fresh-root construction and lifecycle

The root was produced by Alembic autogeneration from the final registered
SQLAlchemy models against an empty application schema. Review supplements
autogeneration with deferred `use_alter` foreign keys, the final Board functions
and triggers, explicit grants/default privileges, and the Workspace, empty
version-4 Sandbox, and Company Board seeds. Table column order follows the
archived chain so schema-only dumps remain comparable. No provider object is
created or changed.

To reproduce equivalence, provision two separately owned disposable Supabase
instances: apply the archived chain to one and the root to the other, run
`alembic check` on both, and compare complete `public` schema-only dumps with
ownership and ACLs retained. Exclude only dump header/time lines and randomized
restrict tokens. Compare database/role privileges and blank-install seed values
separately; omit only generated Company Board IDs and timestamps from seed
equality. Do not normalize schema differences away.

The root's downgrade removes its application tables and owned routines; it is
destructive, not a data-preserving rollback. Reinstallation recreates blank
singletons. Existing installations require a separately approved fresh
initialization or supported restoration, not a revision stamp. Recreating the
provider volume also removes Auth and Storage state and requires explicit
approval under the installation procedure.

## Field values and record titles

Sandbox documents use version 4. A select field stores `config.options` as
`[{id, label}]`, with unique UUID option IDs and labels; record JSON stores the
option ID. Renaming an option changes its display label without rewriting
record values. Equality and membership filters compare IDs, while select search
and contains matching use current labels. See [field validation](../../backend/app/systems/sandbox/fields/validation.py)
and the [query compiler](../../backend/app/systems/sandbox/records/query.py).

A `user` field stores a user UUID. Live record creation, explicit assignments,
restores and trigger assignments validate current active module readers
through the application access policy. PATCH `data` replaces the active field
values and revalidates explicitly included person IDs; a PATCH without `data`
retains existing values. Moving a record between modules remains unsupported. The module-scoped
`GET /api/modules/{id}/assignable-users` response exposes only ID, display name
and username to module readers; it does not expose email addresses. Sandbox's
draft simulator uses explicitly simulated UUIDs rather than live assignments.

Record responses retain raw IDs in `data` and add transient `display_values`
for select labels and eligible person names. Group keys remain IDs; their
labels, CSV cells and report capture use the same
[display resolver](../../backend/app/systems/sandbox/records/display.py).
A person who no longer qualifies displays as `Unavailable user`; stored IDs are
not rewritten. Captured report output remains a snapshot of its run.

Version-3 Board bundles carry field references by name and type. Select filter
values are exported as labels and rebound to target option IDs. Person output
fields and value-free checks remain portable, but export, duplication, and
import reject filters containing a specific person ID: there is no
cross-installation person binding. Live person filters remain supported. See
[Board portability](../../backend/app/systems/boards/portability.py).

`modules.title_field_id` is a nullable, restricted foreign key to `fields`.
Publication requires an active field of the same module with an allowed text,
numeric or select type. Board links and revision links store record references,
not copied labels: authorized reads resolve the current title, falling back to
`Record <first eight ID characters>` when empty. Without source-record access,
the link displays `Record unavailable` and no destination URL. Closing a whole
module preserves its title selection; standalone removal of the selected field
requires clearing or changing the selection first. Subtree purge clears doomed
module pointers before deleting fields in the audited transaction.

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
