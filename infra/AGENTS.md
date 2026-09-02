# Infrastructure Artifacts

This directory holds standalone image artifacts only. It is NOT the local
development path — local startup is Supabase CLI plus host-run FastAPI and
Next.js (see root `AGENTS.md`).

- `docker/backend.Dockerfile` and `docker/frontend.Dockerfile` build standalone
  images with the repository root as build context (they use root-relative
  `COPY` paths). Do not change the context.
- The images do not start Supabase, apply Alembic migrations, provision
  database roles, bootstrap users, or define a hosted deployment; CI and
  operators run those steps outside the images. Keep it that way.
- The frontend image takes `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and
  `NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED` as build-time public values only.
  Never bake `BACKEND_URL` or private/backend secrets into it.
- `caddy/` and `postgres/` are currently empty: there is no checked-in reverse
  proxy, TLS, or database-init configuration.
- Target deployment is one full stack per client instance (micro–medium SMB,
  on-premise first). There is no fleet/orchestrated deployment yet; do not
  design one into these artifacts.
