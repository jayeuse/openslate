# Infrastructure Artifacts

- This directory contains standalone image artifacts, not local startup; local development uses the root PostgreSQL Compose contract with host-run FastAPI and Next.js.
- Build `docker/backend.Dockerfile` and `docker/frontend.Dockerfile` with repository root as context; their `COPY` paths are root-relative. Do not change the context.
- Images must not start PostgreSQL, apply Alembic migrations, provision database roles, bootstrap users, or define hosted deployment; CI/operators own those steps outside the images.
- Frontend build-time public value: `NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED`. Never bake `BACKEND_URL` or private/backend secrets into the image.
- `caddy/` and `postgres/` contain the gateway and database artifacts used by the supported deployment contract.
- Target: one full stack per client (micro–medium SMB, on-premise first). Do not introduce fleet/orchestrated deployment into these artifacts.
