# Infrastructure

> **Scope:** Current developer topology and the boundary to future packaged deployment.

Local development uses one disposable vanilla PostgreSQL container with host-run FastAPI and `next dev`. FastAPI reads the runtime database URL, server-only identity configuration, local storage root, scanner configuration, static-asset root, and resource limits from the canonical root environment. Alembic uses the owner migration URL. Node.js is only a developer/build dependency; the production application server is FastAPI.

The optional Compose `db-ui` profile runs pgweb for developer inspection. It is
bound to loopback, isolated from application containers, and connected through
the dedicated `openslate_inspector` login. PostgreSQL grants that login only
database connection, schema usage, and table `SELECT`; owner default privileges
extend `SELECT` to tables created by later migrations. pgweb also enables its
own read-only and locked-session modes. Its passfile is generated under the
ignored `.agent-runtime/` directory with owner-only host permissions and mounted
as a Compose secret rather than placed in the pgweb environment.

Daily development does not start Caddy, request a certificate, or use a gateway
browser URL. The installed `gateway` profile remains disabled while the browser
opens host-run `next dev` directly; its development-only `/api` proxy reaches
host-run FastAPI on loopback. PostgreSQL and optional pgweb are the only daily
Compose services.

Caddy is retained as an installed, configured opt-in gateway profile for a
manually prepared production preview, production installation, and explicit
production-level full-stack acceptance. Operators start it with
`./scripts/dev.py caddy` and stop it with `./scripts/dev.py stop caddy`. There
it has one FastAPI upstream; FastAPI serves the static frontend from
`WEB_ASSETS_ROOT` as well as API and SSE responses. Its generated listener, TLS
configuration, SSE handling, and container hardening belong to that
production-level path. Direct FastAPI and PostgreSQL listeners are not
browser-facing in that topology.

Private file storage requires a server-only absolute root. POSIX storage uses directory-handle/no-follow operations; the Windows backend uses handle-based checks. Quarantine and ready object directories are created and accessed with private permissions.

### Scanner development boundary

The checked-in ClamAV operating path is Linux amd64 only. The disposable
full-stack runner builds `infra/docker/clamav.Dockerfile`, uses
`infra/clamav/freshclam.conf` for one-shot official definition retrieval,
records the immutable serving manifest, then starts the isolated engine and
`python -m app.systems.platform.files.worker` in separate containers. It is the
reproducible developer procedure for real scanner coverage. The ordinary Compose
profiles intentionally do not expose, provision, or refresh ClamAV.

A developer can run the worker directly only after an independently operated
scanner provides the configured verified manifest and endpoint. The worker uses
the root `.env`, takes a PostgreSQL leadership lock, and exits if the scanner or
leadership cannot be established. There is no native Windows/macOS scanner
startup contract in this repository yet.

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
