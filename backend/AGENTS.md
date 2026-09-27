# Backend Guide

FastAPI application data API: Python 3.12, synchronous SQLAlchemy 2 + Alembic, and Supabase Auth identity mapped to OpenSlate profiles and revocable application sessions. Supabase Database is PostgreSQL. Run commands from `backend/` (`uv run ...`); the project is not installed as a package.

The deployment profile is one full stack per client (single tenant, micro–medium SMB, on-premise first). Keep the synchronous stack; do not introduce async SQLAlchemy, keyset pagination, or tenant-scoped schemas without an explicit decision.

## Layout

- `app/core/` owns cross-cutting infrastructure: typed config, database/`AuditSession`/model registry, Supabase JWT verification and Auth integration, middleware, and other integrations.
- `app/common/` owns shared dependencies/auth, standard listing, documented exceptions, and normalization.
- `app/systems/<page>/<capability>/` owns domain features (`models.py`, `schemas.py`, `router.py`); add `service.py` only for coordination such as locking or multi-entity invariants.
- `sandbox` owns departments, modules, fields, records, relationships, and lifecycle; `access` owns auth and users; `openview` owns views; `manage` owns workspace and audit; `platform` owns files. `reports`, `businesses`, and `admin` remain nested placeholders, while `boards` and `comms` remain reserved. This physical grouping does not restrict cross-domain audit, lifecycle, or file services. Read `migrations/AGENTS.md` before schema work.

## Tooling and style

- Every file under `backend/` must contain no more than 500 lines. Migration files under `backend/migrations/` are exempt.
- Require Python `>=3.12,<3.15`; Ruff rules are `E,F,I,B,UP` with line length 100; mypy is strict with Pydantic and SQLAlchemy plugins. Check with `uv run ruff check . && uv run mypy app operations`.
- Use plain `sqlalchemy.orm.Session` from `get_db`, `create_engine`, and `db.commit()` in routes/services. Do not refactor to async SQLAlchemy.
- Prefer typed code: `Mapped[...]` ORM columns, `Annotated[..., Depends(...)]`, `StrEnum`, and typed Pydantic v2 schemas. Responses use `from_attributes=True`; request models use `extra="forbid"` when silently ignored input is unsafe.
- Keep simple use cases in routers. Do not add generic repositories, a global error envelope, or service-per-feature layers without an explicit need.

## Persistence invariants

- Domain models inherit `app.core.base_model.BaseModel` (`UUIDv7 id`, timestamps, soft-delete fields, and `performed_by`). Audit/lifecycle support tables inherit `Base` directly and disable audit.
- Register every ORM model in `app/core/database/model_registry.py`; Alembic autogenerate only sees imported registry models.
- Schema flow is models → `migrations/AGENTS.md` → `uv run alembic revision --autogenerate` → review → `uv run alembic upgrade head` and `uv run alembic check`.
- OpenSlate user/profile, revocable session, and rate-limit tables are application-owned models and must be registered like other ORM models. Supabase Auth and Storage schemas remain provider-owned; do not map them as application models or migrate their tables. The runtime's narrow read of provider session identity is an explicit integration exception, not application ownership.
- Soft delete is explicit (`is_deleted`/`deleted_at`); `BaseModel` does not filter automatically. Deleted-aware lists use `execute_standard_list`.

## Mutations and audit

- Every mutation uses the request-provided `AuditSession` (`get_db`) and individual ORM instance changes. Bulk ORM `update()`/`delete()` and raw ORM mutation execution are rejected by audit listeners.
- Routes/services own `commit()` and `rollback()`; roll back before translating `IntegrityError` or concurrency failures into safe HTTP responses.
- Audit covers application ORM mutations only, not Alembic or direct SQL. Record minimal diffs and redact keys such as `password`, `token`, `secret`, and `api_key`.

## API conventions

- Routers register under `/api` in `app/main.py`; the auth router aggregates users, roles, and invitations, which must not be registered separately.
- Use exactly ten flat `<feature>.read`/`<feature>.write` capabilities. Malformed permission documents fail closed; literal `admin` has all capabilities. Users, roles, invitations, audit, and purge are administrator-only.
- List endpoints use `StandardListRequest`/`StandardListResponse` and `ListQuerySpec`: explicit sort enum, allowlisted columns, default sort, UUID tie-breaker, and offset pagination (never keyset).
- Keep errors route-local `HTTPException` shapes (for example lifecycle `{"detail":{"code","message"}}` and record validation with `code`, `message`, `errors`, `truncated`); do not add a global envelope.
- Departments, modules, and fields expose only `GET` routes; the Sandbox publish is the only way to change them. Hierarchical close/reopen/purge belongs to lifecycle, never CRUD.

## Tests and scripts

- Follow the root non-negotiable test workflow: focused case, passing feature batch, affected PostgreSQL integration, then pre-push gates. Run full suites only when preparing to push; edits, commits, and routine handoffs use focused checks.
- Run `COVERAGE_BASE_REF=<base-ref> uv run python -m tests.fullstack_runner --backend-coverage-only` for the full backend coverage gate only when preparing to push. The configured pytest default is 90%; the runner includes complete disposable PostgreSQL tests and the changed-line gate. Use `uv run pytest --no-cov -k <name>` for focused iteration; this does not satisfy the coverage gate.
- PostgreSQL integration tests require the runner-owned disposable Supabase stack and application database at the current Alembic head, explicit mutation flag, generated run identity, and private provider/database credentials manifest. Never reuse a personal or customer instance. Tests use `pytest.mark.integration`; override `get_db`/`get_current_user` with `dependency_overrides` and build rows with local `make_*` helpers, not a factory module.
- `operations/` contains backend-owned operator commands. `supabase_keys.py --output <new-private-path>` creates a new owner-only key file without printing values; it does not assemble the full installation environment. `provision_database_role.py` provisions the application owner/runtime roles and narrowly scoped Auth-session read; `provision_storage.py` creates the private quarantine and ready buckets; `bootstrap_admin.py` sends the first administrator's provider invitation after the API is available. `reset_application_data.py` is dry-run by default and requires `--execute`, a TTY, and exact digest confirmation. Repository-wide automation remains in root `scripts/`.

## TDD and coverage

- Before creating/extending tests, changing behavior, fixing bugs, or refactoring, read and follow [tdd-workflow](../.agents/skills/tdd-workflow/SKILL.md). It owns test admission, sequencing, and exceptions; this guide owns project runners and coverage thresholds.
- Workers must report the skill path actually read and the focused failing/passing test evidence, or the applicable exception. A reference or announcement alone does not prove TDD execution.
- Require **90% changed executable production-line coverage** against the task's base revision and **90% overall `app` coverage** for full backend verification. Report these separately; missing measurement or a failed gate is **NOT READY TO PUSH** under the skill's exception policy.

## Verification and references

- Use the root `python3 scripts/prepush.py --base <base-ref>` command for the final pre-push gate. Its backend lane runs Ruff, mypy, tooling checks, the backend-only coverage command, applicable container checks, and full-stack acceptance without repeating backend regression. Use the lower-level commands above only for focused repair. The disposable runner applies migrations, checks Alembic drift, rejects required-test skips, and writes overall/changed coverage evidence under `test-results/coverage/`.
- See `../AGENTS.md` for global rules, `migrations/AGENTS.md` for schema workflow, and `../docs/architecture/README.md` for deeper architecture.
