# Infrastructure

> **Scope:** Current developer topology and the boundary to future packaged deployment.

Local development uses one disposable vanilla PostgreSQL container with host-run FastAPI and Next.js. FastAPI reads the runtime database URL, server-only identity configuration, local storage root, scanner configuration, and resource limits from the canonical root environment. Alembic uses the owner migration URL.

The optional Compose `db-ui` profile runs pgweb for developer inspection. It is
bound to loopback, isolated from application containers, and connected through
the dedicated `openslate_inspector` login. PostgreSQL grants that login only
database connection, schema usage, and table `SELECT`; owner default privileges
extend `SELECT` to tables created by later migrations. pgweb also enables its
own read-only and locked-session modes. Its passfile is generated under the
ignored `.agent-runtime/` directory with owner-only host permissions and mounted
as a Compose secret rather than placed in the pgweb environment.

The Compose `gateway` profile builds an unprivileged Caddy image from the pinned
upstream image and listens at the canonical public origin. It routes `/api` and
`/api/events` to host-run FastAPI and interface paths to host-run Next.js through
Docker's host gateway. SSE has no compression and uses the streaming-safe
configuration. The container binds HTTPS only to the configured host address,
runs with no Linux capabilities and a read-only root filesystem, and retains its
local certificate authority in the `caddy-data` volume. Automatic HTTP redirect
listeners are disabled, so the container does not require privileged port 80.
Direct FastAPI and PostgreSQL listeners are not browser-facing.

Private file storage requires a server-only absolute root. POSIX storage uses directory-handle/no-follow operations; the Windows backend uses handle-based checks. Quarantine and ready object directories are created and accessed with private permissions. ClamAV definitions and worker configuration remain separate operational prerequisites.

The repository includes a development-only native Manager shell and a guarded
encrypted-backup foundation. It does not yet provide a signed native installer,
a bundled database service, OS service registration, LAN certificate
automation, native Windows backup controls, or a full restored-installation
test. Those requirements remain release acceptance gates in
[deployment architecture](12-deployment-architecture.md), not a supported
customer installation command sequence.

pgweb is not part of the customer runtime, Caddy routes, native Manager, or
Windows/macOS packages. It can display all rows in the development database and
therefore remains a loopback-only, opt-in developer tool.
