# Configuration Architecture

> **Scope:** Root, backend, frontend, Supabase CLI, image, test, and operational settings affecting runtime or verification.
> **Audience:** Developers and operators preparing local environments, CI jobs, images, or configuration reviews.
> **Related documents:** [Infrastructure](11-infrastructure.md), [Deployment](12-deployment-architecture.md), [Observability](18-observability.md), [Architecture index](README.md)

## State classifications and value handling

- **Implemented** means the setting is read by checked-in code or consumed by checked-in tooling.
- **Configured** means a static value is present in checked-in configuration.
- **Derived** means the repository constructs the value from another setting.
- **Absent** means no example or default is supplied by the repository.
- **Sensitive** values below are named only; this document contains no real key,
  password, token, or connection-string value.

The root `.env` is ignored by Git. `.env.example` contains placeholders only.
`supabase status -o env` is the local source for generated connection and key
names; its output is not a configuration file to commit. Backend
`SettingsConfigDict` reads `../.env` and `.env` from the backend working
directory and ignores extra variables (`backend/app/core/config/settings.py`).
The role-provisioning script reads required values directly from its process
environment and does not load `.env` itself.

## Application environment inventory — Implemented

The required/default column distinguishes a Pydantic default from an
operational requirement. A setting can be optional in `Settings` and still be
required by a specific integration path.

| Setting or alias              | Required/default                                                                                        | Sensitive                                 | Read site and effect                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_NAME`                    | Optional; default `OpenSlate API`                                                                       | No                                        | `backend/app/core/config/settings.py:Settings.app_name`; FastAPI title in `backend/app/main.py:create_app`.                            |
| `ENVIRONMENT`                 | Optional; default `development`                                                                         | No                                        | `Settings.environment`; `provision_database_role.py` and `bootstrap_admin.py` use local-environment checks.                            |
| `DATABASE_URL`                | Required by `Settings`; no default                                                                      | Yes: database URL may contain credentials | `Settings.database_url`; `backend/app/core/database/session.py:get_engine`; fallback for Alembic when migration URL is absent.         |
| `MIGRATION_DATABASE_URL`      | Optional in `Settings`; falls back to `DATABASE_URL` for Alembic; required by role provisioning         | Yes: owner connection URL                 | `backend/migrations/env.py`; `provision_database_role.py:_required_environment`.                                                       |
| `OPENSLATE_DATABASE_PASSWORD` | Required by `provision_database_role.py`; no default                                                    | Yes                                       | `backend/scripts/provision_database_role.py`; used to create or alter `openslate_runtime`, never printed.                              |
| `SUPABASE_URL`                | Optional in `Settings`; required for configured Supabase Auth/Admin/Realtime operation                  | No                                        | `Settings.supabase_url`; `SupabaseAdminClient`; JWT JWKS fallback; local `.env.example` maps it from CLI `API_URL`.                    |
| `SUPABASE_PUBLISHABLE_KEY`    | Optional backend field; required by frontend public-key client through its alias                        | No: publishable by design                 | Backend compatibility/config field; root `.env.example` maps CLI `ANON_KEY`; frontend receives `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. |
| `SUPABASE_ANON_KEY`           | Optional compatibility alias for `SUPABASE_PUBLISHABLE_KEY`                                             | No                                        | `Settings.supabase_publishable_key` via `AliasChoices`; not the preferred example name.                                                |
| `SUPABASE_SECRET_KEY`         | Optional in `Settings`; required for server-side invitation, Auth administration, and backend Broadcast | Yes: server-only service key              | `backend/app/core/integrations/supabase.py:SupabaseAdminClient`; never passed to browser code.                                         |
| `SUPABASE_AUTH_REDIRECT_URL`  | Optional in `Settings`; required by `SupabaseAdminClient.invite_user`                                   | No                                        | Invitation `redirect_to` in `backend/app/core/integrations/supabase.py`; local example points to `/auth/callback`.                     |
| `SUPABASE_JWT_ISSUER`         | Optional in `Settings`; required by JWT verification unless the verification seam supplies one          | No                                        | `backend/app/core/security/supabase.py:_verification_settings`; expected local value is derived from the API URL plus `/auth/v1`.      |
| `SUPABASE_JWKS_URL`           | Optional; derived as `SUPABASE_URL/auth/v1/.well-known/jwks.json` when absent                           | No                                        | `backend/app/core/security/supabase.py:_verification_settings`; used by PyJWT JWKS lookup.                                             |
| `SUPABASE_JWT_AUDIENCE`       | Optional; default `authenticated`                                                                       | No                                        | `Settings.supabase_jwt_audience`; JWT verification audience.                                                                           |
| `SUPABASE_AUDIENCE`           | Optional compatibility alias for `SUPABASE_JWT_AUDIENCE`                                                | No                                        | `Settings.supabase_jwt_audience` via `AliasChoices`.                                                                                   |
| `LIFECYCLE_PURGE_ENABLED`     | Optional; default `false`                                                                               | No                                        | `Settings.lifecycle_purge_enabled`; backend lifecycle purge behavior. It is not present in `.env.example`.                             |
| `CORS_ORIGINS`                | Optional; default `['http://localhost:3000']`                                                           | No                                        | `Settings.cors_origins`; `CORSMiddleware` in `backend/app/main.py`. The example supplies a JSON list string.                           |
| `BOOTSTRAP_ADMIN_CONFIRM`     | Optional; default false                                                                                 | No                                        | `backend/scripts/bootstrap_admin.py:_confirmation_from_environment`; permits non-local bootstrap only when true-like.                  |
| `SUPABASE_ACCESS_TOKEN`       | Optional only for sample-data seeding; no default; `--access-token` takes precedence                    | Yes: access token                         | `backend/scripts/seed_sample_data.py:_access_token`; the token is sent to the FastAPI API and not printed.                             |
| `API_BASE_URL`                | Optional; default `http://localhost:8000`                                                               | No                                        | `backend/scripts/seed_sample_data.py:main`; sample-data API destination.                                                               |
| `TEST_DATABASE_URL`           | Optional; integration tests skip when absent; no default                                                | Yes: database URL may contain credentials | `backend/tests/conftest.py` and PostgreSQL integration tests; guards loopback, port 54322, and database `postgres`.                    |

