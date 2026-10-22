# Error Handling and Recovery

> **Scope:** Current error boundaries, failure behavior, and recovery limits.

## Application and provider errors

FastAPI owns the application HTTP boundary in [`main.py`](../../backend/app/main.py).
Database operation failures produce a generic `503 Database unavailable`; unexpected
failures produce a generic `500`. Responses carry a request identifier, while structured
logs record a bounded reason code instead of exception text or request contents.
Expected route errors remain route-specific. Invalid Origin or CSRF input is rejected
without refreshing a session.

The provider boundary in
[`supabase_auth.py`](../../backend/app/core/integrations/supabase_auth.py) verifies
provider identity, while FastAPI resolves the explicitly bound OpenSlate profile, checks
its current eligibility, and evaluates application authorization. A missing, inactive,
or revoked application profile is denied even when the provider credential is valid.
Provider unavailability is an availability error, not evidence of invalid credentials.
Provider metadata does not grant application roles or permissions. See [Authentication
and Authorization](08-authentication-authorization.md) and
[Infrastructure](11-infrastructure.md).

## OpenComms refusals and command recovery

OpenComms keeps route-local status/detail contracts rather than adding a global
error envelope. Within an admitted organization, an absent or unreadable conversation
is hidden with 404; a readable source with a denied post/manage capability returns 403.
Authentication and organization admission retain their shared rules. Clients must
not turn a refusal into an empty success, an administrator fallback or a wider read.
See [`comms/access.py`](../../backend/app/systems/comms/access.py) and the
[HTTP contract](07-api-architecture.md#preconditions-and-refusals).

Where declared by a versioned route, missing `If-Match` returns 428 and a stale
validator returns 412. Protected preview/confirmation operations also bind their
actor, organization, source and proposed state; a stale preview requires a fresh
preview and renewed confirmation, not merely a replaced header. Ordinary message
body edits/deletes and personal preferences do not acquire an `If-Match` requirement
just because other resources use one. State/idempotency/capacity conflicts use 409,
invalid input 422, and rate/slow-mode refusals 429 with `Retry-After`; unavailable
dependencies use 503. Preserve the distinctions among those responses, network
failure, cancellation and a response that fails the client contract.

The browser shows one neutral state for every conversation id it cannot read. The
state does not tell whether the conversation exists, and it offers no request for
access. See the
[unavailable-conversation view](../../frontend/src/components/systems/comms/components/conversation-view.tsx).
Submitting a report on a currently
readable message also returns 204, without exposing a report ID or granting access
to the moderation queue. Report-bound removal/restoration are separate bodyless,
versioned actions returning report metadata only, not a private message projection.
These boundaries live in [`moderation/router.py`](../../backend/app/systems/comms/moderation/router.py).

### Send receipts and read-refusal barriers

The client recovery contract separates unacknowledged sends from accepted messages
and from subsequent read repair. A validated send receipt—201 for creation or 200
for idempotent replay—acknowledges the original author/client-key command. A later
cache refresh failure must not turn that receipt back into an unsent draft or
create a second send. If a response is lost, retain the original key and payload
for reconciliation/retry; a new key would represent a new command. The receipt
does not prove that another browser received or read the message. The
[`message adapter`](../../frontend/src/components/systems/comms/adapters/message-api.ts)
validates response identity/scope, while the
[`client outbox`](../../frontend/src/components/systems/comms/adapters/outbox.ts)
tracks only unacknowledged sends in its admitted account/organization lifetime.

An authentication/access refusal (401/403 or an applicable source 404) on a
bootstrap or conversation read must conceal its protected cache scope.
The [read-refusal latch](../../frontend/src/components/systems/comms/adapters/comms-queries.ts)
keeps a read-order barrier: an older in-flight success cannot restore bytes refused
by a newer read. Only a fresh successful authorized read can clear the visible
refusal; an invalidation or write receipt alone is not read authority. A missing
individual message need not imply that its entire conversation became unreadable.
Reconnect/gap repair must reconcile loaded message/thread windows and bootstrap,
not just append sequences above a remembered head, because edits/deletions can
affect earlier positions. The [cache bridge](../../frontend/src/components/systems/comms/adapters/cache-bridge.ts)
must not advance a fetched cursor merely from observed metadata or expose a
different account/organization's data. These are recovery requirements, not a
claim about a particular rendered run.

## Private files

OpenSlate stores file metadata in PostgreSQL and bytes in the private Supabase Storage
`openslate-ready` bucket. FastAPI authorizes transfers; browsers receive no Storage
credentials or direct object URLs. The upload request validates the file type, writes the
bytes, and commits the file as `ready` with its digest and size.

Storage and database changes do not share a transaction. A timeout, digest mismatch,
rejected write, uncertain upload, or uncertain cleanup therefore fails closed: the
application does not expose an unverified object as ready.
Durable operation and object state remain available for reconciliation. Retrying a
partially completed operation must verify the existing immutable bytes rather than
assume that the prior request did nothing. The Storage adapter and file state machine
are implemented in
[`supabase_storage.py`](../../backend/app/systems/platform/files/supabase_storage.py)
and [`service.py`](../../backend/app/systems/platform/files/service.py).
File access and recovery flows are described in [Runtime Flows](13-runtime-flows.md).

OpenComms conversation purge retains the same boundary. Before a new file-deletion
claim or final conversation deletion, it revalidates current exact-administrator/
source authority and the confirmed impact. A committed immutable-key deletion
intent is then completed and finalized under its operation token; completing that
already-admitted effect does not depend on the original actor keeping their role.
It does not authorize a new purge. Unconfirmed provider deletion or database
finalization returns failure and retains reconciliation state instead of declaring
the parent purged. See [`comms/moderation/purge.py`](../../backend/app/systems/comms/moderation/purge.py)
and [`files/purge.py`](../../backend/app/systems/platform/files/purge.py).

Use the existing file reconcile route (`POST /api/files/{file_id}/reconcile` in
[`files/router.py`](../../backend/app/systems/platform/files/router.py)) for an
unresolved claim, then obtain a fresh parent preview/confirmation when required.
Reconciliation of a Comms attachment still authorizes its current private parent
conversation; operator repair is not permission to bypass
authorization, erase uncertain metadata with raw SQL or reset provider volumes.
Retention erasure is irreversible: a retained identity/linkage anchor is not a
recoverable copy of expired content. See [lifecycle state](09-lifecycle-and-state-management.md).

Invitation and recovery email are sent through Supabase Auth using the configured SMTP
service. OpenSlate has no local SMTP outbox; provider or SMTP outages can delay those
actions. Application session revocation remains effective even when a provider sign-out
call is unavailable.

## Events

[`hub.py`](../../backend/app/systems/platform/events/hub.py) uses PostgreSQL
`LISTEN`/`NOTIFY` to carry opaque invalidations to authenticated SSE clients. A
notification failure does not roll back a committed mutation. Clients refetch through
authorized FastAPI endpoints; stalled streams close and reconnect under the normal
access checks. SSE is not an audit log or a source of row data. Other application
pages retain this path. OpenComms tables publish no SSE invalidations
([`events/models.py`](../../backend/app/systems/platform/events/models.py));
OpenComms uses private Realtime notifications instead.

The OpenComms [publication wrapper](../../backend/app/systems/comms/realtime/publication.py)
discards rollback buffers. Request-buffered events submit after response completion;
resource-owned durable jobs submit after their own commit and SQL-session close,
independently of any triggering HTTP response. The bounded
[HTTP publisher](../../backend/app/systems/comms/realtime/publisher.py) is best effort:
a full queue, provider refusal or network failure is not permission to undo an
accepted command or replay it with a new identity. Consumers recover through
current-authorized reads, respecting admission backoff and `Retry-After` rather
than bypassing limits. No SQL session or pooled connection is retained through
publisher HTTP I/O.

Scheduled sends, exports and previews use durable claim/lease state and recheck
their source/actor/version or captured authority. Caller cancellation does not
revoke an independently committed job. A stale lease cannot overwrite newer work;
expired-claim recovery is bounded, and terminal failure is not automatic unlimited
retry. Inspect the existing job resource before another command rather than infer
success or absence from a request timeout. Retention has separate bounded sweep/
cleanup progress. See the [job/lifecycle boundary](09-lifecycle-and-state-management.md#comms-retention-and-durable-work)
and [schedule executor](../../backend/app/systems/comms/jobs/schedule_worker.py).

## Backup and restore

The version 3 offline Restic workflow captures a stopped installation's physical
provider volumes and required secret/configuration bundle. Restore requires a full
snapshot ID, a new Compose project and instance identity, a fresh target directory, and
exact confirmation. Validation and finalization happen before ingress is opened;
restored OpenSlate sessions are invalidated. Follow the [restore
runbook](../../infra/supabase/RESTORE.md) and [deployment recovery
contract](12-deployment-architecture.md#backup-restore-and-persistent-data).

Those artifacts and command-level checks are a recovery foundation, not proof of
physical recovery. A real isolated physical restore and post-reboot recovery have not
been accepted on Linux; Windows restore and reboot acceptance remain pending until a
Windows host is available. Retention and off-host repository policy remain operator
responsibilities.
