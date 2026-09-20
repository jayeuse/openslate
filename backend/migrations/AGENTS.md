# Migrations Guide

`backend/migrations/` is Alembic-owned and records schema state derived from application models. Never invent schema here.

## Required workflow

Every schema change starts in `backend/app/systems/<page>/<capability>/models.py`, never in a hand-written migration or raw SQL.

1. Edit the model first. Register new ORM classes in `backend/app/core/database/model_registry.py`, or Alembic autogenerate cannot see them.
2. From `backend/`, run `uv run alembic revision --autogenerate -m "<change>"`.
3. Review the revision operation by operation against the models. Check for dropped/renamed columns, unintended types, missing partial or expression indexes, changed constraints/foreign keys, and anything autogenerate misrepresents. Fix the model or deliberately adjust the revision before applying it.
4. Run `uv run alembic upgrade head`, then `uv run alembic check`; a second autogenerate must be clean.

## Hard rules

- Do not hand-write a migration as the starting point of a schema change.
- Do not change schema with raw SQL and call it complete; schema changes flow from models through Alembic.
- Changes that need PostgreSQL roles, grants, functions, or data backfills still start with the model change; add those operations deliberately to the generated revision. The runtime model has no managed-schema dependency.
- Never edit an applied revision.
- The vanilla PostgreSQL baseline is an intentionally new root revision for disposable development data. Do not edit it after it has been applied; use a reviewed forward migration or backup restoration for repair.
