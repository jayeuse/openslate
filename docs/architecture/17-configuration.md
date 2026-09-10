# Configuration Architecture

> **Scope:** Root, backend, frontend, Supabase CLI, image, test, and operational settings.
> **Audience:** Developers and operators preparing local environments, CI jobs, and images.
> **Related documents:** [Infrastructure](11-infrastructure.md), [Deployment](12-deployment-architecture.md), [Observability](18-observability.md), [Architecture index](README.md)

## One editable source

Root `.env` is the canonical local configuration file. `.env.example` groups
stack ports, URLs, secrets, administrator sign-in details, API limits, frontend
limits, container settings, and scanner settings. Filled files are ignored by
Git and excluded from Docker build context. Keep `.env` mode `0600`.

`backend/app/core/config/environment.py:read_environment` reads that exact file
and expands `${NAME}` references only against keys in the same file. Duplicate
bindings, malformed entries, missing references, unsupported default-expression
syntax, and reference cycles are errors. There is no alternate backend dotenv
file, legacy setting alias, inferred JWKS endpoint, or migration-to-runtime URL
fallback. Values required by the selected operation must be present and valid;
errors identify names without printing values.

Backend launchers read root `.env` using an absolute repository path. Local
shell values do not override the file. CI and containers explicitly select
`OPENSLATE_ENV_SOURCE=process`, which reads only injected process configuration.
Administrative, migration, and scanner loaders require their own inputs when
those operations run; API startup does not require administrator credentials,
the owner connection, or a scanner manifest.

`scripts/environment.py` provides three root commands, run through the backend
uv environment:

```sh
uv run --directory backend python ../scripts/environment.py check
uv run --directory backend python ../scripts/environment.py frontend
uv run --directory backend python ../scripts/environment.py compose config --quiet
```

`check` validates local API/frontend settings, port/URL agreement, administrator
fields, and database URLs. Scanner provisioning is checked when starting the
scanner. `frontend` atomically writes a mode-`0600` allowlist projection to
`frontend/.env.local`. `compose` validates inputs and derives a scoped effective
environment in memory before invoking Docker; it does not write a secret file.
Treat complete rendered Compose configuration as secret.

## Canonical root inventory

Every setting below is explicit in the example; example values are editable
configuration, not code fallbacks. Empty secret placeholders must be filled for
the operation that uses them. `APP_NAME` is a code constant, not configuration.

| Group | Canonical names | Owner and validation |
| --- | --- | --- |
| Supabase identity | `SUPABASE_PROJECT_ID`, `SUPABASE_HOST` | CLI project identity and the host used in root URL references. |
| Platform ports | `SUPABASE_API_PORT`, `SUPABASE_DB_PORT`, `SUPABASE_SHADOW_PORT`, `SUPABASE_STUDIO_PORT`, `SUPABASE_MAIL_PORT`, `SUPABASE_POOLER_PORT` | Direct `env(NAME)` references in `supabase/config.toml`; ports are integers 1–65535. Pooler remains disabled. |
| Application listeners | `BACKEND_BIND_HOST`, `BACKEND_PORT`, `FRONTEND_BIND_HOST`, `FRONTEND_PORT` | Backend `python -m app` and frontend launchers. No CLI host/port overrides in the frontend wrapper. |
| Endpoint identities | `FRONTEND_URL`, `BACKEND_URL`, `SUPABASE_URL`, `SUPABASE_AUTH_REDIRECT_URL`, `AUTH_SETUP_URL`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_AUDIENCE` | HTTP(S) endpoints and JWT identity. Example URLs explicitly reference canonical ports and base URLs. |
| Database secrets | `DATABASE_URL`, `MIGRATION_DATABASE_URL` | `postgresql+psycopg` URLs. Runtime uses `openslate_runtime`; owner is restricted to migrations/provisioning/owner operations. Store each encoded password only in its URL. Provisioning extracts the runtime password from `DATABASE_URL`. |
| Supabase keys | `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Public client key versus private Auth/Realtime/Storage credential. Only the publishable key reaches the frontend. |
| Internal event secret | `SECURITY_EVENT_SERVER_KEY` | Backend internal security-event authentication; never projected to frontend. |
| Local administrator | `ADMIN_EMAIL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Existing administrator/manual-test sign-in. Bootstrap uses email/username and sends an invitation; it never sets the saved password. Reset preservation uses `ADMIN_EMAIL`. |
| Optional seed token | `SUPABASE_ACCESS_TOKEN` | Required only for the explicit sample-data seed command; its target is `BACKEND_URL`. |
| API policy | `ENVIRONMENT`, `LIFECYCLE_PURGE_ENABLED`, `CORS_ORIGINS` | Explicit environment, canonical `true`/`false` flag, and JSON origin list. |
| API server | `LOG_DIR`, `SERVER_MAX_CONCURRENCY`, `SERVER_KEEP_ALIVE_SECONDS`, `REQUEST_BODY_MAX_BYTES` | Absolute log path and positive listener/request limits. |
| Database pool | `DATABASE_POOL_SIZE`, `DATABASE_MAX_OVERFLOW`, `DATABASE_POOL_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_STATEMENT_TIMEOUT_MS` | Positive bounds; overflow may be zero. |
| Readiness | `READINESS_POOL_TIMEOUT_SECONDS`, `READINESS_CONNECT_TIMEOUT_SECONDS`, `READINESS_STATEMENT_TIMEOUT_MS`, `READINESS_CALLER_TIMEOUT_SECONDS` | Separate positive readiness budgets. |
| Supabase request budget | `SUPABASE_TIMEOUT_SECONDS` | Positive backend client timeout. |
| Frontend limits | `FRONTEND_LOG_DIR`, `BFF_REQUEST_BODY_LIMIT_BYTES`, `BFF_RESPONSE_BODY_LIMIT_BYTES`, `BFF_REQUEST_DEADLINE_MS` | Absolute frontend log path and positive integer request/response/deadline limits. |
| Container transport | `COMPOSE_BIND_HOST`, `CONTAINER_BIND_HOST`, `CONTAINER_LOG_DIR` | Host port publication, container listeners, and absolute container log path. |
| Engine resources | `CLAMAV_MEMORY_LIMIT`, `CLAMAV_CPUS`, `CLAMAV_PIDS_LIMIT` | Explicit resource bounds in existing Compose configuration. |
| Scanner | `FILES_CLAMAV_HOST`, `FILES_CLAMAV_PORT`, `SCANNER_DEFINITIONS`, `FILES_CLAMAV_MANIFEST_PATH` | Private engine address/port, immutable definition directory, and matching readable manifest. API startup is independent; a scanner startup with missing configuration fails. |

### Supabase-generated values

Run `supabase status -o env` privately after starting the configured platform.
Map its output to canonical names; do not retain its original names as aliases.

| CLI output | Canonical destination |
| --- | --- |
| `API_URL` | Confirm it matches `SUPABASE_URL` and the canonical host/API port. |
| `DB_URL` | `MIGRATION_DATABASE_URL`, using the `postgresql+psycopg://` scheme. |
| `ANON_KEY` | `SUPABASE_PUBLISHABLE_KEY`. |
| `SERVICE_ROLE_KEY` | `SUPABASE_SECRET_KEY`, backend only. |

