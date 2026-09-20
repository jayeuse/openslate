# Command layout

OpenSlate uses names that describe who owns each command:

| Location | Owner and purpose | Normal entry point |
| --- | --- | --- |
| `scripts/` | Repository-wide environment, CI, build, packaging, and test orchestration | Run from the repository root with `python3` or the documented `uv run --directory backend` wrapper. |
| `backend/operations/` | Administrator, database, recovery, reset, health, and sample-data commands that import backend application code | Run from `backend/` with `uv run python operations/<command>.py`. |
| `frontend/tooling/` | Internal Node launchers for Next.js, standalone serving, and Playwright | Invoke through the named `npm` scripts in `frontend/package.json`. |
| `tests/tooling/` | Contract tests for root repository commands and CI wiring | Run through the pre-push gate or `uv run --directory backend python -m unittest discover -s ../tests/tooling -t ..`. |

Only repository-wide automation belongs in this `scripts/` directory. Backend
operator commands belong in `backend/operations/`; frontend launch helpers
belong in `frontend/tooling/`; repository-command tests belong in
`tests/tooling/`. Do not create another product directory named `scripts`.

## Daily development containers

The public development entry point is `dev.py`; it keeps environment
validation, generated configuration, secret files, profiles, and build flags
out of the commands developers need to remember:

```bash
./scripts/dev.py db
./scripts/dev.py pgweb
./scripts/dev.py caddy
./scripts/dev.py containers
./scripts/dev.py status
./scripts/dev.py stop
./scripts/dev.py stop pgweb
```

On Windows, invoke the same file as `py scripts/dev.py <action>`.

When adding a command:

1. Put it with the component that owns its dependencies and working directory.
2. Give developers one documented wrapper command instead of making them call
   an internal helper directly.
3. Update CI path classification and container copies when the command is part
   of a build or runtime image.
4. Keep credentials in the canonical root `.env` projection or an approved
   secret file, never in command arguments or tracked command files.
