# Backend Architecture

> **Scope:** FastAPI application boundaries and request execution.

`app/main.py` assembles API routers, configuration, database lifecycle, audit
listeners, the event hub, and process-local record trigger, report-scheduling, and
provider-signout workers. Supabase Auth delivers invitation and recovery mail.
The stack is FastAPI
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
OpenComms additionally uses private Supabase Realtime topics for opaque message,
membership, presence and typing notifications; it does not replace the other
systems' SSE transport or move authorized content reads out of FastAPI.

File services use the server-only [Supabase Storage adapter](../../backend/app/systems/platform/files/supabase_storage.py)
and the private `openslate-ready` bucket. They validate the file type in a
bounded [parser subprocess](../../backend/app/systems/platform/files/validation_worker.py),
record digest and size, and mark the file ready when the upload request
finishes. Downloads are served as attachments with `nosniff`. Every public file operation is
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
Database, Auth, Storage, and SMTP configuration states without provider bodies
or credentials. Mail delivery and deployment acceptance
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
| Boards | Scoped Boards and project Board groups, posts and their revisions, events with author-set reminders, tiles, attachments, record links and configuration portability | `app/systems/boards/` |
| Comms | Conversations, messages/threads, scoped people/search/files, settings/capabilities, moderation, durable jobs and optional link metadata | `app/systems/comms/` |
| Manage | Workspace profile, transactional audit and security-event inspection | `app/systems/manage/` |
| Platform | Private Storage files, authenticated invalidations, and in-app scheduled-work references | `app/systems/platform/` |

Report and Dashboard configurations do not grant access
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
paging. It then batches only the returned page's post and reminder
reference columns, with at most one lookup for each kind present. These maps
last only for that response and contain no content bodies; they do not cache
authorization or change the separately locked, audited mark-read operation.
The implementation is `platform/scheduling/notification_router.py`. Comms notifications
store only recipient/message/conversation references, in the message send transaction.
`comms/notifications.py` selects current eligible members using the resolved notification
policy; quiet hours do not remove inbox rows. List, count and mark-read recheck the stored
conversation against the current message parent and current conversation access. Page
hydration repeats that check without copying message content. IDs-only notification events
use the existing Comms after-response publisher on each recipient's private user topic.

## OpenComms backend contract

**Status:** backend contracts are implemented. Complete integrated frontend,
provider-pack, capacity and target-platform acceptance remain separate. This
source-backed description is not a claim that those acceptance gates have run.

[`comms/router.py`](../../backend/app/systems/comms/router.py) assembles the
`/api/comms` route families. Bootstrap and conversation/message reads, sends,
replies, edits, reactions, search, files, settings, templates,
moderation and jobs all use the current application session and organization.
`X-Org` selects the request organization, otherwise the session's active
organization applies. RLS backs explicit organization predicates; neither a
browser's selected tab nor possession of a Realtime token is permission to read
content. Message and reply history use exclusive sequence keysets; ordinary
catalogs retain the standard list contract. See the registered response schemas
and [API architecture](07-api-architecture.md), rather than deriving endpoints
from a UI label.

[`comms/access.py`](../../backend/app/systems/comms/access.py) derives readable,
postable and manageable conversations from the current organization membership,
the conversation scope and the central department-access policy. Every member
posts in an organization channel. In a department channel, the department level
gives read, post (department `write`) or manage; module rows give no channel
access. Direct and group messages use their member rows. On a channel, member
rows are only a manager roster: the creator's row and `manager` rows. Guests are
capped at read. An administrator manages every channel but has no blanket read of
a direct or group message without membership; report-scoped moderation does not
grant ordinary conversation readability. Capabilities and settings add operation-specific restrictions, not
a replacement authorization system. Private person, attachment, record-link,
search and notification projections recheck their current source access.

