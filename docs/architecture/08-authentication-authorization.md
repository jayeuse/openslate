# Authentication and Authorization

> **Scope:** Supabase Auth identity, FastAPI-owned application sessions, and OpenSlate authorization.

Supabase Auth answers who a person is: it verifies email/password credentials, issues provider JWTs and refresh tokens, and delivers invitation, recovery and email-change confirmations. FastAPI answers what that person may access. It owns the local user profile, UUID used by application relationships and audit actors, session revocation, roles, groups, group access levels, and domain authorization. Supabase user metadata does not grant an OpenSlate role or permission.

## Authentication and session admission

Browser login accepts email and password through `/api/auth/login`; usernames are profile labels and are not login identifiers. FastAPI delegates the password grant to the installation's Supabase Auth endpoint. The backend verifies the JWT signature against the configured public JWKS and checks issuer, audience, expiry, subject, and provider session ID. It maps the subject only through the explicit unique `users.supabase_user_id` binding. A matching email address, unbound provider account, pending profile, disabled user, or expired guest cannot create application access.

After provider authentication, FastAPI records an application `identity_sessions` row keyed to the local user UUID and the provider user/session IDs. Browser requests carry the provider access JWT in an HttpOnly cookie and an opaque HttpOnly refresh handle backed by a stored digest; both cookies are Secure except during relaxed local HTTP development. The current provider access/refresh token pair is encrypted in the application session row; Supabase rotates its refresh token while the opaque application handle remains stable. Compose selects refresh-token algorithm version 2, enables rotation, sets a 10-second reuse interval, and disables unrestricted reuse. Under this counter-based contract, replay of an older ancestor outside the interval invalidates the provider session; the immediately preceding token remains an exception for recovery. These settings apply to fresh installations and do not convert existing legacy refresh tokens. A separate CSRF cookie/token protects state-changing cookie requests, which also enforce the configured Origin policy. CLI bearer requests use the same provider and local-session admission and cannot be mixed with browser cookies.

Protected requests revalidate provider claims, provider account and session liveness, the unrevoked/unexpired application session, the local user binding and eligibility, and current application authorization. Provider session existence is checked through a narrowly scoped read of `auth.sessions.id` and `auth.sessions.user_id` under the operator-provisioned `openslate_session_liveness` policy. FastAPI does not write Auth tables or use row policies as its domain authorization system.

The provider account check (ban state and MFA factors, read through the Supabase Auth admin API) is reused for up to 10 seconds per person in [`provider_user_cache.py`](../../backend/app/systems/access/identity/provider_user_cache.py). A reused account can only admit a request: when it would deny the request or require MFA, FastAPI repeats the check with a fresh provider read. Sign-in, token refresh, and email-change completion always read the provider account fresh, and verifying or removing a factor through OpenSlate drops that person's cached account at once, so every session must meet the new AAL2 requirement on its next request. Every other check in this section still runs on each request. A ban, deletion, or factor removal made directly in Supabase, outside OpenSlate, can therefore take up to 10 seconds to deny an otherwise valid session.

Visible, trusted browser activity can trigger bounded [session renewal](../../frontend/src/components/app-page.tsx), which rechecks the same account and stops when that account or session ends. Successful sign-in advances both durable local sign-in and activity timestamps; accepted refresh and successful MFA advance activity only. Failed attempts, reads, and revocation alone advance neither. This history survives session retention and is not provider MFA evidence: [MFA observations](../../backend/app/systems/access/identity/mfa_observations.py) remain bound to the current provider identity, and unavailable or unproven status is not inferred from local activity.

Session listing and revocation remain application-owned. Logout, self/admin revocation, account disablement, and recovery revoke the local session immediately; provider sign-out is attempted and retried through the durable provider sign-out worker if needed. A provider JWT alone is not enough to restore a locally revoked session. Password reauthentication for protected lifecycle operations delegates to Supabase Auth and must resolve back to the same eligible application actor.

Access administrators manage the [workspace Security policy](../../backend/app/systems/manage/workspace/security_router.py) and inspect [People security](../../backend/app/systems/access/users/security.py). Recovery and MFA-reset actions recheck the administrator's session and target provider binding before effects; MFA reset preserves required provider-assurance checks. Local history alone cannot authorize these actions.

