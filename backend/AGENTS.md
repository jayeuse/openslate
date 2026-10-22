# Backend Guide

FastAPI application data API: Python 3.12, synchronous SQLAlchemy 2 + Alembic, and Supabase Auth identity mapped to OpenSlate profiles and revocable application sessions. Supabase Database is PostgreSQL. Run commands from `backend/` (`uv run ...`); the project is not installed as a package.

The deployment profile is one full stack per client (micro–medium SMB, on-premise first, cloud second). One installation holds several organizations: shared tables with `org_id`, membership-based authorization in the bound organization, and RLS on `openslate.org_id` as a backstop (decision D01, `docs/plans/supabase-foundation.md`). Every organization query runs in a bound transaction (`app/core/database/organization_scope.py`); join `memberships` through `bound_membership_join()` or an explicit `org_id`; workers loop `active_organization_ids()` under `worker_organization()`. Keep the synchronous stack; do not introduce async SQLAlchemy, keyset pagination, or per-organization schemas without an explicit decision.

## Layout

- `app/core/` owns cross-cutting infrastructure: typed config, database/`AuditSession`/model registry, Supabase JWT verification and Auth integration, middleware, and other integrations.
- `app/common/` owns shared dependencies/auth, standard listing, documented exceptions, and normalization.
- `app/systems/<page>/<capability>/` owns domain features (`models.py`, `schemas.py`, `router.py`); add `service.py` only for coordination such as locking or multi-entity invariants.
- `sandbox` owns departments, modules, fields, records, relationships, and lifecycle; `access` owns auth and users; `openview` owns views; `boards` owns the company, department and project Boards; `manage` owns workspace and audit; `platform` owns files; `comms` owns durable conversations/messages, settings, moderation and related jobs. `reports`, `businesses`, and `admin` remain nested placeholders. This physical grouping does not restrict cross-domain audit, lifecycle, or file services. Read `migrations/AGENTS.md` before schema work.

## Tooling and style

- Every file under `backend/` must contain no more than 500 lines. Migration files under `backend/migrations/` are exempt. Test files under `backend/tests/` treat 500 lines as a review signal, not a limit: keep one behavior area in one file instead of splitting it into parts that repeat imports and fixtures.
- Require Python `>=3.12,<3.15`; Ruff rules are `E,F,I,B,UP,PT` with line length 100 (deferred `PT` codes are listed in `pyproject.toml`); mypy is strict with Pydantic and SQLAlchemy plugins. Check with `uv run ruff check . && uv run mypy app operations`.
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

- Routers register under `/api` in `app/main.py`; the auth router aggregates users and invitations, which must not be registered separately.
- Take every read and write filter from `app/systems/access/policy/scope.py` (`effective_levels`, `allowed_module_ids`, `level_for`) through `policy/checks.py`; never add a parallel permission check. Admins manage everything; a guest never writes. Users, groups, invitations, purge, the Sandbox, audit detail/export, and security events are administrator-only. Record export (CSV and Excel) needs module `read` (Tier 2 D12). Department managers may list audit entries only for an explicitly selected department where they have department-level `manage`; module-level `manage` is insufficient. A user with department `manage` may also read and replace the members of a group whose live access rows all fall inside departments they manage (`policy/delegation.py`, `EffectiveAccess.manages_all`). Renaming a group or changing its access stays administrator-only.
- List endpoints use `StandardListRequest`/`StandardListResponse` and `ListQuerySpec`: explicit sort enum, allowlisted columns, default sort, UUID tie-breaker, and offset pagination (never keyset).
- Exception D4: OpenComms message and reply history use exclusive `seq` keysets (before/after/around); other lists retain offset pagination.
- Keep errors route-local `HTTPException` shapes (for example lifecycle `{"detail":{"code","message"}}` and record validation with `code`, `message`, `errors`, `truncated`); do not add a global envelope.
- Departments, modules, and fields expose only `GET` routes; the Sandbox publish is the only way to change them. Hierarchical close/reopen/purge belongs to lifecycle, never CRUD.

## Tests and scripts

