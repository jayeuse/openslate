# Authentication and Authorization

> **Scope:** Supabase Auth sessions, backend JWT verification, local role authorization, invitations, and the session-to-API path.
> **Audience:** Security reviewers, backend/frontend engineers, and operators diagnosing access decisions.
> **Related documents:** [Backend architecture](04-backend-architecture.md), [API architecture](07-api-architecture.md), [Audit and history](10-audit-and-history.md), [Security architecture](14-security-architecture.md)

## Status summary

| Concern                            | Status                            | Evidence-based state                                                                                                                                                          |
| ---------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential and session authority   | **Implemented**                   | Supabase Auth owns sign-in, password update, invitation delivery, refresh, and sign-out; the Next session routes hold the resulting tokens in HttpOnly cookies.               |
| Backend AuthN                      | **Implemented**                   | `verify_supabase_jwt` validates the access token, then `get_current_user` resolves an active local profile and role.                                                          |
| Backend AuthZ                      | **Implemented**                   | `get_current_user` establishes identity, then route dependencies apply capability guards or literal-admin guards.                                                             |
| Permission metadata                | **Implemented and evaluated**     | `Role.permissions` accepts strict flat boolean documents for the ten known capabilities; effective permissions are evaluated by domain guards and returned by `/api/auth/me`. |
| Custom role authorization          | **Implemented for domain access** | Custom roles can be created/assigned and use independent read/write capability guards; management and purge operations remain literal-admin-only.                             |
| Local/remote identity coordination | **Partially Implemented**         | Invitation uses short preflight/finalization DB phases with durable correlated `SecurityEvent` attempt/outcome rows, leaves the trigger profile pending, and never destructively compensates after Auth success; centralized invitation eligibility now gates authentication and administrator transitions, while disable/delete remain local-first and activation/restore remain fail-closed with revalidation. Cross-system failures still require explicit reconciliation and session checks. |

## AuthN and AuthZ are separate checks

The backend uses two distinct dependency layers in `backend/app/common/dependencies/auth.py`:

1. `get_current_user` performs AuthN. It extracts an access token through `HTTPBearer`, calls `backend/app/core/security/supabase.py:verify_supabase_jwt`, parses the `sub` claim as a UUID, and loads the matching local `User` with its `Role`. The local user must be present, not soft-deleted, have `status == "active"`, satisfy `users.eligibility:is_established_user`, have a role, and have a non-deleted role. It then enforces the token cutoff: when `User.tokens_valid_after` is set, the JWT `iat` must not be earlier than the cutoff (missing/unparsable `iat` also fails). Failure returns `401` with the `WWW-Authenticate` challenge and the generic detail `Invalid authentication credentials`. Refresh-session revocation is not verified by the backend; only this access-token cutoff plus the local status and invitation-eligibility gates limit previously issued tokens.
2. `require_capability(capability)` performs domain AuthZ after AuthN. The exact `admin` role is implicitly granted every capability; every other role must have the requested capability set to `true` in a valid permission document or receives `403 Forbidden`.
3. `require_roles(*roles)` remains available for literal role checks. The users, roles, invitation, audit, security-event read/export, and purge routes use the exact `admin` role rather than capability grants.

When AuthN succeeds, `get_current_user` also calls `set_audit_actor(db, user.id)`, placing the local actor ID in the request session’s `AuditContext`. This actor is later copied to audited domain rows and audit logs.

Missing or malformed access credentials are rejected by `HTTPBearer(auto_error=True)` before the body of `get_current_user`; the application does not replace that framework-generated dependency response with a custom handler.

## JWT validation

`backend/app/core/security/supabase.py:verify_supabase_jwt` is a local verifier for Supabase access tokens. It:

- Resolves the JWKS URL from settings, falling back to `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`.
- Requires configured issuer and audience values; the default audience is `authenticated`.
- Obtains a signing key through a cached `PyJWKClient` and permits only `ES256` or `RS256`.
- Decodes with issuer and audience checks and PyJWT expiry validation.
- Requires `sub`, `iss`, `aud`, and `exp` claims even if decoding would otherwise succeed without an expiry claim.
- Accepts a string UUID subject only; a missing, non-string, empty, or invalid UUID subject is rejected.
- Returns claims on success and `None` for the handled invalid-token, key-client, type, or value failures.

The backend does not retain a local password hash. `User.id` corresponds to the external `auth.users.id` identity, while the local `User` row supplies application status and role state (`backend/app/systems/users/models.py:User`).

## Application RBAC model

OpenSlate has one trust domain per deployment. There is no tenant key or tenant-isolation predicate; existing database RLS is not tenant isolation, and the FastAPI application boundary is global within that deployment. The implemented role model is:

