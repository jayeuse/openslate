# Runtime Flows

> **Scope:** Supabase-backed startup, identity, files, OpenComms jobs and private notification paths.

## Development startup

1. The developer keeps a private root `.env` with a unique `OPENSLATE_INSTANCE_ID`, instance root, loopback ports, provider values, and application connection URLs. `scripts/environment.py` validates it before a Compose mutation.
2. `./scripts/dev.py db` starts the pinned Supabase development stack. Project labels, expected image, database volume, provider network, role, and live database target are checked by the instance guard before mutations are admitted.
3. From `backend/`, `uv run python operations/provision_database_role.py` provisions `openslate_owner` and `openslate_runtime` using `DATABASE_BOOTSTRAP_URL`. Alembic then applies application schema with `uv run alembic upgrade head`; `uv run alembic check` verifies model/schema alignment.
4. `uv run python operations/provision_storage.py` creates and verifies the private `openslate-ready` and `openslate-avatars` buckets. It requires the admitted runtime database and server-only Supabase credentials.
5. Start FastAPI with `uv run python -m app --reload`, then the frontend with `npm run dev`. The API must serve the Auth email-template route before an invitation is sent. HTTP `/api` requests use the development proxy to loopback FastAPI; the frontend launcher separately proxies the exact-origin Realtime WebSocket upgrade to the provider gateway.
6. With the API running, `uv run python operations/bootstrap_admin.py` reserves the first administrator profile and sends a Supabase Auth invitation. The recipient sets a password through the OpenSlate invite page.

The checked-in development commands and production sequence are in [`infra/supabase/README.md`](../../infra/supabase/README.md). API readiness reports Database, Auth, Storage, and SMTP configuration components. Schema checks, actual email delivery, and restore verification remain separate operations.

## Sign-in and application authorization

1. The browser submits an email and password to FastAPI's `/api/auth/login` endpoint. FastAPI applies its durable login budget and asks the configured Supabase Auth instance to verify the password.
2. FastAPI verifies the returned provider token against the configured issuer, audience, expiry, subject, and session ID. It checks provider session liveness and requires an exact Supabase-user-ID binding to an active, eligible OpenSlate profile.
3. FastAPI creates its own revocable application session. The provider access token is returned in an HttpOnly cookie; a separate opaque refresh handle and CSRF value support the local session contract. Encrypted provider refresh credentials remain server-side in PostgreSQL.
4. Each protected request rechecks the local application session, provider identity/session, current profile eligibility, and current OpenSlate policy. FastAPI takes the organization from the `X-Org` header, else from the session's active organization. It requires an eligible membership there and binds the transaction to that organization. Capabilities, roles, groups, and resource-specific grants are evaluated by FastAPI. Supabase Auth metadata never supplies an OpenSlate permission.
5. Mutations require the existing CSRF and origin checks. Logout, account changes, recovery, and administrator revocation invalidate local application sessions; provider sign-out is a separate provider action.

The provider adapter and session boundary live in [`supabase_auth.py`](../../backend/app/core/integrations/supabase_auth.py), [`provider_login.py`](../../backend/app/systems/access/identity/provider_login.py), [`provider_sessions.py`](../../backend/app/systems/access/identity/provider_sessions.py), and [`auth.py`](../../backend/app/common/dependencies/auth.py).

