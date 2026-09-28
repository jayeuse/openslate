# Backend Architecture

> **Scope:** FastAPI application boundaries and request execution.

`app/main.py` assembles API routers, configuration, database lifecycle, audit
listeners, the event hub, and process-local record trigger, report-scheduling, and
provider-signout workers. Supabase Auth delivers invitation and recovery mail;
the file scanner is a separate operator-started process. The stack is FastAPI
with synchronous SQLAlchemy 2; browsers never access the application database
directly.

`app/core/` holds configuration, database, Supabase Auth integration and JWT
verification, middleware, and audit-aware session infrastructure. `app/common/`
holds shared dependencies and list behavior. `app/systems/<area>/<capability>/`
owns domain models, schemas, routers, and coordination services.

Alembic evolves only OpenSlate's application schema. [`backend/migrations/env.py`](../../backend/migrations/env.py) limits reflection to application-owned objects through [`application_migration_scope`](../../backend/app/core/database/migration_scope.py); Supabase owns Auth, Storage, and other provider schemas. Fresh installs start from the Supabase application baseline, with the former vanilla PostgreSQL lineage kept outside the active migration graph. See [data architecture](06-data-architecture.md#schema-workflow).

[`SupabaseAuthClient`](../../backend/app/core/integrations/supabase_auth.py)
verifies email/password credentials and provider JWTs.
[`login_with_provider`](../../backend/app/systems/access/identity/provider_login.py)
admits only a provider subject explicitly bound to an eligible OpenSlate
profile; [`resolve_provider_session`](../../backend/app/systems/access/identity/provider_sessions.py)
rechecks provider liveness, local expiry, and revocation. `identity_sessions`
store a digest of the opaque application refresh handle and encrypted provider
access/refresh tokens. Browser access and refresh cookies are HttpOnly, while
state-changing requests require Origin and CSRF validation. CLI bearer-token
routes use the same provider and local-session admission.

The events module maintains authenticated SSE subscriptions. Commit-time audit
listeners publish opaque PostgreSQL notifications on Supabase Database through
[`publisher.py`](../../backend/app/systems/platform/events/publisher.py).
[`hub.py`](../../backend/app/systems/platform/events/hub.py) reauthorizes
subscribers and bounds queues. Event streams contain invalidation data only.
Supabase Realtime is not the current transport.

File services use the server-only [Supabase Storage adapter](../../backend/app/systems/platform/files/supabase_storage.py)
and private quarantine/ready buckets. They verify digest and size, invoke the
separate [scanner worker](../../backend/app/systems/platform/files/worker.py),
and expose only verified clean bytes. Every public file operation is
authorized by FastAPI; no local-filesystem storage mode is supported.

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
and duration logging. `/api/ready` uses a separate read-only database pool and shared
bounded probe work in [`readiness.py`](../../backend/app/core/readiness.py). It reports
Database, Auth, Storage, SMTP configuration, and scanner states without provider bodies
or credentials. Production requires scanner engine health and worker leadership;
the scanner is optional in development/test. Mail delivery and deployment acceptance
need separate verification. See
[configuration](17-configuration.md) for the resource settings.

Authentication resolves persisted session and user state. Capability-protected
operations then obtain the current locked Access policy snapshot rather than
trusting a browser decision or a cached cross-request permission result. Domain
services add their object, audience and lifecycle checks. See
[authentication and authorization](08-authentication-authorization.md).

## Capability execution

| Area | Implemented responsibility | Main source boundary |
| --- | --- | --- |
| Access | Identity, invitations/recovery, users/roles/groups, workspace policy and service-identity metadata | `app/systems/access/` |
| Sandbox | Operational schema, Records, relationships, lifecycle, design documents, publication, record triggers and test-run evidence | `app/systems/sandbox/` |
| OpenView | Department Dashboards, shared saved Views, report definitions, frozen runs and schedules | `app/systems/openview/` |
| Boards | Grants, content, announcements, events/reminders, widgets, attachments, record links and configuration portability | `app/systems/boards/` |
| Manage | Workspace profile, transactional audit and security-event inspection | `app/systems/manage/` |
| Platform | Private Storage files, authenticated invalidations, and in-app scheduled-work references | `app/systems/platform/` |

Comms remains reserved. Report and Dashboard configurations do not grant access
to their source Records. Report capture uses a repeatable-read snapshot, then
rechecks authorization and recipe state before storing the run and the users who
can read its module. A scheduled run acts as the workspace. Stored report rows
retain ordinary audit behavior.

Sandbox document validation builds identifier and scenario-link indexes within
each validation call. Those indexes avoid repeated scans of large documents and
are discarded after the call; they are not an authorization or result cache.
Duplicate-ID documents remain repairable inputs, so the validator preserves its
issue ordering and its existing first/last occurrence lookup behavior. The
implementation is `sandbox/designs/validation.py`.

Publication planning batches bound targets and active record trigger children into
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

The lifespan owns the PostgreSQL event listener, record trigger and Report/Board
scheduling threads, and provider sign-out retries. Each worker creates its own
sessions, claims bounded durable work, and applies its existing lease/retry
rules. Automatic
record trigger and scheduling threads are disabled in `ENVIRONMENT=test`; their
bounded `run_once` entrypoints support explicit isolated verification.

A record trigger acts only on the record that started it, and its only action
is "set field". It runs as the workspace, not as the administrator who
published it: a publisher who is later disabled or loses access does not stop
the trigger. Its changes have no user in `performed_by`; their audit entries
carry `actor_label = "Trigger: <name>"`. Loop protection limits a chain of
trigger events to depth 10 and 100 applied actions.
Invitation and recovery email use Supabase Auth rather than an application SMTP
outbox. The separate `app.systems.platform.files.worker` process owns scanner
leadership and file-job recovery.

Audit records share the business transaction. Invalidation publication happens
after commit and is best effort: publication failure cannot roll back the
already-committed mutation. The publisher's direct connection and the listener's
session-affine connection are additional to the application pool. SSE streams
have bounded queues, connection limits, reauthorization and send deadlines.

Shutdown signals and joins background resources before disposing shared database
resources. Supabase Storage and database operations cannot form one atomic
transaction; file state, digest checks, leases and cleanup routines provide the
recovery boundary. Production deployment and Windows runtime acceptance remain
incomplete. See [error handling and recovery](15-error-handling-and-recovery.md)
and the [Supabase implementation plan](../../infra/supabase/PLAN.md).
