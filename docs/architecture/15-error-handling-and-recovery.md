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

Invitation and recovery email are sent through Supabase Auth using the configured SMTP
service. OpenSlate has no local SMTP outbox; provider or SMTP outages can delay those
actions. Application session revocation remains effective even when a provider sign-out
call is unavailable.

## Events

[`hub.py`](../../backend/app/systems/platform/events/hub.py) uses PostgreSQL
`LISTEN`/`NOTIFY` to carry opaque invalidations to authenticated SSE clients. A
notification failure does not roll back a committed mutation. Clients refetch through
authorized FastAPI endpoints; stalled streams close and reconnect under the normal
access checks. SSE is not an audit log or a source of row data. Supabase Realtime is not
enabled.

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