`Settings` uses `extra="ignore"`, so variables not listed as fields do not
become backend settings merely by being placed in `.env`.

### Supabase CLI output mapping — Implemented

`supabase status -o env` emits generated local values. The repository uses the
following names without recording their values:

| CLI output name    | Required/default                                        | Sensitive                    | Mapped/read site                                                                      |
| ------------------ | ------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `API_URL`          | Generated after `supabase start`; no repository default | No                           | Mapped to `SUPABASE_URL` and used to derive frontend public URL and backend JWT URLs. |
| `DB_URL`           | Generated after `supabase start`; no repository default | Yes: owner database URL      | Mapped to `MIGRATION_DATABASE_URL` with the `postgresql+psycopg` SQLAlchemy scheme.   |
| `ANON_KEY`         | Generated after `supabase start`; no repository default | No: publishable key          | Mapped to `SUPABASE_PUBLISHABLE_KEY` and the frontend public alias.                   |
| `SERVICE_ROLE_KEY` | Generated after `supabase start`; no repository default | Yes: server-only service key | Mapped to `SUPABASE_SECRET_KEY`; backend integrations only.                           |

## Frontend environment inventory — Implemented

| Setting                                | Required/default                                                                                 | Sensitive                               | Read site and effect                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKEND_URL`                          | Optional; default `http://localhost:8000`                                                        | No: internal endpoint, not a credential | `frontend/next.config.ts` rewrites and `frontend/src/app/bff/[...path]/route.ts`; the rewrite destination is evaluated by Next configuration and the BFF reads the process environment. |
| `NEXT_PUBLIC_SUPABASE_URL`             | Required by `requiredPublicEnv`; no default                                                      | No                                      | `frontend/src/lib/supabase/server.ts`, `frontend/src/proxy.ts`, and `frontend/src/components/realtime-provider.tsx`; public client endpoint.                                            |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Required by `requiredPublicEnv`; no default                                                      | No: publishable by design               | Same frontend Supabase client and Realtime provider sites; root `.env.example` derives it from `SUPABASE_PUBLISHABLE_KEY`.                                                              |
| `NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED`  | Optional; effective default false because code checks equality with `"true"`                     | No                                      | `frontend/src/components/lifecycle-dialog.tsx`; controls the visible purge option independently of the backend flag. It is absent from `.env.example`.                                  |
| `NODE_ENV`                             | Framework-controlled; development/production behavior, no application default in this repository | No                                      | `frontend/src/lib/auth-cookies.ts` sets `Secure` in production; `frontend/src/proxy.ts` permits development CSP behavior. The image sets `NODE_ENV=production`.                         |
| `BASE_URL`                             | Optional; default `http://localhost:3000`                                                        | No                                      | `frontend/playwright.config.ts`; Playwright base URL and web-server URL.                                                                                                                |
| `CI`                                   | Optional; absent behaves as false                                                                | No                                      | `frontend/playwright.config.ts`; enables CI retries, multi-browser projects, list plus HTML reporting, and production server selection.                                                 |
| `PLAYWRIGHT_USE_PRODUCTION`            | Optional; effective false outside CI, true when exactly `1`                                      | No                                      | `frontend/playwright.config.ts`; selects `npm run start` instead of `npm run dev`.                                                                                                      |

