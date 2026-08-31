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
| Local/remote identity coordination | **Partially Implemented**         | Invitation and user lifecycle compensation/ordering exists, but it spans local SQL and Supabase Auth operations.                                                              |

## AuthN and AuthZ are separate checks

The backend uses two distinct dependency layers in `backend/app/common/dependencies/auth.py`:

1. `get_current_user` performs AuthN. It extracts an access token through `HTTPBearer`, calls `backend/app/core/security/supabase.py:verify_supabase_jwt`, parses the `sub` claim as a UUID, and loads the matching local `User` with its `Role`. The local user must be present, not soft-deleted, have `status == "active"`, have a role, and have a non-deleted role. Failure returns `401` with the `WWW-Authenticate` challenge and the generic detail `Invalid authentication credentials`.
2. `require_capability(capability)` performs domain AuthZ after AuthN. The exact `admin` role is implicitly granted every capability; every other role must have the requested capability set to `true` in a valid permission document or receives `403 Forbidden`.
3. `require_roles(*roles)` remains available for literal role checks. The users, roles, invitation, audit, and purge routes use the exact `admin` role rather than capability grants.

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
| Literal-admin operations        | **Implemented**             | Users, roles, invitations, audit, and all purge routes require the exact `admin` role, even when a non-admin has all ten capabilities.                                                                                    |
| Current-user endpoint           | **Implemented**             | `GET /api/auth/me` requires AuthN and returns the role plus effective permissions sorted by capability name. Admin returns all ten; non-admin output contains only explicitly granted valid capabilities.                 |
| Historical permission documents | **Implemented fail-closed** | Malformed persisted documents remain readable as stored role data but are ineffective for non-admin authorization, yielding no effective capabilities. Admin remains implicit-all regardless of its stored document.      |

Built-in roles are protected from rename/delete. Custom role rows can be created and assigned by an administrator; their names do not grant access, because domain routes evaluate the capability document. Role/status changes also enforce the “last active administrator” checks in `backend/app/systems/users/router.py`.

Capability checks do not establish resource ownership or tenancy. FastAPI is authoritative for this RBAC decision: direct database access can bypass JWT, capability, and literal-admin checks (as well as application validation and ORM audit capture).

## Browser sessions and the BFF

The backend `/api` does not issue or refresh browser sessions. Those operations are implemented by Next route handlers:

- `frontend/src/app/session/login/route.ts:POST` validates same-origin input with Zod, calls Supabase `signInWithPassword`, and sets `openslate_access` and `openslate_refresh` cookies.
- `frontend/src/lib/auth-cookies.ts:setAuthCookies` makes both cookies HttpOnly, SameSite `Lax`, path `/`, secure in production; the access cookie follows the Supabase access lifetime and the refresh cookie has a seven-day max age.
- `frontend/src/app/session/status/route.ts:GET` calls `establishSupabaseSession`, refreshes/validates the cookie pair, and returns only `{authenticated: boolean}` with no-store caching.
- `frontend/src/app/session/logout/route.ts:POST` attempts local Supabase sign-out, but always clears both browser cookies even when Auth is unavailable.
- `frontend/src/app/bff/[...path]/route.ts:handle` reads the access cookie, forwards the access token to `BACKEND_URL/api/...`, checks same-origin for non-safe methods, and retries a backend `401` once after a refresh-token exchange. Refresh failure clears cookies and returns `401`; a backend `403` is not refreshed.
- `frontend/src/lib/supabase/server.ts:createSupabaseServerClient` uses the publishable key and disables client persistence, automatic refresh, and URL session detection for these server-side route clients.

The browser therefore presents cookies to the Next BFF, while the backend receives only the access token and does not receive the refresh token.

## Invitation and password setup

### Backend invitation saga

`POST /api/auth/invitations` in `backend/app/systems/auth/router.py:invite` and `POST /api/users` in `backend/app/systems/users/router.py:create_user` both call `backend/app/systems/users/service.py:invite_user`.

1. `InvitationCreate`/`UserCreate` normalizes the email and username and accepts an optional role ID. Without a role ID, the service selects the active built-in member role.
2. The service rejects an existing non-recoverable local profile as a conflict.
3. `SupabaseAdminClient:invite_user` calls the Supabase Auth invitation endpoint with the configured redirect URL using the server secret key.
4. The Auth-created identity is expected to have a trigger-created local pending profile. The service reloads that profile, writes the requested email/username/role, marks it active, clears local deletion state, commits, refreshes, and returns `UserResponse`.
5. If finalization fails, the local session is rolled back and the service attempts to delete the external Auth identity. A recoverable pending profile with an `auth_` placeholder username is reconciled by deleting the previous external invite before restarting the saga.

The route maps an invitation conflict to `409` and handled `InvitationError` failures to `502 Unable to send invitation`. A `SupabaseAdminClient` configuration error can occur before the service's conversion block and is not normalized by a global exception handler. The profile trigger is defined by migration `0010`.

### Callback and password setup

`frontend/src/app/auth/callback/route.ts:GET` accepts either a PKCE `code` or an invitation `token_hash` with `type=invite`, but not both. It exchanges/verifies the value through Supabase, sets the two HttpOnly cookies, and redirects to `/auth/setup`; invalid input/result redirects to `/login`.

`frontend/src/app/session/password/route.ts:POST` requires a same-origin request with two equal passwords, each 12–1024 characters. It establishes the current cookie session, calls Supabase `updateUser({password})`, and reissues cookies on success. Same-origin failure returns `403`, missing session cookies return `401`, and validation/update failures return `400`; cookies are cleared when no session can be established.

## User status and remote Auth coordination

The local status gate is authoritative for backend requests: `pending`, `disabled`, or a soft-deleted local user fails `get_current_user` even if an access token still verifies cryptographically.

For administrative lifecycle changes:

- Disabling a user commits the local disabled state first, then calls `SupabaseAdminClient:disable_user`. Existing JWTs consequently fail the local status check even if the remote call returns an error; the route reports remote failure as `503`.
- Re-enabling calls the remote enable operation before committing the active local state. Failure is reported as `503`.
- Deleting a user marks the local profile deleted/disabled and commits before attempting remote disable. Self-delete and deletion of the last active administrator are rejected before mutation.
- Restoring a user enables the external identity, sets local active/non-deleted state, and commits.

These are implemented cross-system sequences in `backend/app/systems/users/router.py`; there is no separate asynchronous reconciliation worker in the reviewed backend source.

## Source grounding

- `backend/app/common/dependencies/auth.py:get_current_user`, `require_capability`, and `require_roles`.
- `backend/app/core/security/supabase.py:verify_supabase_jwt`.
- `backend/app/systems/users/models.py:User`, `Role`, `UserRole`, and `UserStatus`.
- `backend/app/systems/users/permissions.py:Capability`, `validate_permissions`, `effective_permissions`, and `has_capability`.
- `backend/app/systems/users/service.py:invite_user` and `backend/app/core/integrations/supabase.py:SupabaseAdminClient`.
- `backend/app/systems/auth/router.py:invite` and `me`; `backend/app/systems/users/router.py` user/role handlers.
- `frontend/src/app/session/login/route.ts`, `logout/route.ts`, `password/route.ts`, `status/route.ts`.
- `frontend/src/app/auth/callback/route.ts`, `frontend/src/app/bff/[...path]/route.ts`, and `frontend/src/lib/auth-cookies.ts`.