Supabase TOML also reads frontend invitation redirects from the canonical root
URLs. Fixed platform capabilities and security policy stay in TOML: public and
anonymous signup remain disabled; the invitation email provider stays enabled;
password/rate-limit policy is explicit; migrations/seeds, pooler, Edge Runtime,
analytics, and S3 protocol remain disabled. Alembic owns application schema.

## Frontend projection and builds

Local `npm run dev`, `npm run build`, and `npm start` regenerate
`frontend/.env.local`; `frontend/.env.example` documents the generated shape.
The projection has exactly eleven keys:

| Generated frontend name | Canonical root source |
| --- | --- |
| `BACKEND_URL` | `BACKEND_URL` |
| `SUPABASE_SERVER_URL` | `SUPABASE_URL` |
| `LOG_DIR` | `FRONTEND_LOG_DIR` |
| `BFF_REQUEST_BODY_LIMIT_BYTES` | Same name |
| `BFF_RESPONSE_BODY_LIMIT_BYTES` | Same name |
| `BFF_REQUEST_DEADLINE_MS` | Same name |
| `PORT` | `FRONTEND_PORT` |
| `HOSTNAME` | `FRONTEND_BIND_HOST` |
| `NEXT_PUBLIC_SUPABASE_URL` | `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `SUPABASE_PUBLISHABLE_KEY` |
| `NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED` | `LIFECYCLE_PURGE_ENABLED` |

These are derived process names, not independently editable settings. Never
source the private root file into npm or Next.js. No owner database URL,
administrator password, private Supabase key, or security-event key belongs in
the frontend projection, public build arguments, or browser bundle.

`frontend/src/lib/environment.ts` validates URLs, positive integers, absolute
log paths, and canonical boolean strings. The launchers parse only the generated
file and overwrite corresponding stale shell values. CI/container commands
explicitly use `--from-process`; all required values must already be injected.
The three `NEXT_PUBLIC_*` values are inlined during build and must match the
runtime deployment. Rebuild after changes to them. Server-only BFF values are
runtime configuration and are not baked into image layers.

For local Compose, the helper rewrites loopback database/Supabase transport
hosts to `host.docker.internal` and frontend-to-backend requests to the backend
service name. It preserves encoded credentials and the public JWT issuer.
Compose passes only each service's allowlisted keys; the ClamAV engine receives
no application secrets and publishes no port.

## Tests and fixed implementation policy

Playwright editor discovery uses the explicit local synthetic profile in
`frontend/playwright.config.ts`, so it can discover tests without shell setup.
The same profile supplies npm test runs. Explicit `PLAYWRIGHT_CONFIGURATION=process`
still requires every injected value; CI never selects the editor profile.

CI injects complete synthetic or generated configuration and selects process
mode. `TEST_DATABASE_URL`, `TEST_LAYER`, and `BASE_URL` are explicit test
controls, not application aliases. Owner fixture setup requires
`MIGRATION_DATABASE_URL`; it never substitutes a runtime test URL. The disposable
full-stack runner keeps generated identities and fixed isolated ports as a
safety contract, rewrites canonical Supabase references in its temporary copy,
and never loads the developer's root `.env`.

Settings that do not read environment variables remain ordinary code/config
policy: scanner inspection limits, fixed security headers, library/compiler
options, language versions, and test-isolation guards. This arrangement does
not expose them as speculative runtime options. See `backend/pyproject.toml`,
`frontend/package.json`, `frontend/next.config.ts`, `supabase/config.toml`, and
`infra/clamav/` for those explicit declarations.
