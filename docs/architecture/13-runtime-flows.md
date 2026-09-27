# Runtime Flows

> **Scope:** Current Supabase-backed startup, identity, file, and invalidation paths.

## Development startup

1. The developer keeps a private root `.env` with a unique `OPENSLATE_INSTANCE_ID`, instance root, loopback ports, provider values, application connection URLs, and scanner paths. `scripts/environment.py` validates it before a Compose mutation.
2. `./scripts/dev.py db` starts the pinned Supabase development stack. Project labels, expected image, database volume, provider network, role, and live database target are checked by the instance guard before mutations are admitted.
3. From `backend/`, `uv run python operations/provision_database_role.py` provisions `openslate_owner` and `openslate_runtime` using `DATABASE_BOOTSTRAP_URL`. Alembic then applies application schema with `uv run alembic upgrade head`; `uv run alembic check` verifies model/schema alignment.
4. `uv run python operations/provision_storage.py` creates and verifies the private quarantine and ready buckets. It requires the admitted runtime database and server-only Supabase credentials.
5. `uv run python operations/bootstrap_admin.py` reserves the first administrator profile and sends a Supabase Auth invitation. The recipient sets a password through the OpenSlate invite page.
6. FastAPI starts with `uv run python -m app --reload`; the frontend starts with `npm run dev`. Next forwards only its same-origin `/api` requests to FastAPI. The scanner worker is started only after verified ClamAV definitions and its manifest are available.

The checked-in development commands and production sequence are in [`infra/supabase/README.md`](../../infra/supabase/README.md). API readiness reports Database, Auth, Storage, SMTP configuration, and scanner components. The development/test API can start before its optional scanner worker; production readiness requires both worker leadership and engine health. The worker depends on API liveness, so readiness does not create a startup cycle. Schema checks, actual email delivery, and restore verification remain separate operations.

## Sign-in and application authorization

1. The browser submits an email and password to FastAPI's `/api/auth/login` endpoint. FastAPI applies its durable login budget and asks the configured Supabase Auth instance to verify the password.
2. FastAPI verifies the returned provider token against the configured issuer, audience, expiry, subject, and session ID. It checks provider session liveness and requires an exact Supabase-user-ID binding to an active, eligible OpenSlate profile.
3. FastAPI creates its own revocable application session. The provider access token is returned in an HttpOnly cookie; a separate opaque refresh handle and CSRF value support the local session contract. Encrypted provider refresh credentials remain server-side in PostgreSQL.
4. Each protected request rechecks the local application session, provider identity/session, current profile eligibility, and current OpenSlate policy. Capabilities, roles, groups, and resource-specific grants are evaluated by FastAPI. Supabase Auth metadata never supplies an OpenSlate permission.
5. Mutations require the existing CSRF and origin checks. Logout, account changes, recovery, and administrator revocation invalidate local application sessions; provider sign-out is a separate provider action.

The provider adapter and session boundary live in [`supabase_auth.py`](../../backend/app/core/integrations/supabase_auth.py), [`provider_login.py`](../../backend/app/systems/access/identity/provider_login.py), [`provider_sessions.py`](../../backend/app/systems/access/identity/provider_sessions.py), and [`auth.py`](../../backend/app/common/dependencies/auth.py).

## Invitation and password recovery

1. An authorized administrator sets an email, profile identity, role, groups, and invitation operation in OpenSlate. FastAPI reserves the pending application profile before calling the Supabase Auth admin API, then commits the exact provider-user binding.
2. Supabase Auth sends invitation and recovery email through the configured provider SMTP server. It fetches the versioned HTML templates from the internal FastAPI template route; the development overlay routes mail to Mailpit.
3. The email link opens an OpenSlate confirmation page with the one-time `token_hash` in the URL fragment. A browser preview GET does not exchange it. Only an explicit user submission sends the token hash to FastAPI.
4. FastAPI verifies the provider action, checks the exact bound profile and operation state, and sets the password through Auth. Invitation completion activates the pending profile. Recovery revokes OpenSlate application sessions and changes the provider password without issuing an application session.

FastAPI does not keep local password hashes, a local invitation/recovery token store, or a local SMTP outbox. Auth delivery and profile authorization remain separate operations.

## File upload, scan, and download

1. FastAPI checks the caller's file and parent-resource permissions and reserves metadata in PostgreSQL.
2. The server writes bytes through the Storage API to the private quarantine bucket. The provider stores the bytes in the installation's Storage volume.
3. The serial scanner worker claims the queued file, verifies its size and digest against stored bytes, and scans it with the configured ClamAV service. A clean result is promoted to the private ready bucket and committed with the file state. A timeout, mismatch, infection, or uncertain Storage operation leaves access denied and the operation visible for retry or reconciliation.
4. Download again checks the caller and parent-resource permissions, fetches the complete ready object through the server-side adapter, verifies it, and rechecks authorization after I/O. The browser receives bytes only in the authorized FastAPI response; it never receives Storage credentials or a direct bucket URL.

## Mutation and invalidation

1. A route commits individual application ORM mutations and audit rows together through `AuditSession`.
2. After commit, the invalidation publisher sends a small opaque PostgreSQL `NOTIFY` on a separate direct connection.
3. The authenticated SSE listener receives the notification and sends a private invalidation or resync signal to eligible subscribers. It does not include row contents or replace a resource API.
4. The client refetches through FastAPI, where current identity and authorization are checked again.

This path remains PostgreSQL `LISTEN`/`NOTIFY` plus SSE. Direct browser Realtime subscriptions are not enabled.
