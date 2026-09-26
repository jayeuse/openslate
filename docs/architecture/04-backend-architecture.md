# Backend Architecture

> **Scope:** FastAPI application boundaries and request execution.

`app/main.py` assembles API routers, configuration, database lifecycle, audit
listeners, the event hub, and process-local automation, scheduling, and optional
email workers. The file scanner is a separate operator-started process. The
stack is FastAPI with synchronous SQLAlchemy 2; browsers never access the
application database directly.

`app/core/` holds configuration, database, security, middleware, and audit-aware session infrastructure. `app/common/` holds shared dependencies and list behavior. `app/systems/<area>/<capability>/` owns domain models, schemas, routers, and coordination services.

Identity is a FastAPI module. Passwords use Argon2. Access tokens are short-lived FastAPI-signed JWTs; refresh tokens rotate and are checked against server-side sessions. Browser endpoints issue HttpOnly cookies and require Origin plus CSRF validation. Bearer-token routes remain available for CLI use.

The events module maintains authenticated SSE subscriptions. Commit-time audit listeners publish opaque PostgreSQL notifications. Event streams reauthorize subscribers, have bounded queues and send timeouts, and contain invalidation data only.

File services use the local storage backend, quarantine uploads, verify digest and size, invoke the scanner, and publish only clean bytes. The storage root is server-only and every public file operation is authorized by FastAPI.

## Process and request lifetimes

The supported `python -m app` entrypoint in `app/__main__.py` starts Uvicorn with
the configured bind, port, keep-alive and admission limits. Development relaxes
local transport controls; test and production retain the strict path. Startup
verifies the configured database target and live instance identity before
starting background resources. The image entrypoint does not run migrations or
provision accounts.

Ordinary synchronous handlers execute through FastAPI's thread pool. Each
request receives its own `AuditSession`; the cached engine and bounded pool are
shared, but sessions and mutable request state are not. Routes and coordinating
services own commits and rollbacks. Middleware supplies request IDs, request-body
and transfer admission controls, safe database/error responses, response headers
and duration logging. Readiness uses a separate bounded pool and a single-flight
probe; see [configuration](17-configuration.md) for the resource settings.

Authentication resolves persisted session and user state. Capability-protected
operations then obtain the current locked Access policy snapshot rather than
trusting a browser decision or a cached cross-request permission result. Domain
services add their object, audience and lifecycle checks. See
[authentication and authorization](08-authentication-authorization.md).

## Capability execution

| Area | Implemented responsibility | Main source boundary |
| --- | --- | --- |
| Access | Identity, invitations/recovery, users/roles/groups, workspace policy and service-identity metadata | `app/systems/access/` |
| Sandbox | Operational schema, Records, relationships, lifecycle, design documents, publication, automations and test-run evidence | `app/systems/sandbox/` |
| OpenView | Saved Views, Chart preferences, Dashboards, report definitions, frozen runs and schedules | `app/systems/openview/` |
| Boards | Grants, content, announcements, events/reminders, widgets, attachments, record links and configuration portability | `app/systems/boards/` |
| Manage | Workspace profile, transactional audit and security-event inspection | `app/systems/manage/` |
| Platform | Private files, authenticated invalidations, in-app scheduled-work references and optional email delivery | `app/systems/platform/` |

Comms remains reserved. Report and Dashboard configurations do not grant access
to their source Records. Report capture uses a repeatable-read snapshot, then
rechecks authorization and recipe state before storing the run and its eligible
audience. Stored report rows retain ordinary audit behavior.

Sandbox document validation builds identifier and scenario-link indexes within
each validation call. Those indexes avoid repeated scans of large documents and
are discarded after the call; they are not an authorization or result cache.
Duplicate-ID documents remain repairable inputs, so the validator preserves its
issue ordering and its existing first/last occurrence lookup behavior. The
implementation is `sandbox/designs/validation.py`.

Publication planning batches bound targets and active automation children into
an explicit object owned by that plan call. Name and unmanaged-field checks
also batch database reads while retaining document-order decisions. The full
live-state digest reads structural scalar columns and fetches complete Record
JSON in batches of 500, retaining compact hashes for the final digest. This
limits the intermediate Record payload buffer; total digest work and retained
hashes still grow with the workspace. Scalar scans avoid reusing earlier ORM
attributes held by the plan's target map. The digest keeps normal session
autoflush, its original structural table scan order and transaction isolation.

Every live-state digest still covers the entire workspace, including unbound
and archived rows. Applying a publication acquires the existing operational
locks and recomputes the plan before checking the preview digest. No cross-call
cache or narrower freshness guarantee is introduced. These boundaries live in
`sandbox/publications/{planner,snapshot,live_state,executor}.py`; SQLAlchemy's
[bounded result iteration](https://docs.sqlalchemy.org/en/20/orm/queryguide/api.html#fetching-large-result-sets-with-yield-per)
explains the cursor mechanism.

In-app notification listing applies current eligibility before counting and
paging. It then batches only the returned page's announcement and reminder
reference columns, with at most one lookup for each kind present. These maps
last only for that response and contain no content bodies; they do not cache
authorization or change the separately locked, audited mark-read operation.
The implementation is `platform/scheduling/notification_router.py`.

## Background ownership and failure boundaries

The lifespan owns the PostgreSQL event listener and the automation and
Report/Board scheduling threads. Each worker creates its own sessions, claims
bounded durable work, and applies its existing lease/retry rules. Automatic
automation and scheduling threads are disabled in `ENVIRONMENT=test`; their
bounded `run_once` entrypoints support explicit isolated verification. SMTP
delivery starts only when configured and does not provide report-recipient email
fanout. The separate `app.systems.platform.files.worker` process owns scanner
leadership and file-job recovery.

Audit records share the business transaction. Invalidation publication happens
after commit and is best effort: publication failure cannot roll back the
already-committed mutation. The publisher's direct connection and the listener's
session-affine connection are additional to the application pool. SSE streams
have bounded queues, connection limits, reauthorization and send deadlines.

Shutdown signals and joins background resources before disposing shared database
resources. Filesystem and database operations cannot form one atomic transaction;
file state, digest checks, leases and cleanup routines provide the recovery
boundary. See [error handling and recovery](15-error-handling-and-recovery.md).