| Role concern                    | Status                      | Behavior                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in role names             | **Implemented**             | `UserRole.ADMIN == "admin"` and `UserRole.MEMBER == "member"`; the exact `admin` name has implicit access to every capability.                                                                                            |
| Capability vocabulary           | **Implemented**             | Exactly ten flat capabilities: `departments.read`, `departments.write`, `modules.read`, `modules.write`, `fields.read`, `fields.write`, `records.read`, `records.write`, `relationships.read`, and `relationships.write`. |
| Local role persistence          | **Implemented**             | `Role.role` is unique; `Role.permissions` is a mutable JSONB object exposed by `RoleResponse`.                                                                                                                            |
| Permission-document validation  | **Implemented**             | New role documents must be flat objects whose keys are known capabilities and whose values are actual booleans. Omitted capabilities default to denied.                                                                   |
| Capability evaluation           | **Implemented**             | Non-admin roles are denied unless the requested capability is explicitly `true` in a valid document. Read and write capabilities have no implication for one another.                                                     |
| Domain guards                   | **Implemented**             | Departments, modules, fields, records, and relationships use their matching `.read` guards for reads and `.write` guards for writes. Close/reopen uses the target resource's `.write` capability.                         |
| Literal-admin operations        | **Implemented**             | Users, roles, invitations, audit, security-event read/export, and all purge routes require the exact `admin` role, even when a non-admin has all ten capabilities.                                                     |
| Current-user endpoint           | **Implemented**             | `GET /api/auth/me` requires AuthN and returns the role plus effective permissions sorted by capability name. Admin returns all ten; non-admin output contains only explicitly granted valid capabilities.                 |
| Historical permission documents | **Implemented fail-closed** | Malformed persisted documents remain readable as stored role data but are ineffective for non-admin authorization, yielding no effective capabilities. Admin remains implicit-all regardless of its stored document.      |

Built-in roles are protected from rename/delete. Custom role rows can be created and assigned by an administrator; their names do not grant access, because domain routes evaluate the capability document. Role/status changes use `backend/app/systems/users/coordination.py` for locks and projected active-administrator counts, `backend/app/systems/users/account_operations.py` for update/delete/restore, and `backend/app/systems/users/reconciliation.py` for explicit Auth realignment. These paths enforce the "last active administrator" checks through `require_fresh_exact_admin` (literal-admin row lock plus actor reload), `with_for_update` row locks, invitation-eligibility-aware projected-admin-count evaluation, and post-Auth state revalidation for activation/restore.

Capability checks do not establish resource ownership or tenancy. FastAPI is authoritative for this RBAC decision: direct database access can bypass JWT, capability, and literal-admin checks (as well as application validation and ORM audit capture).

## Browser sessions and the BFF

The backend `/api` does not issue or refresh browser sessions. Those operations are implemented by Next route handlers:

- `frontend/src/app/session/login/route.ts:POST` validates same-origin input with Zod, calls Supabase `signInWithPassword`, and sets `openslate_access` and `openslate_refresh` cookies.
- `frontend/src/lib/auth-cookies.ts:setAuthCookies` makes both cookies HttpOnly, SameSite `Lax`, path `/`, secure in production; the access cookie follows the Supabase access lifetime and the refresh cookie has a seven-day max age.
- `frontend/src/app/session/status/route.ts:GET` calls `establishSupabaseSession`, refreshes/validates the cookie pair, and returns only `{authenticated: boolean}` with no-store caching.
- `frontend/src/app/session/logout/route.ts:POST` attempts local Supabase sign-out, but always clears both browser cookies even when Auth is unavailable.
- `frontend/src/app/bff/[...path]/route.ts:handle` reads the access cookie, forwards the access token to `BACKEND_URL/api/...`, checks same-origin for non-safe methods, and retries a backend `401` once after a refresh-token exchange. It denies `auth/invitations/accept` with `403`. Refresh failure clears cookies and returns `401`; a backend `403` is not refreshed.
- `frontend/src/lib/supabase/server.ts:createSupabaseServerClient` uses the publishable key and disables client persistence, automatic refresh, and URL session detection for these server-side route clients.

The browser therefore presents cookies to the Next BFF, while the backend receives only the access token and does not receive the refresh token.

## Invitation and password setup

### Backend invitation saga

`POST /api/auth/invitations` in `backend/app/systems/auth/router.py:invite` and `POST /api/users` in `backend/app/systems/users/router.py:create_user` both call `backend/app/systems/users/service.py:invite_user`; `POST /api/auth/invitations/{user_id}/resend` calls `resend_invitation` and `POST /api/auth/invitations/accept` calls `backend/app/systems/users/acceptance.py:accept_verified_invitation`.

