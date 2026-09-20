# Testing Architecture

> **Scope:** Required repository checks and unverified deployment evidence.

Backend changes use focused pytest cases while repairing, then the affected batch. The backend coverage gate uses the disposable PostgreSQL runner at the current Alembic head, Ruff, mypy, and the configured changed-line/overall coverage thresholds. Database behavior is never substituted with SQLite.

Frontend changes use formatting, ESLint, TypeScript, retained isolated tests,
targeted HTTP route-contract tests for the development-only Next.js `/api`
proxy, and a static production export at the frontend gate. Browser rendering is
not a configured frontend coverage gate; run a targeted browser acceptance
check when a runnable UI change needs visual or interaction evidence. FastAPI
static-site delivery, API/static path separation, cache policy, and response
security headers need FastAPI HTTP coverage.

The root `python3 scripts/prepush.py --base <base-ref>` command selects the applicable final gate. Documentation-only edits require a final diff review, exact terminology search where relevant, and `git diff --check`; they do not require application tests.

The Linux unified image verifies that FastAPI contains and serves the static frontend package. Native Windows/macOS installation, Caddy runtime validation where the binary is absent, production TLS, bundled database restart, backup/restore, and LAN/PWA matrix evidence remain unverified until their specific acceptance environment exists.

Daily development does not exercise Caddy. The installed `gateway` profile is
opt-in for a manually prepared production preview. Validate the production
gateway, TLS, and its one-FastAPI-upstream topology through the isolated command
`uv run python -m tests.fullstack_runner --acceptance-only` from `backend/`.
That runner uses `ENVIRONMENT=test`, retaining strict origin/host validation,
response headers, body limits, concurrency, and rate limits while daily
`ENVIRONMENT=development` relaxes those local transport policies.
