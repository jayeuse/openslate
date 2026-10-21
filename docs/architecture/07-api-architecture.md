# API Architecture

> **Scope:** HTTP contracts, browser boundary, SSE and private Comms Realtime.

FastAPI routes are mounted below `/api`. In production, Caddy forwards the
same-origin browser origin to one FastAPI upstream; FastAPI serves exact static
UI exports alongside `/api` and `/api/events`. Daily development opens `next
dev` directly, whose development-only `/api` proxy reaches loopback FastAPI.
The browser does not receive a database credential or a server-side signing
secret.

Realtime has a separate same-origin WebSocket upgrade path, not another content
API. Production uses Caddy; daily development uses the existing frontend
launcher's exact-origin proxy at its configured development hostname and
`FRONTEND_DEV_PORT`. The `/api` upstream remains the configured loopback
`BACKEND_PORT`. These are configured boundaries, not a claim about a currently
running workstation's ports or acceptance status. See the
[operator ingress contract](../../infra/supabase/README.md#opencomms-ingress-and-private-publication).

Cookie-authenticated browser mutations require an exact allowed `Origin` and `X-CSRF-Token`. Browser login, refresh, logout, setup, and session status are FastAPI routes. CLI clients use bearer tokens from the token endpoints. A request containing ambiguous cookie and bearer credentials is rejected.

Domain routes use capability dependencies. Lists use the standard offset-pagination contract with explicit sorts and UUID tie-breakers. Department, module, and field routes are read-only (`GET` lists and details); the [Sandbox publish](../../backend/app/systems/sandbox/publications/executor.py) is the only write path for them, and close, reopen, and purge use the [lifecycle routes](../../backend/app/systems/sandbox/lifecycle/router.py). Routes commit or roll back their own `AuditSession` transaction before translating expected integrity or concurrency errors. Access group routes are administrator-only except three that a department manager can also use: `GET /api/access/groups` and `GET /api/access/groups/{id}` return only the groups the manager may change (404 for the others), and `PUT /api/access/groups/{id}/members` replaces the member list under `If-Match`. `GET /api/access/member-candidates` lists non-administrator accounts for administrators and for users who manage at least one group. `PATCH /api/access/groups/{id}` changes only the name and description. `GET /api/users/{id}/access` is administrator-only and returns the person's role, `unrestricted` flag, and effective access entries, each with the groups whose rows grant it.

[`/api/workspace`](../../backend/app/systems/manage/workspace/router.py) manages the organization profile; its public `/appearance` read returns only the theme, not private profile or security fields. Personal [`/api/users/{id}/preferences`](../../backend/app/systems/access/users/router.py) reads and writes require the authenticated owner's ID. Access Security policy and People directory, activity/session monitoring, recovery, and MFA administration use administrator boundaries. [Notification routes](../../backend/app/systems/platform/scheduling/notification_router.py) recheck recipient and source access; [file routes](../../backend/app/systems/platform/files/router.py) authorize attachment, library, and logo operations. Administrator [backup routes](../../backend/app/systems/manage/backups/router.py) expose policy, queued runs, export metadata, password-confirmed download admission, and encrypted content; private claim secrets and host paths are not public responses.

Audit-log list reads have a separate boundary: administrators can list all rows, while other users must request one department where they have department-level `manage`; the result is filtered to that department. Audit-log detail and export, plus SecurityEvent reads and exports, remain administrator-only ([`audit/router.py`](../../backend/app/systems/manage/audit/router.py)). The `department_id` is resolved from the audited entity's source ancestry before its parents can be removed ([`department_ancestry.py`](../../backend/app/systems/manage/audit/department_ancestry.py)).

`GET /api/events` is authenticated SSE. It emits `resync` and opaque `invalidate` events only, sends heartbeats, bounds subscriber queues, and rechecks access as the stream runs. Clients must refetch authorized data; event messages are never a data API.

The normal error shape remains route-local `HTTPException` detail. Authentication failures are generic; API responses and logs must not disclose passwords, tokens, raw storage paths, or internal database details.

## OpenComms HTTP boundary

[`comms/router.py`](../../backend/app/systems/comms/router.py) registers the live
`/api/comms` families. Every request uses the current account session and bound
organization (`X-Org`, else the session's active organization), then the current
conversation/capability/source policy. A client DTO, role label, stream event or
cached grants row is not permission to read content. Private responses use the
route's `private, no-store` policy. Remaining explicitly labeled S31 example
tools are browser-local; they do not make the corresponding implemented backend
template/history/admission APIs absent or exempt from authorization.

| Family | Contract and source |
| --- | --- |
| Bootstrap, conversations and messages | Bootstrap is current-authorized data, not a grant. Conversation catalogs use standard lists. Message/reply history uses exclusive `before_seq`/`after_seq` or an `around_seq` target, default 50/max 100 items; sequence identity is per conversation. [`messages/router.py`](../../backend/app/systems/comms/messages/router.py), [`schemas.py`](../../backend/app/systems/comms/messages/schemas.py) |
| Send and reply | The author/client-key identifies the original command. New sends return 201 with `Location`; idempotent replay returns 200; a different command under that key returns 409. The response is the current live message or tombstone, with an opaque ETag. A timeout does not justify a new key. |
| Structure, settings and capabilities | Current read/manage authority and resolved scope apply; clients use each versioned route's ETag/`If-Match` contract. Template apply binds its aggregate preview/current versions and skips locked keys. Audit-backed settings restore uses fresh exact-admin/source authority, password confirmation and the validated writers. [`conversations/router.py`](../../backend/app/systems/comms/conversations/router.py), [`settings/history.py`](../../backend/app/systems/comms/settings/history.py), [`templates/router.py`](../../backend/app/systems/comms/templates/router.py) |
| People, search, attachments and notifications | Current source/person visibility applies independently to every projection. Private Storage keys and a notification ID are not download/read authority. [`direct_candidates.py`](../../backend/app/systems/comms/direct_candidates.py), [`search.py`](../../backend/app/systems/comms/search.py), [`files/router.py`](../../backend/app/systems/comms/files/router.py) |
| Schedules and exports | Schedules have at most 100 pending rows per author/organization, with current admission and versioned edit/cancel/send-now. Real CSV/XLSX exports enforce an inclusive 8 MiB encoded-artifact bound with no truncation. Jobs are durable state, not a guarantee of completed external work. [`jobs/schedules.py`](../../backend/app/systems/comms/jobs/schedules.py), [`jobs/encoding.py`](../../backend/app/systems/comms/jobs/encoding.py) |
| Retention, purge and optional previews | Retention erasure is irreversible; references can retain minimal anchors, not expired content. Purge keeps exact-admin/password/preview/version guards. Preview metadata is optional on the existing message projection; default-off or unavailable egress does not fail a message. No preview-fetch endpoint exists. See the [backend contract](04-backend-architecture.md#protected-configuration-and-durable-work). |

### Ordinary private reads versus privileged purposes

Ordinary conversation readability (D43) remains separate from privileged action
purposes. Administrator status alone is not blanket membership in a private
conversation. Report-bound
`POST /api/comms/reports/{report_id}/message-removal` and
`message-restoration` accept **no request body**, require their current report
authority/version, and return only `CommsReportResponse`, never a private message
projection or an ordinary read grant. See
[`moderation/router.py`](../../backend/app/systems/comms/moderation/router.py) and
[`moderation/schemas.py`](../../backend/app/systems/comms/moderation/schemas.py).

Export is an exact-administrator **export-only purpose (D31)**. Private sources
add fresh password confirmation and a recorded reason at creation. Captured
source/authority bindings and current administrator/source eligibility are checked
again during generation/download, including after external Storage I/O. This
does not add ordinary D43 readability. The wire request keeps password proof
write-only; the job response does not persist or return it. See
[`jobs/exports.py`](../../backend/app/systems/comms/jobs/exports.py) and
[`export_service.py`](../../backend/app/systems/comms/jobs/export_service.py).

### Preconditions and refusals

Versioned structure/settings, report actions and schedule mutations require the
route's exact opaque validator: missing `If-Match` returns 428 and a stale value
returns 412. Do not recompute validators from JavaScript timestamps or guess that
every mutation has the same precondition. In particular, ordinary message
edit/delete handlers currently serialize/recheck their source without an
`If-Match` request parameter, even though message responses carry ETags.
Protected restore/purge/retention additionally bind their own preview or
confirmation contract; an ETag alone is not password or authorization proof.

Comms refusals use route-local detail codes/messages, not a new global envelope:
404 hides absent/unreadable sources, 403 denies a visible operation, 409 denotes
an idempotency/state/capacity conflict, 422 invalid input, 429 rate/slow-mode
admission with `Retry-After`, and 503 an unavailable dependency or operation.
Authentication retains the shared 401 behavior. Neutral private join requests
return 204 without revealing whether an unreadable target exists. Re-read current
authorized state after a conflict; do not bypass a refusal with a wider list,
automatic administrator fallback or a new send identity.

## Realtime alongside SSE

`POST /api/realtime/token` uses the same session, organization, MFA/IP policy and
CSRF boundary. It admits at most six issuances per rolling minute per actor/org,
returns 429 with `Retry-After` when limited, and returns a five-minute
purpose-specific token plus the current conversation-topic projection. The token
is not an Auth/API/Storage content credential; keep it out of URLs and logs.
[`platform/realtime/router.py`](../../backend/app/systems/platform/realtime/router.py)
and [`comms/realtime/grants.py`](../../backend/app/systems/comms/realtime/grants.py)
are the source boundaries.

Browser ingress is only exact-origin `/realtime/v1/websocket` with a valid
upgrade. Caddy or the development launcher injects the gateway header; caller
cookies/authorization are not forwarded as provider credentials. The product
topics are private conversation topics backed by expiring FastAPI grants,
own-user topics and organization presence. Browser Comms subscriptions are
read-only; message/typing/presence writes use their HTTP contracts. Other pages
retain `/api/events` SSE and current-authorized refetches.

The server validates opaque private envelopes and discards rollback buffers.
Request-buffered events publish after commit and response completion. Resource-owned
durable jobs instead submit their committed events after closing their own SQL
session, without waiting for a triggering HTTP response: manual Send Now can
therefore submit before its HTTP handler returns (`jobs/schedules.py:316–328`,
`jobs/schedule_worker.py:139–205`). Neither path retains a session or pooled
connection through HTTP publication. Both use the bounded private listener, not
the public WebSocket route. No message body or attachment content is transported as
a substitute for HTTP authorization. Delivery is best effort: clients recover
from current authorized sequence/history reads. Removed users lose content access
immediately; an already-joined ID-only subscription can remain until its token
expires, at most five minutes. This is not an immediate socket-disconnect promise.

### Acceptance boundary

These contracts describe implemented services, not completed S32 native browser,
full provider-pack/load, release-gate or Linux/Windows acceptance. The 15-second
purge timing target remains a deferred S32 measurement, not a reason to weaken
audited mutation or confirmation guards. Final frontend JS acceptance belongs
after S31's temporary memory/example tools are removed; backend/API evidence does
not satisfy that budget. The operating procedure remains in the
[Supabase guide](../../infra/supabase/README.md), not duplicated here.