1. `InvitationCreate`/`UserCreate` normalizes the email and username and accepts an optional role ID. Without a role ID, the service locks and selects the active built-in member role. Request callers must supply the freshly authorized admin ID (`require_fresh_exact_admin`); only the explicit `bootstrap=True` path may omit it.
2. The service runs a short preflight DB phase (admin/role locks, duplicate email/username check with `with_for_update`), captures immutable actor/target/role/email state as plain values, then rolls back so no transaction or row lock survives the Auth HTTP call. It emits a durable correlated `user.invitation` attempt `SecurityEvent` (`users.service`, fresh `operation_id`) before contacting Auth.
3. `SupabaseAdminClient:invite_user` calls the Supabase Auth invitation endpoint with the configured redirect URL using the server secret key.
4. The Auth-created identity is expected to have a trigger-created local pending profile (`auth_<hex>` placeholder username, member role, `pending`, no timestamps). A short finalization DB phase starts a fresh transaction, revalidates the admin, compares stored member/invitation role states, verifies the exact placeholder profile state, then writes the requested email/username/role, keeps `pending` with `invitation_sent_at`, commits, and emits the correlated outcome (`success`; `failure` for pre-Auth conflicts/send errors; `partial` when finalization fails). `resend_invitation` keeps the same shape for pending invites with `invitation_sent_at` set: snapshot state, rollback, `user.invitation_resend` attempt, `SupabaseAdminClient:resend_invitation` without deleting the Auth identity, then revalidation plus `invitation_sent_at` refresh. Provider calls use captured plain values and never expired ORM attributes.
5. After Auth success the saga never destructively compensates: on finalization failure it rolls back the local transaction, emits `partial`, and leaves the trigger profile pending without deleting the external Auth identity.

The route maps an invitation conflict to `409` and handled `InvitationError` failures to `502 Unable to send invitation` (`502 Unable to resend invitation` for resend; accept failures map to `409 Invitation cannot be accepted`). A `SupabaseAdminClient` configuration error can occur before the service's conversion block and is not normalized by a global exception handler. The profile trigger is defined by migration `0010`.

### Callback and password setup

`frontend/src/app/auth/callback/route.ts:GET` accepts either a PKCE `code` or an invitation `token_hash` with `type=invite`, but not both. It exchanges/verifies the value through Supabase, sets the two HttpOnly cookies, and redirects to `/auth/setup`; invalid input/result redirects to `/login`.

`frontend/src/app/session/password/route.ts:POST` requires a same-origin request with two equal passwords, each 12–1024 characters. It establishes the current cookie session, calls Supabase `updateUser({password})`, then directly calls private `POST /api/auth/invitations/accept` with the fresh access token after a successful password update; it is the only browser-facing acceptance path. `backend/app/common/dependencies/auth.py:get_verified_pending_identity` derives the verified subject/email from that JWT (no active-local gate), and `backend/app/systems/users/acceptance.py:accept_verified_invitation` requires subject/email match against the pending profile, locks the admin role plus profile/role rows, and flips a pending invite with `invitation_sent_at` to `active` with `invitation_accepted_at`. Same-origin failure returns `403`, missing session cookies return `401`, and validation/update/acceptance failures return `400`; cookies are cleared when no session can be established, otherwise the established session cookies are preserved. `backend/scripts/bootstrap_admin.py` reserves any non-deleted pending/active admin assignment through the same invite path and leaves the profile `pending` until this verified acceptance completes; only the exact same pending reservation is idempotent, finalization rechecks under the admin-role lock, and a concurrent loser remains a pending member profile with no destructive compensation.

## User status and remote Auth coordination

The local status and invitation-provenance gates are authoritative for backend requests. `pending`, `disabled`, or a soft-deleted local user fails `get_current_user` even if an access token still verifies cryptographically. A non-pending profile with `invitation_sent_at` but no `invitation_accepted_at` is also unestablished and fails authentication and administrator eligibility. A non-pending profile with an acceptance timestamp is established; a non-pending profile with neither invitation timestamp is treated as an eligible legacy account.

### Invitation eligibility and recovery policy

The centralized `backend/app/systems/users/eligibility.py` policy applies the same classification to authentication, activation, restoration, and active-administrator counting:

| Profile state | Eligibility |
| --- | --- |
| `pending`, regardless of timestamp values | Always ineligible; verified invitation acceptance is the only activation path. |
| Non-pending with `invitation_sent_at` and no `invitation_accepted_at` | Unaccepted; cannot authenticate, activate, or restore. |
| Non-pending with `invitation_accepted_at` | Eligible established account. |
| Non-pending with neither invitation timestamp | Eligible legacy account; no timestamp is inferred or backfilled. |

