# Supabase Local Configuration

This directory holds local Supabase platform configuration only. Supabase CLI
commands run from the repository root (`supabase start`, `supabase status`,
`supabase stop`), never from here.

- The application schema is NOT managed here: `[db.migrations]` and `[db.seed]`
  are disabled in `config.toml`. Alembic owns schema evolution in
  `backend/migrations/` (see `backend/migrations/AGENTS.md`); never add
  migration or seed files under this directory.
- The Data API exposes only `graphql_public`. Application data flows through
  the FastAPI backend (`/api/*` via the frontend BFF); never expose the
  application schema to direct Data API access.
- Preserve the auth security posture in `config.toml`: public and anonymous
  signup disabled, 12-character password rules, redirect URLs, refresh-token
  rotation, and the invitation template `templates/invite.html`.
- Realtime is enabled for private Broadcast invalidation only; payloads must
  never contain row snapshots.
- `.branches/` and `.temp/` are ignored CLI state; `snippets/` is currently
  empty — do not invent contracts for it.
