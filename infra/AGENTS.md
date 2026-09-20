# Infrastructure Artifacts

- This directory contains standalone production artifacts, not local startup; local development uses the root PostgreSQL Compose contract with host-run FastAPI and a local-only Next.js HMR server.
- Build `docker/backend.Dockerfile` with repository root as context; its `COPY` paths are root-relative. Do not change the context. It builds the static frontend and packages it with the FastAPI runtime; the final image contains no Node.js runtime.
- Images must not start PostgreSQL, apply Alembic migrations, provision database roles, bootstrap users, or define hosted deployment; CI/operators own those steps outside the images.
- Never bake `BACKEND_URL`, frontend runtime configuration, or private/backend secrets into the image.
- `caddy/` and `postgres/` contain production gateway and database artifacts. Caddy is not part of ordinary local development.
- Target: one full stack per client (micro–medium SMB, on-premise first). Do not introduce fleet/orchestrated deployment into these artifacts.
