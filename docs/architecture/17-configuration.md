# Configuration

> **Scope:** Supabase provider settings, OpenSlate application settings, and secret boundaries.

Configuration has three owners. Local development uses the private root `.env` described by [`.env.example`](../../.env.example). A production Compose installation has an owner-only provider environment file consumed for Compose interpolation and a separate owner-only application environment file mounted into the API and worker. Offline backup and restore use a separate strict version 3 JSON operations file. Do not merge the application and provider credentials into a browser or shared process environment.

The root validator is [`backend/app/core/config/environment.py`](../../backend/app/core/config/environment.py), invoked by [`scripts/environment.py`](../../scripts/environment.py). The helper requires an owner-only local environment file, limits which values are passed to Docker, fixes the Compose project and file set, and rejects unknown or unresolved values. The production input paths and responsibilities are listed in [`infra/supabase/README.md`](../../infra/supabase/README.md#per-installation-inputs).

## Database and installation identity

| Setting | Consumer | Sensitivity and contract |
| --- | --- | --- |
| `OPENSLATE_INSTANCE_ID` | Compose project, database `cluster_name`, application/provider admission | Installation identity; unique per client/worktree. |
| `OPENSLATE_INSTANCE_ROOT` | Local instance paths and log-root validation | Private absolute path. Production overlay has separately named absolute paths below. |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE` | Direct SQLAlchemy/Psycopg connection and instance admission | Internal endpoint; use `db:5432/postgres` inside the production Compose network and the admitted loopback mapping in development. `POSTGRES_PORT` must match `SUPABASE_DB_PORT`. |
| `DATABASE_BOOTSTRAP_URL` | `operations/provision_database_role.py` only | High-privilege `supabase_admin` URL using the provider bootstrap password. Never pass it to the API, worker, frontend, or tests as a runtime connection. |
| `MIGRATION_DATABASE_URL` | Alembic and guarded operator/reset commands | Secret URL for `openslate_owner`; owns application schema changes. |
| `DATABASE_URL` | FastAPI, scanner worker, and Storage provisioning | Secret URL for constrained `openslate_runtime` in normal runtime. Direct PostgreSQL access remains server-side. |

`POSTGRES_PASSWORD` is the provider bootstrap password, not the application runtime password. The key generator [`backend/operations/supabase_keys.py`](../../backend/operations/supabase_keys.py) writes generated per-installation key material to a new owner-only file and refuses to overwrite an existing file. Connection URLs must target the same admitted installation and use their intended role; no SQLite or legacy inspector connection is supported.

## Supabase provider environment

The provider file supplies values interpolated into the pinned Compose services. Keep it owner-only and never print rendered Compose output; interpolation contains credentials.

| Setting group | Names | Boundary |
| --- | --- | --- |
| Database and Auth signing | `POSTGRES_PASSWORD`, `JWT_SECRET`, `JWT_KEYS`, `JWT_JWKS`, `JWT_EXPIRY` | Provider services only. `JWT_KEYS` contains private signing material. `JWT_JWKS` also carries legacy symmetric compatibility material and remains private; only Auth's filtered public JWKS is suitable for token verification by clients. |
| Gateway compatibility | `ANON_KEY`, `SERVICE_ROLE_KEY`, `ANON_KEY_ASYMMETRIC`, `SERVICE_ROLE_KEY_ASYMMETRIC`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Provider gateway/service configuration. `SERVICE_ROLE_KEY` and `SUPABASE_SECRET_KEY` are privileged server credentials; neither belongs in browser output. |
| Studio and metadata | `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `PG_META_CRYPTO_KEY` | Operator-only credentials and metadata encryption material. Studio is an administrative surface, not a read-only replacement for pgweb. |
| Provider URLs | `API_EXTERNAL_URL`, `SUPABASE_AUTH_ISSUER`, `SUPABASE_PUBLIC_URL`, `SITE_URL`, `AUTH_TEMPLATE_BASE_URL` | Auth issuer must equal `API_EXTERNAL_URL` and backend `SUPABASE_AUTH_ISSUER`. `SITE_URL` is the browser origin. `SUPABASE_PUBLIC_URL` is the operator gateway URL; `AUTH_TEMPLATE_BASE_URL` is an internal FastAPI route, not a public provider endpoint. |
| Auth email delivery | `SMTP_ADMIN_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SENDER_NAME` | Supabase Auth invitations and recovery. Development uses Mailpit. Production requires a real configured SMTP service. Credentials stay in the provider file and are not consumed by an application SMTP outbox. |
| Development host ports | `SUPABASE_DB_PORT`, `SUPABASE_API_PORT`, `SUPABASE_MAIL_PORT` | Optional loopback host ports, defaulting to 55432, 58000, and 58025. Concurrent instances require distinct ports. Production does not publish the PostgreSQL port. |

## Application process configuration

FastAPI settings are defined by [`backend/app/core/config/settings.py`](../../backend/app/core/config/settings.py). The static frontend uses same-origin relative API paths; it does not need Supabase credentials or runtime browser configuration.

| Setting area | Names | Consumer and boundary |
| --- | --- | --- |
| Provider API access | `SUPABASE_URL`, `SUPABASE_AUTH_ISSUER`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_TIMEOUT_SECONDS` | Server-side Auth/Storage integration. `SUPABASE_URL` is the loopback gateway in host-run development and `http://api-gw:8000` in production containers. `SUPABASE_SECRET_KEY` stays server-only. |
| Application sessions | `SUPABASE_SESSION_ENCRYPTION_KEY`, `AUTH_REFRESH_TOKEN_DAYS` | Encrypts provider refresh credentials at rest and bounds local application session lifetime. It does not sign Supabase authentication tokens. |
| OpenSlate-specific signing | `PUBLICATION_SIGNING_KEY`, `SECURITY_EVENT_SERVER_KEY` | Server-only application capabilities and security-event authentication. `PUBLICATION_SIGNING_KEY` signs short-lived Sandbox publication capabilities, not user login tokens. |
| Browser origin and static UI | `PUBLIC_ORIGIN`, `WEB_ASSETS_ROOT` | Trusted application origin and static export path. HTTPS is required outside relaxed local development and tests; the static root is required outside those environments. |
| Process and database limits | `ENVIRONMENT`, `LOG_DIR`, `BACKEND_BIND_HOST`, `BACKEND_PORT`, `SERVER_MAX_CONCURRENCY`, `SERVER_KEEP_ALIVE_SECONDS`, `REQUEST_BODY_MAX_BYTES`, `DATABASE_POOL_SIZE`, `DATABASE_MAX_OVERFLOW`, `DATABASE_POOL_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_STATEMENT_TIMEOUT_MS`, `READINESS_POOL_TIMEOUT_SECONDS`, `READINESS_CONNECT_TIMEOUT_SECONDS`, `READINESS_STATEMENT_TIMEOUT_MS`, `READINESS_CALLER_TIMEOUT_SECONDS` | Server bind, bounded work, database use, logs, and the shared dependency-readiness caller deadline. |
| Provider mail configuration visibility | `SMTP_HOST`, `SMTP_PORT`, `SMTP_ADMIN_EMAIL` | Non-secret facts projected into the API for readiness. Missing facts produce `not_configured`; presence does not prove email delivery. The API does not receive the SMTP password. |
| Application policy | `LIFECYCLE_PURGE_ENABLED` | Explicitly controls the disabled-by-default purge path. |

The development `.env` also contains `BACKEND_URL`, `FRONTEND_DEV_PORT`, `ADMIN_EMAIL`, `ADMIN_USERNAME`, and `SEED_ACCESS_TOKEN` for local launch and first-admin invitation. `SEED_ACCESS_TOKEN` is reserved for sample-data tooling, which is retired during the schema redesign. `BACKEND_BIND_HOST` and `BACKEND_PORT` are local FastAPI settings; `FRONTEND_DEV_PORT` is the Next hot-reload port. The Next launcher receives only the required direct nonsecret development values and its derived HMR origin, never the complete root environment.

## Production Compose inputs and scanner paths

The production overlay adds Compose-only inputs in addition to the provider file and application file:

| Setting group | Names | Contract |
| --- | --- | --- |
| Versioned images | `OPENSLATE_SERVER_IMAGE`, `OPENSLATE_CLAMAV_IMAGE`, `OPENSLATE_CADDY_IMAGE` | Release-specific image names for the FastAPI/static UI, ClamAV, and Caddy builds. The Compose files do not publish these images. |
| Application file and logs | `OPENSLATE_APP_ENV_FILE`, `OPENSLATE_LOG_ROOT` | Existing owner-only application environment file and private host log directory. API and scanner worker use separate log subdirectories. |
| Scanner | `SCANNER_DEFINITIONS_DIR`, `SCANNER_MANIFEST_PATH`, `FILES_CLAMAV_HOST`, `FILES_CLAMAV_PORT` | Existing verified immutable definition generation and matching manifest. Mounts are read-only. A failed or unverified scanner does not admit clean file state. |
| Caddy listener and TLS | `CADDY_CONFIG_PATH`, `CADDY_TLS_DIR`, `CADDY_PUBLIC_BIND_HOST`, `CADDY_HTTPS_PORT` | Existing rendered Caddyfile, optional existing custom TLS directory, intended public bind, and HTTPS port. The Caddy generator is `infra/caddy/generate_config.py`. |
| Local resource bounds | `CLAMAV_MEMORY_LIMIT`, `CLAMAV_CPUS`, `CLAMAV_PIDS_LIMIT`, `FILES_CLAMAV_PORT` | Developer Compose/container limits, not browser configuration. |

Production application environment files use the current `Settings` fields, including the database connection, provider endpoints and keys, application signing/encryption keys, `PUBLIC_ORIGIN`, `WEB_ASSETS_ROOT`, runtime limits, and log path. Do not put `POSTGRES_PASSWORD`, `JWT_KEYS`, `JWT_JWKS`, Studio credentials, or Auth SMTP credentials into the application file. Exact paths and environment relationships are documented in the [production overlay contract](../../infra/supabase/README.md#production-application-overlay).

## Backup and restore configuration

[`packaging/backup/backup-config.example.json`](../../packaging/backup/backup-config.example.json) documents the strict format version 3 operations configuration. It names the installation and Compose project, deployment profile, Compose root, provider and application environment files, optional Caddy/TLS inputs, Restic repository and password file, staging directory, and completion marker. These files and directories are protected operator inputs; the backup process creates an encrypted Restic snapshot of stopped installation volumes plus the selected private configuration. The exact target-instance and closed-ingress sequence is in [`infra/supabase/RESTORE.md`](../../infra/supabase/RESTORE.md).

## Removed configuration boundaries

There is no `DATABASE_INSPECTOR_URL`, pgweb passfile, `FILES_STORAGE_ROOT`, local password-hash or `AUTH_JWT_*` signing configuration, or SMTP outbox configuration. Provider SMTP is used only by Supabase Auth. Do not preserve old variable names as fallback aliases; the current environment validator is intentionally strict.
