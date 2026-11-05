# Infrastructure Artifacts

- `supabase/` contains the pinned self-hosted Supabase Compose stack and its development and production overlays. Local development uses that stack through `./scripts/dev.py`; FastAPI and the local Next.js HMR server run on the host. Supabase Database supplies PostgreSQL; there is no standalone root PostgreSQL or pgweb service. See `supabase/README.md` for the verified service and operator contract.
- Build `docker/backend.Dockerfile` with repository root as context; its `COPY` paths are root-relative. Do not change the context. It builds the static frontend and packages it with the FastAPI runtime; the final image contains no Node.js runtime.
- Application images must not start provider services, apply Alembic migrations, provision database roles or Storage buckets, bootstrap users, or define hosted deployment; CI/operators own those steps outside the images.
- Never bake `BACKEND_URL`, frontend runtime configuration, or private/backend secrets into the image.
- `caddy/` contains production gateway artifacts. Caddy is not part of ordinary local development.
- Target: one full Compose stack per client (micro–medium SMB, on-premise first) on Linux or Windows Docker Desktop using WSL2/Linux containers. Windows startup, reboot, persistent-volume, and restore acceptance remain pending until run on Windows. macOS workstation development is allowed, but macOS is not a server deployment target. Do not introduce fleet/orchestrated deployment into these artifacts.
- `/api/health` reports API-process liveness; `/api/ready` reports the required database, Auth, Storage, and SMTP-configuration components (`../docs/architecture/11-infrastructure.md`).
- Native Linux host boot/reboot, Windows acceptance, and the canonical release gate remain pending; do not describe this infrastructure as production-ready.

## Skills

- Compose files and Dockerfiles: [`project-tooling`](../.agents/skills/project-tooling/SKILL.md). Use it for each change under `supabase/`, `docker/`, or `caddy/`.
- Compose exposure: [`webapp-security-review`](../.agents/skills/webapp-security-review/SKILL.md). Use it when a change touches exposed ports, gateway rules, or where secrets reach an image or a container.
