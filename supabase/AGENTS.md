# Supabase Local Configuration

- This directory owns local platform configuration only. Run CLI commands (`supabase start`, `supabase status`, `supabase stop`) from repository root, never here.
- `[db.migrations]` and `[db.seed]` are disabled in `config.toml`; Alembic owns application schema in `backend/migrations/`. Read its `AGENTS.md`; never add migrations or seeds here.
- Data API exposes only `graphql_public`; application data uses FastAPI `/api/*` through the frontend BFF. Never expose application schema to direct Data API access.
- Preserve `config.toml` auth security: public/anonymous signup disabled, 12-character password rules, redirect URLs, refresh-token rotation, and `templates/invite.html`.
- Realtime is private Broadcast invalidation only; never include row snapshots in payloads.
- `.branches/` and `.temp/` are ignored CLI state; `snippets/` is empty. Do not invent contracts for it.