- Follow the root non-negotiable test workflow: focused case, passing feature batch, affected PostgreSQL integration, then pre-push gates. Run full suites only when preparing to push; edits, commits, and routine handoffs use focused checks.
- CI runs the stack-free unit lane (`not integration`) on four workers and five integration-only disposable-stack coverage shards. `tests/backend_coverage.py combine` merges the unit lane and all five shards before applying both 90% coverage gates; missing/duplicate evidence, required-test skips and source-identity mismatches fail closed. Local `tests.parallel_coverage --shards 3` runs the stack-free unit lane on six workers first, then three integration stacks and the same combined gates. Never overlap the backend and frontend heavy lanes or start another heavy check beside one; keep the configured within-lane parallelism unless a measured failure justifies a change.
- Run `COVERAGE_BASE_REF=<base-ref> uv run python -m tests.fullstack_runner --backend-coverage-only` for the full backend coverage gate only when preparing to push. The configured pytest default is 90%; the runner includes complete disposable PostgreSQL tests and the changed-line gate. Use `uv run pytest --no-cov -k <name>` for focused iteration; this does not satisfy the coverage gate.
- PostgreSQL integration tests require the runner-owned disposable Supabase stack and application database at the current Alembic head, explicit mutation flag, generated run identity, and private provider/database credentials manifest. Never reuse a personal or customer instance. Tests use `pytest.mark.integration`; override `get_db`/`get_current_user` with `dependency_overrides` and build rows with local `make_*` helpers. Move a helper or fixture to the area's `conftest.py` or support module when a second file needs it; do not add a factory library.
- `operations/` contains backend-owned operator commands. `supabase_keys.py --output <new-private-path>` creates a new owner-only key file without printing values; it does not assemble the full installation environment. `provision_database_role.py` provisions the application owner/runtime roles and narrowly scoped Auth-session read; `provision_storage.py` creates the private `openslate-ready` bucket; `retire_legacy_upload_bucket.py` is a one-time upgrade step after `alembic upgrade head` for installations from before 2026-10-05: dry-run by default, `--execute` deletes the retired upload bucket and verifies its absence, and outside development `--execute` also needs `--confirm`; `bootstrap_admin.py` sends the first administrator's provider invitation after the API is available. `reset_application_data.py` is dry-run by default and requires `--execute`, a TTY, and exact digest confirmation. Exception (owner-approved for agent sample runs): `--execute --confirm-digest <digest>` runs without a TTY only with `ENVIRONMENT=development`, loopback database and Auth URLs, the API stopped, and a digest equal to a fresh preview; production and test keep the TTY rule. Repository-wide automation remains in root `scripts/`.
- Only runnable commands live at the top of `operations/`; their paths are documented contracts (README, RESTORE.md cron lines, and `backup_state.py` run inside the server image). Put helpers in a package: `backups/` (host backup runner internals), `reset/` (guarded reset), or `sample/` (sample-data engine: `population/`, `phases/`, `controls/`, `verification/`, `packs/`). Inside a package, drop the repeated prefix (`sample/controls/boards.py`, not `sample_control_boards.py`). Do not add a package named `backup`: `backups/host.py` imports `packaging/backup` as `backup`.
- `tests/operations/` mirrors those folders (plus `runner/` for the disposable runner and instance guards), but test files keep their full unique names (`sample/controls/test_sample_control_boards.py`). `tests/operations/` has no `__init__.py` on purpose: one would make pytest import it as a top-level `operations` package that shadows the real one, so pytest needs every test file name to be unique.

## TDD and coverage

- Before creating/extending tests, changing behavior, fixing bugs, or refactoring, read and follow [tdd-workflow](../.agents/skills/tdd-workflow/SKILL.md). It owns test admission, sequencing, and exceptions; this guide owns project runners and coverage thresholds.
- Workers must report the skill path actually read and the focused failing/passing test evidence, or the applicable exception. A reference or announcement alone does not prove TDD execution.
- Require **90% changed executable production-line coverage** against the task's base revision and **90% overall `app` coverage** for full backend verification. Report these separately; missing measurement or a failed gate is **NOT READY TO PUSH** under the skill's exception policy.

## Verification and references

- Use the root `python3 scripts/prepush.py --base <base-ref> --serial` command only right before a push; it orders frontend and backend resource lanes one after another. Its backend lane runs Ruff, mypy, packaging backup contracts, tooling checks, the unit-plus-three-integration-shard coverage gate, and dedicated provider-reset acceptance (`tests.fullstack_runner --reset-acceptance-only`). That reset target is not full-stack/browser `--acceptance-only`; those journeys remain separately requested acceptance, and release smoke is release-only. Applicable unified container checks verify packaging, not deployment. Use the lower-level commands above only for focused repair. The disposable runner applies migrations, checks Alembic drift, rejects required-test skips, and writes overall/changed coverage evidence under `test-results/coverage/`.
- See `../AGENTS.md` for global rules, `migrations/AGENTS.md` for schema workflow, and `../docs/architecture/README.md` for deeper architecture.
