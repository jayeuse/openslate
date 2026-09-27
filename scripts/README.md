# Command layout

OpenSlate uses names that describe who owns each command:

| Location | Owner and purpose | Normal entry point |
| --- | --- | --- |
| `scripts/` | Repository-wide environment, CI, build, packaging, and test orchestration | Run from the repository root with `python3` or the documented `uv run --directory backend` wrapper. |
| `backend/operations/` | Administrator, database, recovery, reset, and health commands that import backend application code | Run from `backend/` with `uv run python operations/<command>.py`. |
| `frontend/tooling/` | Internal Node launchers for local Next.js development, static builds, and Playwright | Invoke through the named `npm` scripts in `frontend/package.json`. |
| `tests/tooling/` | Contract tests for root repository commands and CI wiring | Run through the pre-push gate or `uv run --directory backend python -m unittest discover -s ../tests/tooling -t ..`. |

Only repository-wide automation belongs in this `scripts/` directory. Backend
operator commands belong in `backend/operations/`; frontend launch helpers
belong in `frontend/tooling/`; repository-command tests belong in
`tests/tooling/`. Do not create another product directory named `scripts`.

## Local Supabase development

The public development entry point is `dev.py`. It reads the owner-only root
`.env` by default, validates the installation settings, selects the pinned
Supabase base and development Compose files, and checks instance ownership
before changing containers. Use `--env-file <private-path>` before the action
when working with a separate owner-only environment file.

```bash
./scripts/dev.py db
./scripts/dev.py studio
./scripts/dev.py containers
./scripts/dev.py status
./scripts/dev.py stop
./scripts/dev.py stop studio
```

`db` and `containers` both start the complete Supabase development Compose
stack. `studio` starts the `api-gw` service and its dependencies, including the
operator Studio surface. `status` lists the owned development services. `stop`
stops the stack while retaining its named volumes; `stop studio` stops the
Studio service. There is no pgweb service or action. Do not remove installation
volumes as a cleanup shortcut.

On Windows, invoke the wrapper with `py scripts/dev.py <action>`. Start
FastAPI and Next.js directly from their owning directories. Next.js is the
daily browser entry point; production provider and application startup is
documented in the [Supabase operator guide](../infra/supabase/README.md).

## Caddy entry points

The `caddy` action controls the optional root `compose.yaml` gateway profile.
It is a separate preview artifact, not the Supabase production stack. Use it
only when its private Caddy configuration and preview target have been
prepared:

```bash
./scripts/dev.py caddy
./scripts/dev.py stop caddy
```

For a client installation, follow the Supabase operator guide for production
Compose. It specifies when to start the provider services, provision roles and
schema, create Storage buckets, and then start the API, scanner, and production
Caddy service. Do not use the preview action as a substitute for that sequence.

When adding a command:

1. Put it with the component that owns its dependencies and working directory.
2. Give developers one documented wrapper command instead of making them call
   an internal helper directly.
3. Update CI path classification and container copies when the command is part
   of a build or runtime image.
4. Keep credentials in the canonical root `.env` projection or an approved
   secret file, never in command arguments or tracked command files.
