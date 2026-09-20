# Configuration

> **Scope:** Current configuration ownership and secret boundaries.

The ignored root `.env` is the canonical local configuration input. It supplies database URLs, JWT configuration, public origin/CORS, backend limits, storage root, scanner settings, and development administrator/bootstrap values. The environment validator rejects missing, blank, invalid, duplicate, or unresolved values.

| Setting area | Consumer | Sensitivity |
| --- | --- | --- |
| `DATABASE_URL` | FastAPI runtime login | secret |
| `MIGRATION_DATABASE_URL` | Alembic owner connection | secret |
| `DATABASE_BOOTSTRAP_URL` | role provisioning only | high-privilege secret |
| `DATABASE_INSPECTOR_URL` | role provisioning and pgweb passfile generation | secret, read-only login |
| `AUTH_JWT_*` | FastAPI Identity | signing secret except issuer/audience |
| `PUBLIC_ORIGIN`, `FRONTEND_URL`, `CORS_ORIGINS` | FastAPI, Caddy, and direct frontend development origin boundary | configuration |
| `FILES_STORAGE_ROOT` | FastAPI file service | server-only path |
| `FILES_CLAMAV_*` | scanner worker | server-only operations |
| `SMTP_ENABLED` | Optional delivery admission | configuration |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_TRANSPORT`, `SMTP_FROM` | Optional delivery worker | server-only configuration |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | Optional delivery worker | secret |
| `SMTP_DELIVERY_ENCRYPTION_KEY` | Encrypted delivery outbox | high-privilege secret |
| `SMTP_TIMEOUT_SECONDS`, `SMTP_DELIVERY_*` limits | Optional delivery worker | server-only limits |
| `PGWEB_BIND_HOST`, `PGWEB_PORT` | Optional local pgweb listener | loopback development configuration |
| `GATEWAY_PUBLIC_HOST`, `GATEWAY_BIND_HOST`, `GATEWAY_PORT` | Caddy gateway address | browser-facing configuration |

The frontend receives only its fixed allowlist through generated
`frontend/.env.local`: host settings, the public feature flag, and the
server-only `BACKEND_URL` used by the Next.js development rewrite. It never
receives database URLs, bootstrap credentials, signing material, storage
paths, or scanner settings. Production API traffic remains on Caddy.

SMTP is disabled by default. When enabled, configuration validation requires a
complete transport and encryption-key set; plain SMTP is accepted only for a
loopback development server. The standalone backup foundation uses its own
strict JSON operations document and protected password files rather than root
environment secrets. Native installer configuration is not yet a supported
customer contract.

The environment helper converts `DATABASE_INSPECTOR_URL` into an ignored
owner-only PostgreSQL passfile before invoking Compose. The pgweb container sees
only that mounted passfile and its non-secret host, port, database, and role
arguments; it does not receive bootstrap, owner, runtime, JWT, SMTP, or
administrator secrets.

For Compose commands, the environment helper renders the secret-free Caddyfile
at `.agent-runtime/caddy/Caddyfile` and supplies only its path plus the gateway
listener values. `PUBLIC_ORIGIN`, `AUTH_JWT_ISSUER`, and `CORS_ORIGINS` resolve
to the HTTPS gateway; the host-run frontend and backend URLs remain their
loopback upstream addresses.