The public aliases do not make the Supabase secret available to the browser.
The browser-facing code contains no `SUPABASE_SECRET_KEY` read.

## Supabase CLI configuration inventory — Configured

All values in this table are static values in `supabase/config.toml`.
Sensitive runtime-generated keys are not values in that file and are therefore
not reproduced here.

| Setting                                   | Configured value / default                                    | Sensitive | Read site and effect                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `project_id`                              | `openslate`                                                   | No        | Supabase CLI project identity.                                                                                   |
| `api.enabled`                             | `true`                                                        | No        | Supabase API gateway is started.                                                                                 |
| `api.port`                                | `54321`                                                       | No        | Local API/Auth/Realtime/Storage surface.                                                                         |
| `api.tls.enabled`                         | `false`                                                       | No        | Local API TLS is disabled.                                                                                       |
| `api.schemas`                             | `['graphql_public']`                                          | No        | Data API exposure is limited to the managed empty GraphQL surface; application tables are not exposed.           |
| `api.extra_search_path`                   | `['extensions']`                                              | No        | Supabase API search path addition.                                                                               |
| `api.max_rows`                            | `1000`                                                        | No        | Supabase API row cap.                                                                                            |
| `db.port`                                 | `54322`                                                       | No        | Local PostgreSQL port.                                                                                           |
| `db.shadow_port`                          | `54320`                                                       | No        | Supabase CLI shadow database port.                                                                               |
| `db.health_timeout`                       | `2m`                                                          | No        | Supabase CLI database health wait.                                                                               |
| `db.major_version`                        | `17`                                                          | No        | Local PostgreSQL major version.                                                                                  |
| `db.pooler.enabled`                       | `false`                                                       | No        | Connection pooler is not started.                                                                                |
| `db.pooler.port`                          | `54329` when configured; inactive while disabled              | No        | Reserved pooler setting; no application connection uses it.                                                      |
| `db.pooler.pool_mode`                     | `transaction` when enabled                                    | No        | Reserved pooler setting.                                                                                         |
| `db.pooler.default_pool_size`             | `20` when enabled                                             | No        | Reserved pooler setting.                                                                                         |
| `db.pooler.max_client_conn`               | `100` when enabled                                            | No        | Reserved pooler setting.                                                                                         |
| `db.migrations.enabled`                   | `false`                                                       | No        | Supabase does not apply application migrations.                                                                  |
| `db.seed.enabled`                         | `false`                                                       | No        | Supabase does not run seed files.                                                                                |
| `realtime.enabled`                        | `true`                                                        | No        | Realtime is available for private Broadcast.                                                                     |
| `studio.enabled`                          | `true`                                                        | No        | Studio is started.                                                                                               |
| `studio.port`                             | `54323`                                                       | No        | Local Studio port.                                                                                               |
| `studio.api_url`                          | `http://127.0.0.1:54321`                                      | No        | Studio API endpoint.                                                                                             |
| `local_smtp.enabled`                      | `true`                                                        | No        | Mailpit local email sink is started.                                                                             |
| `local_smtp.port`                         | `54324`                                                       | No        | Local Mailpit port.                                                                                              |
| `storage.enabled`                         | `true`                                                        | No        | Supabase Storage is started.                                                                                     |
| `storage.file_size_limit`                 | `50MiB`                                                       | No        | Local Storage file-size limit.                                                                                   |
| `storage.s3_protocol.enabled`             | `false`                                                       | No        | Storage S3 protocol is inactive.                                                                                 |
| `storage.analytics.enabled`               | `false`                                                       | No        | Storage analytics is inactive.                                                                                   |
| `storage.vector.enabled`                  | `false`                                                       | No        | Storage vector support is inactive.                                                                              |
| `auth.enabled`                            | `true`                                                        | No        | Supabase Auth is started.                                                                                        |
| `auth.site_url`                           | `http://localhost:3000`                                       | No        | Auth site URL for local flows.                                                                                   |
| `auth.additional_redirect_urls`           | `/auth/callback` and `/auth/setup` on `http://localhost:3000` | No        | Only the two documented invitation-flow redirects are allowed locally.                                           |
| `auth.jwt_expiry`                         | `3600` seconds                                                | No        | Access-token lifetime.                                                                                           |
| `auth.enable_refresh_token_rotation`      | `true`                                                        | No        | Auth refresh-token rotation.                                                                                     |
| `auth.refresh_token_reuse_interval`       | `10`                                                          | No        | Auth refresh-token reuse interval.                                                                               |
| `auth.enable_signup`                      | `false`                                                       | No        | Global public signup is disabled.                                                                                |
| `auth.enable_anonymous_sign_ins`          | `false`                                                       | No        | Anonymous sign-in is disabled.                                                                                   |
| `auth.minimum_password_length`            | `12`                                                          | No        | Auth password minimum.                                                                                           |
| `auth.password_requirements`              | `lower_upper_letters_digits_symbols`                          | No        | Auth password complexity.                                                                                        |
| `auth.rate_limit.email_sent`              | `2`                                                           | No        | Local Auth email-send rate limit.                                                                                |
| `auth.rate_limit.sms_sent`                | `30`                                                          | No        | Local Auth SMS-send rate limit.                                                                                  |
| `auth.rate_limit.anonymous_users`         | `30`                                                          | No        | Local Auth anonymous-user rate limit.                                                                            |
| `auth.rate_limit.token_refresh`           | `150`                                                         | No        | Local Auth refresh rate limit.                                                                                   |
| `auth.rate_limit.sign_in_sign_ups`        | `30`                                                          | No        | Local Auth sign-in/sign-up rate limit.                                                                           |
| `auth.rate_limit.token_verifications`     | `30`                                                          | No        | Local Auth token-verification rate limit.                                                                        |
| `auth.rate_limit.web3`                    | `30`                                                          | No        | Local Auth Web3 rate limit.                                                                                      |
| `auth.email.enable_signup`                | `true` for the email provider                                 | No        | Email login/invitation provider remains available; global signup remains disabled by `auth.enable_signup=false`. |
| `auth.email.double_confirm_changes`       | `true`                                                        | No        | Email change confirmation.                                                                                       |
| `auth.email.enable_confirmations`         | `true`                                                        | No        | Email confirmation behavior.                                                                                     |
| `auth.email.secure_password_change`       | `true`                                                        | No        | Auth password-change protection.                                                                                 |
| `auth.email.max_frequency`                | `1s`                                                          | No        | Email provider frequency limit.                                                                                  |
| `auth.email.otp_length`                   | `6`                                                           | No        | Email OTP length.                                                                                                |
| `auth.email.otp_expiry`                   | `3600` seconds                                                | No        | Email OTP lifetime.                                                                                              |
| `auth.email.template.invite.subject`      | `You have been invited to OpenSlate`                          | No        | Local invitation subject.                                                                                        |
| `auth.email.template.invite.content_path` | `./supabase/templates/invite.html`                            | No        | Local invitation template.                                                                                       |
| `auth.sms.enable_signup`                  | `false`                                                       | No        | SMS signup is inactive.                                                                                          |
| `auth.sms.enable_confirmations`           | `false`                                                       | No        | SMS confirmations are inactive.                                                                                  |
| `auth.sms.template`                       | `Your code is {{ .Code }}`                                    | No        | SMS template if the provider is used.                                                                            |
| `auth.sms.max_frequency`                  | `5s`                                                          | No        | SMS provider frequency limit.                                                                                    |
| `edge_runtime.enabled`                    | `false`                                                       | No        | Edge functions/runtime are inactive.                                                                             |
| `analytics.enabled`                       | `false`                                                       | No        | Supabase analytics is inactive.                                                                                  |

## Static build and verification settings — Implemented

These are not secrets and are not environment substitutions:

- `backend/pyproject.toml` requires Python `>=3.12,<3.15`, configures pytest
  coverage failure below 80%, Ruff's 100-character line length and `py312`
  target, and strict mypy for Python 3.12.
- `backend/alembic.ini` sends logs to stderr with root and SQLAlchemy level
  `WARN`, Alembic level `INFO`, and format `%(levelname)-5.5s [%(name)s] %(message)s`.
- `frontend/next.config.ts` sets standalone output, React strict mode, typed
  routes, backend/docs rewrites, and fixed response security headers.
- `infra/docker/frontend.Dockerfile` sets `NEXT_TELEMETRY_DISABLED=1`, `NODE_ENV=production`,
  `HOSTNAME=0.0.0.0`, and `PORT=3000` in its build/runtime stages.
- `infra/docker/backend.Dockerfile` sets `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`,
  `UV_COMPILE_BYTECODE=1`, `UV_LINK_MODE=copy`, and the virtualenv `PATH`.
- `frontend/package.json` requires Node `>=24.0.0`; the frontend workflow and
  frontend image both use Node 24.