## Invitations and recovery

Administrators set invitation eligibility and application access on the local profile before FastAPI calls the Auth invitation endpoint. The returned provider subject is explicitly bound to that profile. Provider metadata can carry exact invitation reconciliation markers, but it is not an authorization source. Resending or reconciling an invitation never links an account from email equality alone.

Supabase Auth email templates link to `/auth/setup` or `/auth/recovery` with the one-time `token_hash` and action type in the URL fragment. The frontend captures and removes the fragment token, then submits it with the user's explicit form action to FastAPI. Page preview or GET alone does not consume the link. FastAPI exchanges the token through Supabase Auth; invitation completion sets the provider password before activating the already-authorized local profile. Recovery updates the provider password and revokes the application's existing sessions; the recovery action does not directly grant a full application session.

## Confirmed email change

Profile's [Change email form](../../frontend/src/components/profile/components/email-change.tsx)
sends the new address and current password to
[`POST /api/auth/me/email`](../../backend/app/systems/access/auth/email_router.py).
The [request service](../../backend/app/systems/access/identity/email_changes.py)
verifies the password against the same bound provider subject and rechecks the
current application session, eligibility, MFA and source policy. An accepted
request returns `confirmation_required: true` and records a security event;
it does not change `users.email` or reserve the target address. Supabase secure
email change requires confirmation at both the current and new addresses.

`POST /api/auth/email/complete` accepts a purpose-bound `token_hash` only in a
signed-out browser context. Presence of either authentication cookie or any
`Authorization` header, even an empty credential, returns
`409 signed_out_required` before provider verification consumes the hash.
Origin, source-policy and rate-limit checks also precede consumption. The
[provider protocol](../../backend/app/core/integrations/supabase_email_changes.py)
recognizes the first-address acknowledgment exactly: it returns
`authenticated: false, confirmation_required: true`, with no local email,
session or cookie effect. The other address's confirmation supplies provider
tokens for ordinary protected application admission, not automatic replacement
of an existing browser account.

[`admit_provider_session`](../../backend/app/systems/access/identity/provider_sessions.py)
locks and freshly populates the profile selected by its existing
`supabase_user_id` binding, then obtains the provider's current eligible account
under that lock. After provider I/O it rechecks local eligibility, token expiry
and cutoff, provider-session existence and current source policy before
[`synchronize_confirmed_email`](../../backend/app/systems/access/identity/email_changes.py)
uses the provider's current confirmed email. This also reconciles a confirmed
change completed outside this UI; it never binds a different subject by email
or requires a local pending/request-correlation record. The email transition,
`identity.email_change_confirmed` event and new application session commit
together before cookies are issued. Repeated admission with an unchanged email
does not add another transition event. A new AAL1 session follows the existing
MFA continuation and cannot inherit an earlier browser session's AAL2.

Local email uniqueness remains authoritative across all profiles; the request's
availability check is not a reservation. If final provider confirmation succeeds
but local admission conflicts or fails, the transaction rolls back and no new
cookies are issued. The route reports `email_change_incomplete` (409 for a
conflict/refused admission, 503 for an unavailable dependency or failed commit),
not provider rollback or successful application completion. Cleanup attempts
target only the newly issued provider session. A legitimately resolved address
conflict is required before a later sign-in can succeed; no account merge or
automatic repair is performed.

This synchronization boundary does not weaken the current binding/email checks
in [password change and invitation/recovery completion](../../backend/app/systems/access/identity/provider_actions.py),
[administrator recovery](../../backend/app/systems/access/identity/admin_recovery.py),
[security recovery](../../backend/app/systems/access/identity/security_recovery.py),
[People security actions](../../backend/app/systems/access/users/security.py),
[invitation reconciliation](../../backend/app/systems/access/users/invitation_provider.py)
or [invitation provisioning](../../backend/app/systems/access/users/service.py).
Provider confirmation changes an existing eligible identity's address, not its
role, UUID or resource access.

