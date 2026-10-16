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
- Organization data: a new organization table carries `org_id NOT NULL`, a `UniqueConstraint("org_id", "id")`, and composite `(org_id, <ref>_id)` foreign keys to other organization tables (D09). Add its RLS policy deliberately in the generated revision, following `f5a100021193` (policy for `openslate_app` on `nullif(current_setting('openslate.org_id', true), '')::uuid`, no `FORCE`). `organizations`, `memberships`, `users`, `platform_settings`, and `platform_operators` stay without RLS. Organization-scoped uniques include `org_id`.
- The approved foundation plan's S04/D13 is the one-time exception: replace the 20-revision development lineage with one model-generated organization root. Preserve the triggers, grants, default privileges and retention function deliberately; seed no organization, Sandbox document or Company Board. An existing development installation requires a verified backup followed by an owner-authorized rebuild of only `openslate_owner` objects in `public`; preserve provider schemas, credentials and volumes. Never stamp the old database onto the new root.
- The archives under `migrations/history/schema_redesign/` and `migrations/history/vanilla_postgresql/` remain unchanged and are not active Alembic revisions. The replacement root requires a fresh application schema and does not import old data.
- Treat the Supabase application baseline as immutable once applied. Repair it through a reviewed forward migration or a supported backup restoration, never by editing the baseline or modifying provider-owned objects.
