# Lifecycle and State Management

> **Scope:** Domain close/reopen/purge, irreversible Comms retention, durable work and file state.

Departments, modules, fields, records, and relationships have explicit lifecycle behavior. Ordinary deletion requests a controlled close flow where required. Services compute impact, require confirmations, acquire locks, revalidate scope, make individual ORM changes, and record audit entries. New installations enable purge through `.env.example` (`LIFECYCLE_PURGE_ENABLED=true`). The setting remains required; upgrading an existing installation keeps its configured value. An installation with purge turned off returns "Permanent delete is turned off for this installation."

## Relationship lifecycle

A relationship is a field owned by its source module; it may target a module in the same or another active department. [`plan_lifecycle`](../../backend/app/systems/sandbox/lifecycle/planning.py) and the [executor](../../backend/app/systems/sandbox/lifecycle/execution.py) include its edge rows in the locked impact scope. Closing or reopening the relationship field or an endpoint's module/department hierarchy preserves link rows; current parent/field state controls whether they can be read or changed. Records support purge, not close/reopen. Reopening structure does not invent or recreate links.

Purging a relationship field removes its active and closed edges but preserves both endpoint records. Record/module/department purge removes the incident edges of the rows being purged. A surviving relationship field targeting a purged module blocks that module or department purge (`PURGE_EXTERNAL_SCHEMA_DEPENDENCY`), including a closed field and a source in another department. The planner reports the external dependency, and execution revalidates it rather than silently deleting another module's schema. See [domain authorization](03-domain-architecture.md) and [`test_relationship_field_routes_close_reopen_and_purge_links_keep_records`](../../backend/tests/lifecycle_integration/test_relationship_design_lifecycle.py).

Department library metadata belongs to the department purge scope; its private bytes must pass the existing confirmed file-purge flow first. Library archive/reopen uses the file lifecycle routes and does not move a file between departments.

Password challenges for destructive lifecycle work ask Supabase Auth to verify the current email/password through [`ProviderPasswordGrantClient`](../../backend/app/systems/sandbox/lifecycle/password.py). The verified provider subject must resolve to the same eligible OpenSlate actor that opened the challenge; its temporary provider session is signed out rather than admitted as an application session. [`verify_challenge`](../../backend/app/systems/sandbox/lifecycle/challenge_verification.py) locks and validates the challenge before consuming it, rejects expired or already-used challenges, and does not treat a browser cookie as proof of the requested password action.

Application file metadata remains in the OpenSlate PostgreSQL schema while bytes live in the private Supabase Storage `openslate-ready` bucket. The upload request validates the file type while the file is still `awaiting_upload`; an invalid file is refused with 422 and the row does not change. A valid file moves to `uploading`, its bytes are written through the [Storage adapter](../../backend/app/systems/platform/files/supabase_storage.py), and the same request sets `ready`. A write that Storage rejects sets `rejected`. Only `ready` permits authorized download. Reconciliation moves an uncertain upload to `ready` only when the exact bytes exist in the bucket. Deletion passes through `deleting` to `purged`. A reservation that is never uploaded expires 24 hours after it is created; the next reservation after that point purges it.

Comms conversation purge (`comms/moderation/lifecycle.py` and `purge.py`) requires an
archived, currently readable conversation and exact organization-administrator authority.
Its password challenge binds the actor, organization, target and count/max-sequence impact
digest. New deletion claims and the final source deletion retain administrator/source locks;
completion of an already admitted Storage claim keeps the existing token-fenced cleanup rule. Message
dependencies are removed through bounded individual audited ORM changes, with message
relationships eagerly loaded to avoid per-message deletion reads. Attached bytes use the
existing committed immutable-key deletion claims first; an uncertain provider deletion
leaves its file state and conversation metadata for reconciliation and a fresh confirmation.
This is not an atomic transaction across PostgreSQL and Storage. Message bodies and report
reasons stay redacted in audit snapshots, and final Comms invalidations carry no content.

Comms report-bound removal/restoration uses an open retained report and a compound
report/source-generation validator. Current moderators need both `moderate` and
`deleteOthersMessages`; exact organization admins may act on a reported private source
without gaining ordinary private reads. Those commands accept no request body and return only report metadata,
never restored message content, and do not resolve the report. Revisions still require the
source author or a current conversation manager and are unavailable for a tombstone.

## Comms retention and durable work

Retention is not reversible message removal. The
[`retention worker`](../../backend/app/systems/comms/jobs/retention_worker.py)
irreversibly erases expired bodies and revisions, clears preview/mention/reaction
state, and fences attachment access. Storage-byte removal follows the existing
immutable-key claims and confirmed cleanup in
[`retention_files.py`](../../backend/app/systems/comms/jobs/retention_files.py);
an unavailable provider leaves cleanup pending, not a false deletion success.
Minimal identity/linkage anchors remain while replies, quotes or captured export
references still need them, including younger messages. Later bounded garbage
collection removes unreferenced anchors. An expired-send identity fence prevents
replaying the old client key as a new message. Restoration refuses content marked
`retention_erased_at`; retaining an anchor does not retain recoverable content.

The existing scheduling worker polls scheduled sends, exports, retention and
optional previews per active organization via
[`jobs/worker.py`](../../backend/app/systems/comms/jobs/worker.py). `ScheduledWork`
holds durable source/claim state, not permanent permission. Lease tokens fence
claims; executors recheck source versions or captured authority for their job kind.
Expired claims can be recovered, while stale claims,
lost authority or changed source content cannot overwrite a newer result.
The Comms claim implementations use the shared two-minute lease and five-attempt
bound; a terminal failure is not a promise of five automatic retries. Scheduled
sends re-enter ordinary message admission. Export completion/download rechecks
captured and current source authority under its distinct exact-admin purpose;
it never adds ordinary private readability.

Retention erasure and anchor-collection query batches each select at most 100
message rows; conversation purge uses 1000-row batches with individual audited ORM deletion,
not bulk/raw SQL. These are implementation work bounds, not proof of the purge
latency target. Preserve the current locks, confirmation and Storage cleanup
guards when measuring or repairing performance. The
[API contract](07-api-architecture.md#ordinary-private-reads-versus-privileged-purposes)
defines the report/export purpose boundaries.

## Post-commit notifications

Other application domains retain the
[event publisher](../../backend/app/systems/platform/events/publisher.py) and opaque
PostgreSQL `LISTEN`/`NOTIFY` invalidations for authenticated SSE. Comms additionally
uses its private Realtime envelopes: request-buffered events submit after commit
and response completion; resource-owned durable jobs submit after their own commit
and Session close, without waiting for a triggering HTTP response, including
manual Send Now. Neither path retains a Session or pooled connection through HTTP
publication. Rollback discards unpublished events; best-effort notification failure
does not undo committed business state. Consumers resynchronize through current
authorized reads. See [publication ownership](07-api-architecture.md#realtime-alongside-sse),
[infrastructure](11-infrastructure.md#storage) and [runtime flows](13-runtime-flows.md).