The [`/auth/email-change` page](../../frontend/src/app/auth/email-change/page.tsx)
scrubs even malformed link material before its session probe, retains a valid
proof only in memory, and consumes it only on an explicit confirmation action.
An occupied browser offers explicit sign-out and rechecks the context; a failed
probe or logout never authorizes consumption. Its [API adapter](../../frontend/src/lib/auth-api.ts)
does not refresh or replay email commands after 401. An uncertain command
outcome is reported truthfully rather than resent automatically; failed
confirmation proof is discarded except for the pre-consumption signed-out
refusal. See the strict fragment parser in
[`action-token.ts`](../../frontend/src/lib/action-token.ts).

The checked-in [Compose configuration](../../infra/supabase/compose.yaml)
sets `GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED=true` and
`GOTRUE_MAILER_AUTOCONFIRM=false`. The [custom template](../../infra/supabase/templates/email-change.html)
links to `/auth/email-change#token_hash=…&type=email_change` using the provider's
recipient-specific `.TokenHash`. The [template route](../../backend/app/systems/access/auth/template_router.py)
serves only the three allowlisted templates without substituting token values.
The strict-host exception configured in [`main.py`](../../backend/app/main.py)
permits `api` and `host.docker.internal` only to GET those exact template paths,
not authentication or other API routes. These are source/configuration
contracts, not evidence that an existing provider has applied them or that mail
delivery and final installation acceptance are complete.

## Application authorization

`get_current_identity` in [`app/common/dependencies/auth.py`](../../backend/app/common/dependencies/auth.py) validates provider identity and resolves the local session before route dependencies inspect the current local role and group access. Application authorization remains in the OpenSlate model and policy code: the user role (`admin`, `member`, or `guest`), group access levels, guest eligibility, administrator-only routes (`require_admin`), Board scope, and Report-run eligibility. A disabled, pending, expired, or deleted account has no access. An identity must pass every applicable domain boundary before receiving Record values.

[`effective_levels`](../../backend/app/systems/access/policy/scope.py) is the one access function. An administrator has `manage` everywhere. For each of a user's groups, the most specific `group_access` row (the module row, else the department row) wins; the highest level across groups wins; a guest is limited to `read`; with no row there is no access. `allowed_module_ids` and `level_for` derive from it, and [`checks.py`](../../backend/app/systems/access/policy/checks.py) (`require_module_access`, `module_filter`, `department_filter`) applies them to Sandbox Record operations and the Record query routes used by OpenView Views, Charts, Dashboard widgets, and Board Record choices and widgets. [`capture_report_snapshot`](../../backend/app/systems/openview/reports/run_service.py) and the Report run/output routes recheck the same access. `GET /api/auth/me` returns the caller's compact entries, and administrators read any person's entries with the granting groups through `GET /api/users/{id}/access` (`explain_access`). Board visibility follows Board scope: every active account reads the company Board, a department Board follows department access, and a project Board follows `board_groups` ([`boards/access.py`](../../backend/app/systems/boards/access.py)). A retained Report run records eligible readers at capture and also requires current module access when its output is read ([`eligibility.py`](../../backend/app/systems/openview/reports/eligibility.py), [`run_reader_router.py`](../../backend/app/systems/openview/reports/run_reader_router.py)). User UUIDs, roles, group membership, and domain policy are read from OpenSlate application data, not copied from Supabase Auth claims.

Groups are administrator-managed, with one delegation. A non-guest active user with `manage` on every department that a group's live `group_access` rows reach may read that group and replace its members through `PUT /api/access/groups/{id}/members`; a module row counts as its department, and a group with no rows stays administrator-only. The decision is `EffectiveAccess.manages_all` over `group_reach` in [`scope.py`](../../backend/app/systems/access/policy/scope.py). [`delegation.py`](../../backend/app/systems/access/policy/delegation.py) locks the target group and its access rows, then the manager's memberships and their groups' access rows, then the manager's user row, so a concurrent change to the group's reach or to the manager's authority waits for the decision to commit. Membership changes are audited `GroupMember` inserts and deletes; renaming a group or changing its access stays administrator-only.