`PATCH /users/{user_id}` returns `409` for pending-to-disabled and unaccepted-to-active transitions. Deleting a pending invitation preserves `pending`, advances the token cutoff, and disables the remote Auth identity after local commit. A deleted, unaccepted invitation cannot be restored and its email remains reserved; recovery or reuse requires a separately approved procedure. A known corrupted active profile with sent-but-unaccepted invitation provenance is denied authentication and excluded from active-administrator counts. These rules are implemented in source, with targeted registered API/PostgreSQL and final verification evidence recorded in [Testing architecture](16-testing-architecture.md).

For administrative lifecycle changes (`backend/app/systems/users/account_operations.py` and `backend/app/systems/users/reconciliation.py`, each with correlated `user.authentication_*` attempt/outcome `SecurityEvent` rows):

- Disabling a user is local-first: it commits the local `disabled` state and advances `User.tokens_valid_after` first, then calls `SupabaseAdminClient:disable_user`. Previously issued access tokens consequently fail the local status/cutoff check even if the remote call returns an error; the route reports remote failure as `503`.
- Deleting a user is local-first: it marks the local profile deleted/disabled, advances the token cutoff, and commits before attempting remote disable. Self-delete and deletion of the last active administrator are rejected before mutation (admin-role lock plus projected-admin-count check).
- Activation (`PATCH /users/{user_id}` to `active`) and restore (`POST /users/{user_id}/restore`) are fail-closed: they snapshot local state, roll back, call the remote enable operation first, then revalidate the admin (`require_fresh_exact_admin`), relock user/role rows, verify unchanged state plus active role, recheck the projected last-admin invariant, and only then commit `active`/non-deleted state. Pending and other unaccepted invites cannot be activated or restored (`409`); verified acceptance is required, and deleted unaccepted invitations remain deleted. Local finalization failure after remote success is recorded as `partial`.
- `POST /users/{user_id}/reconcile-auth` is the explicit realignment path: it snapshots local state, emits an attempt event, enables or disables the Auth identity to match the desired local state (`active` plus non-deleted means enable, otherwise disable), then revalidates; on drift it stays fail-closed (including forcing a locally active profile to `disabled` with a cutoff advance when remote disable succeeded) and records `partial`.

Token cutoff semantics: `User.tokens_valid_after` (`backend/app/systems/users/models.py:User`) is advanced to now on local disable/delete (and on the fail-closed reconcile path above). `get_current_user` rejects any access token with `iat` earlier than the cutoff. Supabase refresh-session revocation is not verified by the backend and remains absent/unverified; the cutoff plus the local status gate are the only implemented limits on previously issued tokens.

There is no separate asynchronous reconciliation worker in the reviewed backend source.

## Source grounding

- `backend/app/common/dependencies/auth.py:get_current_user`, `get_verified_pending_identity`, `require_fresh_exact_admin`, `require_capability`, and `require_roles`.
- `backend/app/core/security/supabase.py:verify_supabase_jwt`.
- `backend/app/systems/users/models.py:User`, `Role`, `UserRole`, and `UserStatus`.
- `backend/app/systems/users/permissions.py:Capability`, `validate_permissions`, `effective_permissions`, and `has_capability`.
- `backend/app/systems/users/service.py:invite_user`, `resend_invitation`; `backend/app/systems/users/acceptance.py:accept_verified_invitation`; `backend/app/systems/users/account_operations.py:update_user`, `delete_user`, and `restore_user`; `backend/app/systems/users/reconciliation.py:reconcile_auth`; `backend/app/systems/users/coordination.py`; `User.tokens_valid_after`; `backend/app/core/integrations/supabase.py:SupabaseAdminClient`.
- `backend/scripts/bootstrap_admin.py` for pending-until-acceptance bootstrap.
- `backend/app/systems/auth/router.py:invite`, `resend`, `accept_invitation`, and `me`; `backend/app/systems/users/router.py`, `backend/app/systems/users/roles_router.py`, `backend/app/systems/users/account_operations.py`, and `backend/app/systems/users/reconciliation.py` for the aggregated user/role/account handlers.
- `frontend/src/app/session/login/route.ts`, `logout/route.ts`, `password/route.ts` (including the accept call), `status/route.ts`.
- `frontend/src/app/auth/callback/route.ts`, `frontend/src/app/bff/[...path]/route.ts`, and `frontend/src/lib/auth-cookies.ts`.