One sign-in account can have memberships in multiple organizations, with different
roles in each. Browser identity/cache context follows the verified account and
current organization, but neither cached state nor a Realtime join projection
replaces the server's current source checks. Ordinary private-conversation reads
remain distinct from report-only moderation and captured export-purpose authority;
see the [API purpose boundary](07-api-architecture.md#ordinary-private-reads-versus-privileged-purposes).

## Invitation and password recovery

1. An authorized administrator sets an email, profile identity, role, groups, and invitation operation in OpenSlate. FastAPI reserves the pending application profile before calling the Supabase Auth admin API, then commits the exact provider-user binding.
2. Supabase Auth sends invitation and recovery email through the configured provider SMTP server. It fetches the versioned HTML templates from the internal FastAPI template route; the development overlay routes mail to Mailpit.
3. The email link opens an OpenSlate confirmation page with the one-time `token_hash` in the URL fragment. A browser preview GET does not exchange it. Only an explicit user submission sends the token hash to FastAPI.
4. FastAPI verifies the provider action, checks the exact bound profile and operation state, and sets the password through Auth. Invitation completion activates the pending profile. Recovery revokes OpenSlate application sessions and changes the provider password without issuing an application session.

FastAPI does not keep local password hashes, a local invitation/recovery token store, or a local SMTP outbox. Auth delivery and profile authorization remain separate operations.

## File upload and download

This sequence describes organization files. Account avatars use the separate
private `openslate-avatars` bucket and their account-scoped authorization path.

1. FastAPI checks the caller's file and parent-resource permissions in the bound organization and reserves metadata in PostgreSQL.
2. The upload request validates the file type in a bounded parser subprocess. An invalid file is refused with 422, and its reservation stays unused.
3. The server writes the validated bytes through the Storage API to the private `openslate-ready` bucket under the key `org/<org_id>/<hex>`, then commits the file as `ready` with its digest and size in the same request. The provider stores the bytes in the installation's Storage volume. A timeout or uncertain Storage operation leaves access denied and the operation visible for reconciliation, which sets `ready` only when the exact bytes exist.
4. Download again checks the caller and parent-resource permissions, fetches the complete ready object through the server-side adapter, verifies it, and rechecks authorization after I/O. The browser receives bytes only in the authorized FastAPI response, as an attachment with `nosniff`; it never receives Storage credentials or a direct bucket URL.

## Mutation and invalidation

The following sequence describes the SSE path retained by other application pages.

1. A route commits individual application ORM mutations and audit rows together through `AuditSession`.
2. After commit, the invalidation publisher sends a small opaque PostgreSQL `NOTIFY` on a separate direct connection. The `NOTIFY` payload carries the event's `org_id`; the browser never receives it.
3. The authenticated SSE listener receives the notification and sends a private invalidation or resync signal to eligible subscribers. Each stream binds to one organization when it opens (`/api/events?org=<id>`, else the session's active organization). The hub drops events of other organizations. It does not include row contents or replace a resource API.
4. The client refetches through FastAPI, where current identity and authorization are checked again.

This path remains PostgreSQL `LISTEN`/`NOTIFY` plus SSE; it does not replace the
private OpenComms path below.

## OpenComms commands, private events and jobs

1. An ordinary conversation command resolves the current sign-in session, organization membership,
   conversation access and operation capability. Individual `AuditSession` changes
   commit the business state and its required audit/notification references together.
2. The [publication wrapper](../../backend/app/systems/comms/realtime/publication.py)
   validates private envelopes against the bound actor/organization and buffers
   opaque events. Rollback discards the unpublished buffer; events contain no
   message body or attachment bytes.
3. For request-buffered events, middleware submits only after response completion
   and request cleanup. Resource-owned durable jobs instead detach committed events
   and close their own SQL session before submission; manual Send Now does not make
   that job publication wait for its HTTP response. Neither path retains a SQL
   session or pooled connection through the publisher's network I/O.
4. The bounded [HTTP publisher](../../backend/app/systems/comms/realtime/publisher.py)
   sends through the private server-key listener, not Caddy's browser route. Queue
   or network failure cannot undo a committed message; publication is best effort,
   not an atomic PostgreSQL-plus-provider transaction.
5. A browser obtains a five-minute purpose-specific token from `/api/realtime/token`.
   FastAPI refreshes the [conversation grants projection](../../backend/app/systems/comms/realtime/grants.py)
   from current readable sources. Realtime join admission checks current membership
   and exact topic kind; conversation joins additionally require a matching unexpired
   grant. Browser OpenComms
   topics are read-only: conversation, own-user and organization-presence topics
   carry notifications, while content and presence/typing commands use HTTP.
6. On an opaque notification or reconnect, the consumer refetches current authorized
   content. Content access is refused immediately after removal; an existing ID-only
   subscription can remain until token expiry. A topic token or earlier cached
   result cannot revive ordinary read permission.

[`jobs/worker.py`](../../backend/app/systems/comms/jobs/worker.py) uses the existing
organization-bound scheduler for scheduled sends, exports, retention and optional
link previews. Scheduled sends, exports and previews recheck their lease and
source/actor/version or captured authority as applicable. Scheduled sends re-enter
message admission; exports retain their separate privileged purpose. Retention
uses organization-bound sweep progress and confirmed cleanup to irreversibly
remove expired content.
The [schedule executor](../../backend/app/systems/comms/jobs/schedule_worker.py) and
[lifecycle description](09-lifecycle-and-state-management.md#comms-retention-and-durable-work)
define those boundaries. Startup, shutdown and worker ownership remain with the
FastAPI lifespan, not a second application server or independent authorization service.
