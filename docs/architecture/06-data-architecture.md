# Data Architecture

> **Scope:** Application-owned PostgreSQL schema, private file bytes, and schema delivery.

PostgreSQL is the sole relational datastore. FastAPI owns application data access; Alembic owns schema changes. The current vanilla PostgreSQL baseline is a new root revision for disposable development data and seeds the required `admin` and `member` roles.

## Ownership and roles

`openslate_owner` owns the database objects and runs migrations through `MIGRATION_DATABASE_URL`. `openslate_runtime` is the constrained login used through `DATABASE_URL`; provisioning is a separate bootstrap operation. `DATABASE_BOOTSTRAP_URL` is restricted to provisioning and never belongs in FastAPI settings, browser configuration, logs, or backups.

The application uses ordinary PostgreSQL ownership and grants. There are no managed schemas, row-level policies, or external identity foreign keys. FastAPI remains the domain authorization boundary.

## Identity and files

`users` is application-owned. Identity models add credentials, sessions, action tokens, and rate-limit buckets. Session and action-token state makes revocation, one-time links, refresh rotation, and password recovery enforceable in PostgreSQL.

`files` stores metadata, object keys, scan state, and nullable `enc_version`. Private bytes are written under a server-only `FILES_STORAGE_ROOT`: quarantine before scanning and immutable ready objects after promotion. A file row alone never grants byte access.

OpenView persists owner-private Dashboards and widget configurations in [`dashboards` and `dashboard_widgets`](../../backend/app/systems/openview/dashboards/models.py), with a bounded refresh cadence on each Dashboard. [`openview_chart_preferences`](../../backend/app/systems/openview/charts/models.py) stores one versioned Chart configuration per user. These rows contain settings rather than materialized Record results; each data view queries authorized Records when rendered. The forward revisions [`7d08f4310c7b`](../../backend/migrations/versions/7d08f4310c7b_add_chart_preferences_and_dashboard_.py) and [`a1a581d48771`](../../backend/migrations/versions/a1a581d48771_complete_chart_preference_audit_foreign_.py) add the preference table, Dashboard checks, and audit foreign key.

## Schema workflow

1. Change the registered SQLAlchemy model.
2. Generate and review an Alembic revision from `backend/`.
3. Apply `uv run alembic upgrade head` with the owner connection.
4. Run `uv run alembic check` and the disposable PostgreSQL integration path.

Do not edit an applied baseline or use SQLite as a substitute. Current development data is disposable; no importer is provided for earlier deployments.
