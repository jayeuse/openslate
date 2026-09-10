# Backend Guide

FastAPI application data API: Python 3.12, synchronous SQLAlchemy 2 + Alembic, and Supabase Auth for identities. Run commands from `backend/` (`uv run ...`); the project is not installed as a package.

The deployment profile is one full stack per client (single tenant, micro–medium SMB, on-premise first). Keep the synchronous stack; do not introduce async SQLAlchemy, keyset pagination, or tenant-scoped schemas without an explicit decision.

## Layout

- `app/core/` owns cross-cutting infrastructure: typed config, database/`AuditSession`/model registry, JWT security, middleware, and integrations.
- `app/common/` owns shared dependencies/auth, standard listing, documented exceptions, and normalization.
- `app/systems/<capability>/` owns domain features (`models.py`, `schemas.py`, `router.py`); add `service.py` only for coordination such as locking or multi-entity invariants (see `relationships` and `lifecycle`).
- `files`, `reports`, `views`, `businesses`, and `admin` are placeholders; do not build them until requested. Read `migrations/AGENTS.md` before schema work.

## Tooling and style

- Every file under `backend/` must contain no more than 500 lines. Migration files under `backend/migrations/` are exempt.
- Require Python `>=3.12,<3.15`; Ruff rules are `E,F,I,B,UP` with line length 100; mypy is strict with Pydantic and SQLAlchemy plugins. Check with `uv run ruff check . && uv run mypy app scripts`.
- Use plain `sqlalchemy.orm.Session` from `get_db`, `create_engine`, and `db.commit()` in routes/services. Do not refactor to async SQLAlchemy.
- Prefer typed code: `Mapped[...]` ORM columns, `Annotated[..., Depends(...)]`, `StrEnum`, and typed Pydantic v2 schemas. Responses use `from_attributes=True`; request models use `extra="forbid"` when silently ignored input is unsafe.
- Keep simple use cases in routers. Do not add generic repositories, a global error envelope, or service-per-feature layers without an explicit need.

## Persistence invariants

- Domain models inherit `app.core.base_model.BaseModel` (`UUIDv7 id`, timestamps, soft-delete fields, and `performed_by`). Audit/lifecycle support tables inherit `Base` directly and disable audit.
- Register every ORM model in `app/core/database/model_registry.py`; Alembic autogenerate only sees imported registry models.
- Schema flow is models → `migrations/AGENTS.md` → `uv run alembic revision --autogenerate` → review → `uv run alembic upgrade head` and `uv run alembic check`.
- Tables with `info={"external": True}` are Supabase Auth placeholders: exclude them from autogenerate and never migrate or alter them.
- Soft delete is explicit (`is_deleted`/`deleted_at`); `BaseModel` does not filter automatically. Deleted-aware lists use `execute_standard_list`.

## Mutations and audit

- Every mutation uses the request-provided `AuditSession` (`get_db`) and individual ORM instance changes. Bulk ORM `update()`/`delete()` and raw ORM mutation execution are rejected by audit listeners.
- Routes/services own `commit()` and `rollback()`; roll back before translating `IntegrityError` or concurrency failures into safe HTTP responses.
- Audit covers application ORM mutations only, not Auth, Alembic, Studio, or direct SQL. Record minimal diffs and redact keys such as `password`, `token`, `secret`, and `api_key`.

## API conventions

- Routers register under `/api` in `app/main.py`; the auth router aggregates users, roles, and invitations, which must not be registered separately.
- Use exactly ten flat `<feature>.read`/`<feature>.write` capabilities. Malformed permission documents fail closed; literal `admin` has all capabilities. Users, roles, invitations, audit, and purge are administrator-only.
- List endpoints use `StandardListRequest`/`StandardListResponse` and `ListQuerySpec`: explicit sort enum, allowlisted columns, default sort, UUID tie-breaker, and offset pagination (never keyset).
- Keep errors route-local `HTTPException` shapes (for example lifecycle `{"detail":{"code","message"}}` and record validation with `code`, `message`, `errors`, `truncated`); do not add a global envelope.
- Ordinary `DELETE` on departments/modules/fields returns `close_required`; hierarchical close/reopen/purge belongs to lifecycle, never CRUD.

## Tests and scripts

- Run `uv run pytest --cov-fail-under=90` for the full backend coverage gate. The configured default is still 80%; the explicit override enforces this guide's stricter 90% requirement. Use `uv run pytest --no-cov -k <name>` for focused iteration; this does not satisfy the coverage gate.
- PostgreSQL integration tests require `TEST_DATABASE_URL` for the loopback Supabase database (port 54322, database `postgres`, current Alembic head) and use `pytest.mark.integration`. Override `get_db`/`get_current_user` with `dependency_overrides`; build rows with local `make_*` helpers, not a factory module.
- `scripts/bootstrap_admin.py` invites the first administrator once; `provision_database_role.py` creates least-privilege `openslate_runtime` (reads canonical root `.env`); `seed_sample_data.py` seeds through the API with an admin token; `reset_application_data.py` is dry-run by default and requires `--execute`, a TTY, and exact digest confirmation.

## TDD and coverage

- Before creating/extending tests, changing behavior, fixing bugs, or refactoring, read and follow [tdd-workflow](../.agents/skills/tdd-workflow/SKILL.md). It owns test admission, sequencing, and exceptions; this guide owns project runners and coverage thresholds.
- Workers must report the skill path actually read and the focused failing/passing test evidence, or the applicable exception. A reference or announcement alone does not prove TDD execution.
- Require **90% changed executable production-line coverage** against the task's base revision and **90% overall `app` coverage** for full backend verification. Report these separately; missing measurement or a failed gate is **NOT READY** under the skill's exception policy.

## Verification and references

- Backend handoff check: `uv run ruff check . && uv run mypy app scripts && TEST_DATABASE_URL="$DATABASE_URL" uv run pytest --cov-fail-under=90`, plus `uv run alembic check` and changed-code coverage evidence when production code changes. This explicitly applies the stricter coverage policy even while CI configuration retains its older default.
- See `../AGENTS.md` for global rules, `migrations/AGENTS.md` for schema workflow, and `../docs/architecture/README.md` for deeper architecture.