Report-bound `POST /api/comms/reports/{report_id}/message-removal` and
`message-restoration` take **no request body** and return only
`CommsReportResponse`, not a message projection. That response contains report
identity/linkage, reason and status, not private message text, and the action
grants no ordinary conversation read access. See
[`moderation/router.py:133–144`](../../backend/app/systems/comms/moderation/router.py#L133-L144)
and the [`report response schema`](../../backend/app/systems/comms/moderation/schemas.py#L27-L36).

The send transaction in [`messages/service.py`](../../backend/app/systems/comms/messages/service.py)
serializes the conversation counter, validates references and current authority,
then commits the message, required related rows and audit changes together.
The author/client-key identity makes retry idempotent; reusing it for a different
command is a conflict. Edits/deletes advance a source generation. Mutation code
continues to use individual `AuditSession` ORM changes, never a bulk-delete
shortcut. Message bodies, fingerprints and cached preview text are audit-redacted.

[`realtime/publication.py`](../../backend/app/systems/comms/realtime/publication.py)
validates private envelopes against the bound organization/actor, buffers them
through transaction/savepoint completion and discards rolled-back work.
[`publisher.py`](../../backend/app/systems/comms/realtime/publisher.py) submits
after the response, outside SQL locks, through a bounded server-only HTTP client.
Delivery is best effort, not an atomic database-plus-network commit: a publish
failure cannot undo an accepted message. Clients must recover using current
authorized sequence/history reads, not trust an event as a content snapshot.

The private topic families are `org:<org>:conversation:<id>`,
`org:<org>:user:<id>` and `org:<org>:presence`. FastAPI's current-access projection
in [`realtime/grants.py`](../../backend/app/systems/comms/realtime/grants.py)
supplies joins; browsers do not publish authoritative messages or presence.
[`POST /api/realtime/token`](../../backend/app/systems/platform/realtime/router.py)
rechecks account/session/membership and issues a five-minute purpose-specific
token. After removal, content reads are refused immediately; already-joined
ID-only delivery can continue until token expiry. This bound is not immediate
socket revocation. Presence snapshots remain current-authorized HTTP projections.

### Protected configuration and durable work

- Templates validate bounded JSON at write time. Multi-channel apply binds one
  aggregate preview and current versions, skips locked keys, and commits atomically.
  Configuration history reconstructs real organization audit changes; incomplete
  reconstruction is unavailable, not invented history. Restore requires current
  exact-administrator/source authority, preview/version/password confirmation,
  and the same validated settings writers. See `comms/templates/` and
  `comms/settings/{history,history_replay,service}.py`.
- [`jobs/worker.py`](../../backend/app/systems/comms/jobs/worker.py) adds scheduled
  sends, exports, retention and preview work to the existing organization-bound
  scheduling worker. Durable claims use leases and source/actor/version fences;
  a stale claim cannot overwrite a newer source. Scheduled sends re-enter the
  ordinary send path. Private Storage artifacts and cleanup state are not
  bypassed on failure.
- Exports produce real CSV or XLSX with an **inclusive 8 MiB encoded-artifact
  bound**, never a truncated result; see [`jobs/encoding.py`](../../backend/app/systems/comms/jobs/encoding.py).
  They use the export-only **exact-administrator purpose (D31)**, separate from
  ordinary conversation readability (D43), and grant no ordinary read access.
  Private-source export creation additionally requires fresh password confirmation
  and a recorded reason. Captured source/authority bindings and current
  administrator/source eligibility are rechecked for generation and download;
  see [`exports.py`](../../backend/app/systems/comms/jobs/exports.py) and
  [`export_service.py`](../../backend/app/systems/comms/jobs/export_service.py).
- Retention uses audited, bounded individual mutations and durable cleanup
  progress. Expired message content and revisions are irreversibly erased;
  attachment access is fenced immediately and Storage-byte erasure completes
  through durable cleanup, not assumed success. Minimal identity/linkage anchors
  remain while references, including younger replies or quotes, need them;
  later bounded garbage collection removes anchors when message/export references
  permit. Expired content cannot be restored. See
  [`retention_worker.py`](../../backend/app/systems/comms/jobs/retention_worker.py),
  [`retention_files.py`](../../backend/app/systems/comms/jobs/retention_files.py) and
  [`moderation/service.py`](../../backend/app/systems/comms/moderation/service.py#L129-L131).
  Purge retains archived-state, exact-administrator, password,
  preview/digest and current-version protections through its existing lifecycle
  path. Neither cleanup failure nor performance pressure authorizes raw SQL
  deletion, a provider-volume reset or weaker confirmation.
- Link previews default off. The existing message projection carries optional
  `url/title/description/site_name`; no preview-fetch endpoint is exposed.
  [`previews/`](../../backend/app/systems/comms/previews/) accepts public HTTP(S)
  targets only, validates every DNS answer, pins the connection while retaining
  original Host/TLS hostname verification, refuses redirects, and bounds total
  fetching/parsing to five seconds and content to 512 KiB. It stores plain
  metadata only. Unavailable egress yields no preview, not a failed message.
  Current message generation, URL, settings, actor/source access and lease are
  checked before applying the result; reads never trigger network work.

Operational limits are not product entitlements: messages have a 4,000-character
body bound and at most ten attachments; the server file ceiling remains 10 MiB
subject to the resolved file policy; sends are capped at twenty committed sends
per actor/organization per ten seconds. There are at most one hundred pending
schedules per author/organization and six Realtime token issuances per minute
per actor/organization. Templates have a 64 KiB raw/canonical JSON bound.
Refusals and `Retry-After` must be respected; do not increase limits to conceal
failed acceptance measurements. Authoritative definitions live in
`messages/mutations.py`, `rate_limit.py`, `jobs/schedules.py`,
`templates/schemas.py` and `platform/realtime/router.py`.

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
outbox.

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
