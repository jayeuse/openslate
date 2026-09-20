# Configuration

> **Scope:** FastAPI-only production configuration ownership and secret boundaries.

The ignored root `.env` is the canonical local configuration input. It supplies database URLs, JWT configuration, the canonical browser origin, backend limits, storage root, scanner settings, and development administrator/bootstrap values. `WEB_ASSETS_ROOT` is omitted for ordinary hot-reload development and becomes required for production or an explicit production-like static run. The environment validator rejects missing, blank, invalid, duplicate, unknown, or unresolved values.

| Setting area                                            | Consumer                                                                                            | Sensitivity                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `DATABASE_URL`                                          | FastAPI runtime login                                                                               | secret                                |
| `MIGRATION_DATABASE_URL`                                | Alembic owner connection                                                                            | secret                                |
| `DATABASE_BOOTSTRAP_URL`                                | role provisioning only                                                                              | high-privilege secret                 |
| `DATABASE_INSPECTOR_URL`                                | role provisioning and pgweb passfile generation                                                     | secret, read-only login               |
| `AUTH_JWT_*`                                            | FastAPI Identity                                                                                    | signing secret except issuer/audience |
| `PUBLIC_ORIGIN`                                         | Daily Next.js browser origin for cookie/Origin validation; production uses the Caddy browser origin | configuration                         |
| `WEB_ASSETS_ROOT`                                       | FastAPI static frontend delivery; required outside development/test                                 | server-only path                      |
| `FILES_STORAGE_ROOT`                                    | FastAPI file service                                                                                | server-only path                      |
| `FILES_CLAMAV_*`                                        | scanner worker                                                                                      | server-only operations                |
| `SMTP_ENABLED`                                          | Optional delivery admission                                                                         | configuration                         |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_TRANSPORT`, `SMTP_FROM` | Optional delivery worker                                                                            | server-only configuration             |
| `SMTP_USERNAME`, `SMTP_PASSWORD`                        | Optional delivery worker                                                                            | secret                                |
| `SMTP_DELIVERY_ENCRYPTION_KEY`                          | Encrypted delivery outbox                                                                           | high-privilege secret                 |
| `SMTP_TIMEOUT_SECONDS`, `SMTP_DELIVERY_*` limits        | Optional delivery worker                                                                            | server-only limits                    |
| `BACKEND_BIND_HOST`, `BACKEND_PORT`                     | Loopback FastAPI listener; `BACKEND_PORT` is the development proxy target                           | local development configuration       |
| `FRONTEND_DEV_PORT`                                     | Direct daily `next dev` browser origin                                                              | local development configuration       |
| `PGWEB_BIND_HOST`, `PGWEB_PORT`                         | Optional local pgweb listener                                                                       | loopback development configuration    |

The static frontend has no production runtime configuration. It uses same-origin
relative API requests, so public endpoint, database, bootstrap, signing,
storage, scanner, and gateway secrets never enter generated browser files. In
daily development, the Next launcher parses `FRONTEND_DEV_PORT`,
`BACKEND_BIND_HOST`, `BACKEND_PORT`, and `PUBLIC_ORIGIN` for its development-only
`/api` proxy and HMR allowlist. It passes only the three direct nonsecret values
and the derived exact HMR-origin hostname to Next; it never forwards the root
environment or its secrets, authenticates, or makes production server-side
application requests.

`PUBLIC_ORIGIN` is the one trusted browser origin for the active environment.
For `ENVIRONMENT=development` with FastAPI bound to loopback, it must use HTTP
or HTTPS on `FRONTEND_DEV_PORT` and may use `localhost`, a loopback IP, a private
IP, or a link-local IP. `AUTH_JWT_ISSUER` must equal that origin. This permits a
local or LAN browser to use Next's development proxy while FastAPI stays private
on the host. LAN testing is opt-in: start Next with `--hostname 0.0.0.0` and set
both values to the actual private or link-local browser URL. A non-loopback
FastAPI bind does not receive this development transport relaxation. Test and
production configuration retain their strict transport and host validation.
Production browser traffic is same-origin, so
`CORS_ORIGINS`, `FRONTEND_URL`, and the former frontend server bind, port, URL,
logging, and container settings are removed rather than retained as aliases.
`BACKEND_URL` remains server-only operator configuration; it is not browser
configuration or a development proxy target.

SMTP is disabled by default. When enabled, configuration validation requires a complete transport and encryption-key set; plain SMTP is accepted only for a loopback development server. The standalone backup foundation uses its own strict JSON operations document and protected password files rather than root environment secrets. Native installer configuration is not yet a supported customer contract.

The environment helper converts `DATABASE_INSPECTOR_URL` into an ignored
owner-only PostgreSQL passfile before invoking Compose. The pgweb container sees
only that mounted passfile and its non-secret host, port, database, and role
arguments; it does not receive bootstrap, owner, runtime, JWT, SMTP, or
administrator secrets.

Daily Compose commands use only PostgreSQL and optional pgweb. Caddy's installed
`gateway` profile stays disabled until an operator starts a manually prepared
production preview. Production-level acceptance supplies Caddy's separate
listener and TLS inputs outside the daily development environment. Production
Caddy has one FastAPI upstream, and FastAPI reads `WEB_ASSETS_ROOT` to deliver
the matching static export.
