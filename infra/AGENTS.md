# Infrastructure Artifacts

- This directory contains standalone image artifacts, not local startup; local development uses Supabase CLI plus host-run FastAPI/Next.js (root `AGENTS.md`).
- Build `docker/backend.Dockerfile` and `docker/frontend.Dockerfile` with repository root as context; their `COPY` paths are root-relative. Do not change the context.
- Images must not start Supabase, apply Alembic migrations, provision database roles, bootstrap users, or define hosted deployment; CI/operators own those steps outside the images.
- Frontend build-time public values: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED`. Never bake `BACKEND_URL` or private/backend secrets into the image.
- `caddy/` and `postgres/` are empty; no checked-in reverse proxy, TLS, or database-init configuration exists.
- Target: one full stack per client (micro–medium SMB, on-premise first). Do not introduce fleet/orchestrated deployment into these artifacts.
