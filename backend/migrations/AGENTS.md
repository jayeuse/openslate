# Migrations Guide

`backend/migrations/` is Alembic-owned and records only OpenSlate application schema state derived from application models. Supabase Database is PostgreSQL, but Auth, Storage, and other provider schemas are initialized and upgraded by Supabase; never model or migrate those provider-owned tables here.

## Required workflow

Every schema change starts in `backend/app/systems/<page>/<capability>/models.py`, never in a hand-written migration or raw SQL.

1. Edit the model first. Register new ORM classes in `backend/app/core/database/model_registry.py`, or Alembic autogenerate cannot see them.
2. From `backend/`, run `uv run alembic revision --autogenerate -m "<change>"`.
3. Review the revision operation by operation against the models. Check for dropped/renamed columns, unintended types, missing partial or expression indexes, changed constraints/foreign keys, and anything autogenerate misrepresents. Fix the model or deliberately adjust the revision before applying it.
4. Run `uv run alembic upgrade head`, then `uv run alembic check`; a second autogenerate must be clean.

## Hard rules

- Do not hand-write a migration as the starting point of a schema change.
- Do not change schema with raw SQL and call it complete; schema changes flow from models through Alembic.
- Changes that need application roles, grants, functions, or data backfills still start with the model change; add those operations deliberately to the generated revision. Keep operations inside the application schema and the documented OpenSlate grants. The runtime model has no provider-schema ownership.
- Never edit an applied revision.
- Fresh Supabase installations use `c4ec36fc30cc` as the active application baseline. The previous vanilla PostgreSQL chain is preserved under `migrations/history/vanilla_postgresql/` and is not part of the active Alembic graph. This migration starts from a fresh application database; do not stamp an existing legacy database onto the new lineage or imply that it imports old data.
- Treat the Supabase application baseline as immutable once applied. Repair it through a reviewed forward migration or a supported backup restoration, never by editing the baseline or modifying provider-owned objects.
