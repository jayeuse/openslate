# Backend Guide

FastAPI application data API: Python 3.12, sync SQLAlchemy 2 + Alembic, Supabase
Auth for identities. Run every command from this directory (`uv run ...`); the
project is not installed as a package.

Deployment profile: single-tenant, one full stack per client (micro–medium SMB
organizations; on-premise first, hosted instances later). Per-instance
concurrency is small by design, so the synchronous stack is the correct fit —
do not refactor toward async SQLAlchemy, keyset pagination, or tenant-scoped
schemas without an explicit decision.

## Layout

- `app/core/` — cross-cutting infrastructure: `config/` (typed settings),
  `database/` (engine, `AuditSession`, `model_registry`), `security/` (Supabase
  JWT verification), `middleware/`, `integrations/`.
- `app/common/` — shared code: `dependencies/` (auth), `listing/` (standard
  list schemas and offset query building), `exceptions/` (documentation only),
  `normalization.py`.
- `app/systems/<capability>/` — one directory per domain feature with
  `models.py`, `schemas.py`, `router.py`; add `service.py` only when
  coordination (locking, multi-entity invariants) demands it — see
  `relationships` and `lifecycle` for the reference implementations. `files`,
  `reports`, `views`, `businesses`, `admin` are placeholders; do not build
  features there yet.
- `migrations/` — Alembic revisions; read `migrations/AGENTS.md` before any
  schema work.

## Tooling and style

- Python `>=3.12,<3.15`. Ruff: rules `E,F,I,B,UP`, line length 100. Mypy:
  `strict = true` with pydantic and sqlalchemy plugins. Check with
  `uv run ruff check . && uv run mypy app scripts`.
- This backend is synchronous: plain `sqlalchemy.orm.Session` from `get_db`,
  `create_engine`, `db.commit()` in routes/services. Do not introduce async
  SQLAlchemy.
- Type-first code: `Mapped[...]` ORM columns, `Annotated[..., Depends(...)]`
  dependencies, `StrEnum`, typed Pydantic v2 schemas. Response models use
  `from_attributes=True`; request models use `extra="forbid"` where silently
  ignored input is unsafe.
- Keep simple use cases in the router. No new abstraction layers (generic
  repositories, global error envelope, service-per-feature) without an
  explicit need — simple wins.

## Persistence invariants

- Domain models inherit `app.core.base_model.BaseModel` (UUIDv7 `id`,
  `created_at`, `updated_at`, `deleted_at`, `is_deleted`, `performed_by`).
  Audit and lifecycle support tables inherit `Base` directly and disable audit.
- Register every ORM model in `app/core/database/model_registry.py` — Alembic
  autogenerate sees only what the registry imports.
- Schema changes start in the models files, then flow through
  `migrations/AGENTS.md`: models → `alembic revision --autogenerate` → review →
  `upgrade head` + `alembic check`.
- Tables marked `info={"external": True}` (Supabase Auth placeholders) are
  excluded from autogenerate — never migrate or alter them.
- Soft delete is explicit: set `is_deleted`/`deleted_at`; `BaseModel` does not
  filter automatically. Deleted-aware lists go through
  `execute_standard_list`.

## Mutations and audit

- All mutations go through the request-provided `AuditSession` (`get_db`) as
  individual ORM instance changes. Bulk `update()`/`delete()` ORM statements
  and raw ORM mutation execution are rejected by the audit listeners.
- Routes and services own `commit()`/`rollback()`; translate
  `IntegrityError`/concurrency failures into safe HTTP responses after
  rollback.
- Audit captures application ORM mutations only — Auth, Alembic, Studio, and
  direct SQL are outside its boundary. Snapshots are minimal diffs with
  key-name redaction (`password`, `token`, `secret`, `api_key`, ...).

## API conventions

- Routers register under `/api` in `app/main.py`. The auth router aggregates
  users/roles/invitations — do not register them separately.
- Exactly ten flat capabilities (`<feature>.read`/`<feature>.write`); malformed
  permission documents fail closed; the literal `admin` role has everything.
  Users, roles, invitations, audit, and purge are administrator-only.
- List endpoints use `StandardListRequest/Response` + `ListQuerySpec`: explicit
  sort enum, allowlisted columns, default sort, UUID tie-breaker, offset
  pagination (no keyset).
- Errors are route-local `HTTPException` shapes (for example lifecycle
  `{"detail": {"code", "message"}}`, record validation `{"detail": {"code",
  "message", "errors", "truncated"}}`). Do not introduce a global error
  envelope.
- Ordinary `DELETE` on departments/modules/fields returns `close_required`:
  hierarchical close/reopen/purge is lifecycle's job, never CRUD.

## Tests

- `uv run pytest` from this directory; repository-wide 80% coverage gate
  (`--cov=app`). Use `--no-cov` or `-k <name>` for focused runs.
- PostgreSQL integration tests require `TEST_DATABASE_URL` pointing at the
  loopback Supabase database (port 54322, database `postgres`, at the current
  Alembic head) and are marked `pytest.mark.integration`.
- Override `get_db`/`get_current_user` via `dependency_overrides`; build rows
  with local `make_*` helpers — there is no factory module.

## Scripts

- `scripts/bootstrap_admin.py` — first administrator via Supabase invite (once).
- `scripts/provision_database_role.py` — least-privilege `openslate_runtime`
  role (export `.env` first).
- `scripts/seed_sample_data.py` — seeds through the API with an admin token.
- `scripts/reset_application_data.py` — dry-run by default; requires
  `--execute`, a TTY, and exact digest confirmation.

## Verification and references

- CI-equivalent: `uv run ruff check . && uv run mypy app scripts &&
  TEST_DATABASE_URL="$DATABASE_URL" uv run pytest`, plus
  `uv run alembic check`.
- Deep architecture: `docs/architecture/README.md`. Global rules: root
  `AGENTS.md`. Schema workflow: `migrations/AGENTS.md`.
