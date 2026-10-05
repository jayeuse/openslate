# OpenSlate Supabase infrastructure

This directory contains the pinned provider services for one OpenSlate installation. The implementation contract is [PLAN.md](PLAN.md). Supabase Database is PostgreSQL; this stack replaces the standalone PostgreSQL container and pgweb topology while keeping direct SQLAlchemy/Alembic connections. It does not migrate existing data. Realtime, Functions, Analytics, and Supavisor are not started.

## Version and source

The service wiring follows Supabase [`self-hosted/v0.8.2`](https://github.com/supabase/supabase/tree/self-hosted/v0.8.2/docker), an annotated tag whose peeled commit is `564eab8ad7840b13324f68b1bfac074ef8d51c21`. All image references are pinned to registry index digests, checked with `docker buildx imagetools inspect`. All seven upstream database initialization files are copied from that tag and mounted at its original init paths. These create some provider-owned schema and roles for disabled components; the Realtime, Functions, Analytics, and Supavisor services remain stopped. In particular, `webhooks.sql` creates the role that the upstream `roles.sql` password step needs. `upstream/envoy/` starts from its Envoy assets and removes routes/clusters for unused services; it also writes the generated listener into a private `/tmp` filesystem so the image root remains read-only.

| Service | Image tag | Pinned index digest |
| --- | --- | --- |
| Database | `supabase/postgres:17.6.1.136` | `f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00` |
| Auth | `supabase/gotrue:v2.196.0` | `c0c25187a6b835e65a6f6e6c6b39d090e832d40e6de5186f2c038e0411944232` |
| Storage | `supabase/storage-api:v1.74.0` | `f1546fac6d1c7e345428ac904bfaa7be7cecd50a1f549fe1cf38c628a7b15c85` |
| Gateway | `envoyproxy/envoy:v1.39.1` | `57e14a549d7bd43c8d3f6d03e8cfa653e037d4b38e133acd9b54f38c524401b4` |
| Studio | `supabase/studio:2026.09.07-sha-7996410` | `94a2a9d2906e8b4109e55159a62e241c3044709a492913ea8edd34b14973d288` |
| postgres-meta | `supabase/postgres-meta:v0.99.0` | `9a079ac1c94d89629262822a4bd1902d5b1be4adb464e5a0a8fd078aaed72158` |
| PostgREST | `postgrest/postgrest:v14.17` | `c9dc201e555f5d8e37e7f39cdd4df0229774996e213bfd7de8d10ac609030f2c` |
| imgproxy | `darthsim/imgproxy:v3.31.4` | `73c5dda13199745b0d2d00e4149d4a589c5b2e205dbf335ca05eca8276b54712` |
| Development mail catcher | `axllent/mailpit:v1.27.9` | `b004cc0672d0692f097ba8ab9e5956ae08eeafee3d0a6bf2ab239750101ac538` |

The two provider DNS/port pairs are `auth:9999` and `storage:5000`; the internal gateway is `api-gw:8000` and PostgreSQL is `db:5432`. The gateway publishes `127.0.0.1:${SUPABASE_API_PORT:-58000}` for host-run development and operator Studio access. PostgreSQL publishes `127.0.0.1:${SUPABASE_DB_PORT:-55432}` in development only. The production overlay has no published database port. Docker Desktop needs a non-internal network for each published port to become reachable, so the gateway has its own `gateway-host` network and the development database has `db-host`; their Compose port bindings stay loopback-only. `api-gw` serves Auth, Storage, and Studio; `/pg` and `/pg/` return 404, and `/rest/`, `/graphql/`, `/realtime/`, `/functions/`, and MCP routes are blocked. It rejects `apikey` query parameters; provider keys are accepted in headers only. Gateway access logs omit paths, query strings, referrers, and headers so email token hashes and API keys do not enter them. Studio uses Envoy Basic Auth and is loopback-only. PostgreSQL and postgres-meta share the internal `operator` network; Studio joins `operator` and `studio-ingress`, while the gateway joins `provider` and `studio-ingress` plus its loopback-publication network. The API has no direct network path to postgres-meta or Studio. The provider communication networks remain internal to Compose; Auth also joins a network for SMTP and for development access to the host-run template endpoint.

Auth explicitly uses refresh-token algorithm version `2`, rotation enabled, a 10-second reuse interval, and unrestricted reuse disabled. The counter-based algorithm in the pinned Auth release invalidates the provider session on older-ancestor replay outside that interval; the immediately preceding token remains a provider recovery exception. These settings apply to fresh installations. Do not assume changing the algorithm setting converts existing legacy refresh tokens. See the [pinned Auth implementation](https://github.com/supabase/auth/blob/v2.196.0/internal/tokens/service.go) for the provider contract.

## Per-installation inputs

Use an owner-only, ignored environment file generated for **each** installation. Never use upstream `.env.example` secrets, place this file in version control, or print `docker compose config` without `--quiet`: Compose interpolation includes the raw provider credentials. Supply a distinct `--project-name` on every Compose command and an `OPENSLATE_INSTANCE_ID` for the database cluster marker. Keep the same project name and file set on restart so Compose reuses its own named volumes.

| Input | Meaning |
| --- | --- |
| `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY` | Provider bootstrap password and legacy compatibility keys required by the pinned images. |
| `JWT_KEYS`, `JWT_JWKS`, `ANON_KEY_ASYMMETRIC`, `SERVICE_ROLE_KEY_ASYMMETRIC` | Private Auth signing key set, server-only verification key set, and asymmetric gateway compatibility keys. The verification set includes a legacy symmetric key and must never be published; Auth's filtered JWKS endpoint supplies public keys. |
| `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | Opaque gateway keys used by backend and provider services. The secret key never enters browser builds. |
| `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `PG_META_CRYPTO_KEY` | Studio operator authentication and metadata connection encryption. |
| `OPENSLATE_INSTANCE_ID` | Unique installation marker used by database target admission. |
| `API_EXTERNAL_URL`, `SITE_URL`, `SUPABASE_PUBLIC_URL` | Respectively the Auth JWT issuer/email API URL, OpenSlate browser origin, and operator gateway URL. `API_EXTERNAL_URL` must exactly match backend `SUPABASE_AUTH_ISSUER`. |
| `AUTH_TEMPLATE_BASE_URL` | Internal URL of the OpenSlate template handler at `/api/auth/email-templates`; Auth fetches `invite.html` and `recovery.html` from it. For host-run development use `http://host.docker.internal:<backend-port>/api/auth/email-templates`; for a unified API container use its internal address. |
| `SMTP_ADMIN_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SENDER_NAME` | Provider invitation and recovery mailer. Production requires a real SMTP service. Development overlay uses `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, and empty credentials. |
| `SUPABASE_DB_PORT`, `SUPABASE_API_PORT`, `SUPABASE_MAIL_PORT` | Optional loopback host ports, defaulting to `55432`, `58000`, and `58025`. Each concurrently running instance needs different ports. |

`JWT_EXPIRY` defaults to 900 seconds. `SUPABASE_URL` in the host-run backend normally points to `http://127.0.0.1:${SUPABASE_API_PORT}`; a containerized backend uses `http://api-gw:8000`. Do not substitute the public Auth issuer for the internal backend URL. The application runtime and migration database roles are provisioned separately and use direct PostgreSQL connections, never the service key for ordinary domain queries. The database and Storage bytes live in the named volumes `supabase-db-data` and `supabase-storage-data` (prefixed by the supplied Compose project name). Studio snippets and a PostgreSQL configuration key also have named volumes.

## Lifecycle

From the repository root, after generating a permissioned installation environment and choosing an instance project name:

```sh
docker compose --project-name <instance> --env-file <private-env-path> -f infra/supabase/compose.yaml -f infra/supabase/compose.dev.yaml config --quiet
docker compose --project-name <instance> --env-file <private-env-path> -f infra/supabase/compose.yaml -f infra/supabase/compose.dev.yaml up -d
```

The commands above start development providers only. For production, prepare the inputs below and start only provider services first:

```sh
docker compose --project-name <instance> --env-file <private-env-path> -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml up -d db auth rest storage imgproxy meta studio api-gw
```

Wait for provider health and build the release-tagged server image. Provision through one short-lived container on this installation's private provider network; the production database does not need a published host port. Prepare a separate owner-only provisioning env file in Docker's literal `KEY=value` format, without shell quotes or Compose interpolation. It contains `ENVIRONMENT=production`, `OPENSLATE_INSTANCE_ID`, `POSTGRES_HOST=db`, `POSTGRES_PORT=5432`, `POSTGRES_DATABASE=postgres`, bootstrap/owner/runtime database URLs at `db:5432/postgres`, `SUPABASE_URL=http://api-gw:8000`, the matching `SUPABASE_AUTH_ISSUER`, and `SUPABASE_SECRET_KEY`.

```sh
docker run --rm --pull=never --network <instance>_provider \
  --env-file <private-provisioning-env-path> \
  --user 10001:10001 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
  --cap-drop ALL --security-opt no-new-privileges --no-healthcheck \
  --entrypoint /bin/sh <release-server-image> -ec '
    python operations/provision_database_role.py --confirm
    python -m alembic upgrade head
    python -m alembic check
    python operations/provision_storage.py --confirm
  '
```

Keep this sequence in one fail-fast job on one network: role provisioning and Alembic verify the connected database's instance marker before the Storage step. Storage provisioning alone checks production endpoint shape, so it does not replace those live database checks. The image contains the operator commands and migrations; no source, secret, or Docker-socket mount is needed. Never pass the provisioning env file to the long-running API. These commands define the operator procedure; production acceptance must still verify it against the selected release image.

Prepare the application environment, log directories, TLS, and Caddyfile. Only after provisioning succeeds, start the application services:

```sh
docker compose --project-name <instance> --env-file <private-env-path> -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml up -d api caddy
```

Do not use an unrestricted production `up` for a fresh installation: container health alone does not prove the application schema exists. Do not use `down -v`: the provider database, Auth users, Storage metadata, and object bytes are installation data. Start the OpenSlate API/template handler before inviting a user, because GoTrue fetches HTML templates over HTTP when it sends mail. Invitation and recovery links open `/auth/setup` and `/auth/recovery` with a token hash in the URL fragment; browser GETs must not exchange that token. The user confirms the action before FastAPI calls Auth verification.

The operator-only `DATABASE_BOOTSTRAP_URL` must use the pinned provider's `supabase_admin` login with `POSTGRES_PASSWORD`. The ordinary `postgres` login cannot grant schema access to Auth. Provisioning verifies the backend's effective Auth schema and column permissions before succeeding. Its SELECT-only `openslate_session_liveness` policy makes the two granted `auth.sessions` columns visible to `openslate_app` under provider RLS; it refuses a conflicting policy rather than overwriting it. Keep this superuser connection out of API, frontend, and test-runtime environments; they use `openslate_runtime`.

## Operator updates

Manage Updates displays the running FastAPI version and the host runner's timestamped observation of the fixed stable GitHub release source. Check for updates refreshes the recorded status; it does not download or apply releases. The host checks at most once every six hours, including after failure. Missing/unavailable/malformed metadata does not prove the installation is current; failures retain the last successful observation, and old observations become stale. There is no configurable release URL/token or automatic upgrade mechanism.

Apply updates through the installation operator procedure. Read the selected release's compatibility/migration instructions, verify its versioned server and Caddy images, and make a completed offline physical backup with retained configuration, marker and recovery material **before** upgrading. Keep ingress closed while stopping the application, preparing the matching checkout/environment and running the release's explicit schema admission/migration procedure through the owned provider network. Application containers do not migrate at startup.

Restart the selected services in the documented order, verify installation/schema admission, authentication and `/api/ready`, then admit Caddy only after required readiness succeeds. Check the running version and public endpoint before ending the outage. Release observation does not prove deployment. Recovery uses the separate [offline backup and restore procedure](RESTORE.md); upgrades do not promise automatic rollback.

The [bounded backup runner](RESTORE.md#run-the-installation-backup-policy) executes queued production requests and saved cadence/retention through a constrained release-image bridge. It installs no scheduler, mounts no Docker socket into application/operator containers and emits safe JSON. Its private journal and explicit recovery procedure handle interrupted backup/restart and uncertain acknowledgements.

## Production application overlay

`compose.production.yaml` adds one unified FastAPI/static-frontend image as `api` and the repository's Caddy image. Build both images from the repository root context and give them release-specific `OPENSLATE_SERVER_IMAGE` and `OPENSLATE_CADDY_IMAGE` tags. Windows Docker Desktop must run Linux containers; this artifact does not certify native Windows containers.

Supply these private paths and configuration values before rendering or starting the overlay:

| Input | Production contract |
| --- | --- |
| `OPENSLATE_APP_ENV_FILE` | Owner-only application process environment for the API. Keep it separate from the provider installation file: it needs the constrained `openslate_runtime` `DATABASE_URL` at `db:5432/postgres`, application secrets, HTTPS `PUBLIC_ORIGIN`, instance ID, and current backend `Settings` fields. Do not pass provider bootstrap password, `JWT_KEYS`, or `JWT_JWKS` to application containers. |
| `OPENSLATE_LOG_ROOT` | Existing private host directory writable by UID 10001. The API writes to a subdirectory under it; no container creates the host path. |
| `OPENSLATE_APP_PRIVATE_SUBNET` | Private CIDR for the existing Caddy/API-only `app-private` network, default `172.31.248.0/28`. The overlay shares this exact value with the API's trusted proxy setting. Override it in the provider installation environment if it collides with a host or Docker network; startup does not silently choose another subnet. |
| `CADDY_CONFIG_PATH` | Existing generated Caddyfile. Render with `--upstream-host api --backend-port 8000 --health-port 3449` and the same `CADDY_HTTPS_PORT` used by Compose. |
| `CADDY_TLS_DIR` | Optional existing read-only directory mounted at `/run/caddy-tls` for custom certificate and key files. With internal TLS the default mount points to the repository's non-secret Caddy reference directory; Caddy's CA material persists in its named data volume. |
| `CADDY_PUBLIC_BIND_HOST`, `CADDY_HTTPS_PORT` | The only public listener, default `0.0.0.0:443`. Choose the intended LAN interface and match its host/port and TLS mode to `PUBLIC_ORIGIN` and the rendered Caddyfile. |

For internal TLS, render the operator Caddyfile with `python3 infra/caddy/generate_config.py --public-host <host> --output <private-path> --upstream-host api --backend-port 8000 --health-port 3449 --https-port <port> --tls-mode internal`. For custom TLS, use that generator's `--tls-mode custom --cert-file /run/caddy-tls/<cert> --key-file /run/caddy-tls/<key>` and make the mounted files readable to Caddy UID 1000. The Caddyfile routes UI, `/api/*`, and SSE to `api:8000`. A container-local unprivileged-port setting lets non-root Caddy bind port 443 without adding a Linux capability. No application port is published; production PostgreSQL has no host port, while Studio's provider gateway stays loopback-only.

The provider installation file must set `AUTH_TEMPLATE_BASE_URL=http://api:8000/api/auth/email-templates`, and its Auth SMTP fields must point to a real mail server. The application environment uses `SUPABASE_URL=http://api-gw:8000` and `SUPABASE_AUTH_ISSUER=API_EXTERNAL_URL`; the overlay enforces these internal endpoint values. `SECURITY_EVENT_SERVER_KEY` remains an intentional backend secret. The backend no longer requires `FILES_STORAGE_ROOT` or local SMTP/outbox settings. Supabase Auth owns invitation and recovery delivery; keep its SMTP credentials in the provider installation file. `PUBLICATION_SIGNING_KEY` is a separate backend-only secret for short-lived Sandbox publication capabilities. Its issuer derives from `PUBLIC_ORIGIN`; it never signs user authentication tokens. The key generator emits it alongside the installation secrets. Legacy `AUTH_JWT_*` and `AUTH_ACCESS_TOKEN_MINUTES` are no longer application settings.

Uvicorn trusts forwarded client addresses only from the configured `app-private` CIDR in production. Caddy overwrites `X-Forwarded-For` with its actual socket client; only Caddy and API may join that trusted network. An API process without the subnet setting trusts no proxy peers, and `FORWARDED_ALLOW_IPS` cannot override the explicit process arguments. Do not attach another service to this network without reviewing that trust boundary.

For loopback development, the existing Next launcher overwrites forwarding headers from the incoming socket before HTTP and HMR handling, and Uvicorn trusts exactly `127.0.0.1` and `::1`. This protects against browser-supplied forwarding headers. A hostile process on the same workstation can connect directly from a trusted loopback address; this boundary cannot distinguish it from Next. Development therefore assumes the local host and its processes are trusted.

Bring up provider services first, then explicitly provision application roles/schema and create the private Storage bucket. Start the API before any invitation mail, then Caddy. Container restart policies and persistent volumes alone are not a complete reboot or backup procedure. Linux and Windows Docker Desktop startup, TLS trust, backup/restore, and post-reboot service recovery still require live operator acceptance.

The selected upstream services need provider secrets as environment variables; this is a scoped compatibility exception to the repository's preferred secret-file pattern. The generated environment file must be owner-only and ignored, and service inspect/config output should be treated as sensitive. Database initialization uses the official image's root entrypoint; it drops privilege to PostgreSQL for the server and writes into its named volumes. A one-shot `provider-volume-init` container runs as root with only `CHOWN` capability to make the two exact Storage and Studio volume roots writable to UID 1000. It has no published port or host mount. Long-running non-database services use a non-root UID, dropped capabilities, no-new-privileges, and a read-only root filesystem with explicit writable mounts. Runtime checks must verify that the pinned images support those restrictions before customer deployment. Mailpit's disposable development inbox lives in memory and clears on container restart.

The email templates are served from [templates/](templates/) by the OpenSlate API's public, read-only handler. Supabase Auth [fetches self-hosted templates by URL](https://supabase.com/docs/guides/self-hosting/custom-email-templates); mounting them inside Auth does not configure the mailer. The private Storage bucket is created by the application bootstrap step. File-type validation and download authorization remain OpenSlate responsibilities. Backups must capture the PostgreSQL data, Storage bytes, pinned version metadata, and installation secrets as one recovery set; a database dump alone cannot restore files.
