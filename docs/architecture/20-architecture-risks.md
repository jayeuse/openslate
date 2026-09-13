# Architecture Risks

> **Scope:** Current architectural weaknesses, consequences, affected components, and recommended directions.
> **Audience:** Maintainers prioritizing reliability, security, consistency, and delivery work.
> **Related documents:** [Security architecture](14-security-architecture.md), [Testing architecture](16-testing-architecture.md), [Deployment](12-deployment-architecture.md), [Architecture decisions](19-architecture-decisions.md)

This document is intentionally editorial. Descriptive documents state current behavior and link here rather than embedding recommendations.

## R1 — No tenant isolation; one trust domain per deployment

**Current design:** Users and all domain/audit rows have no tenant key; authorization is global capability/role RBAC within a deployment; RLS has no tenant predicate. Each deployment must remain one trust domain.

**Problem:** If mutually untrusted businesses share one deployment, an administrator can access all application data through normal APIs.

**Consequence:** Complete cross-tenant confidentiality/integrity failure.

**Affected:** Users, all domain routers/models, audit, relationships, lifecycle, RLS.

**Recommended direction:** Keep mutually untrusted businesses in separate deployments, or add end-to-end tenant identifiers, constraints, authorization context, RLS, and cross-tenant tests before supporting shared tenancy.

## R2 — Frontend environment isolation (resolved)

**Current design:** The supported local path uses `frontend/.env.local` based on
`frontend/.env.example`, containing only `BACKEND_URL`, public Supabase values,
and the optional purge flag. The root `.env` is not sourced into npm or Next.js,
and `npm ci` runs without backend secrets.

The previous root-environment export was the identified risk. Keep the explicit
frontend allowlist and isolated migration credentials in future operational
changes.

## R3 — Runtime DB access bypasses application authorization and audit

**Current design:** `openslate_app` receives broad CRUD with true-predicate RLS; `openslate_runtime` inherits it. Application audit is ORM-only.

**Problem:** A leaked/reachable DB credential can bypass JWT checks, application invariants, and listener-based audit, and can insert misleading audit rows.

**Consequence:** Broad data compromise and unreliable audit history.

**Affected:** Migration `0010`, role provisioning, all application tables, audit.

**Recommended direction:** Keep database private/TLS-protected, rotate and scope credentials, harden role verification, and consider restrictive tenant/procedure boundaries where the threat model requires them.

## R4 — Hosted deployment security and recovery are unspecified

**Current design:** Images exist and the approved contract requires one trust
domain per deployment, isolated Auth/PostgreSQL/Storage/secrets/backups/admin
population, and private FastAPI access. Provider/topology selection, ingress,
TLS/HSTS, trusted proxy/Host handling, network policy, secret delivery,
backup/PITR, restore, and monitoring do not.

**Problem:** Operators can publish a topology that exposes tokens, passwords, server keys, DB, Studio, or backend ports and has no tested recovery.

**Consequence:** Account/data compromise, late detection, and unrecoverable failure.

**Affected:** Deployment, infrastructure, configuration, observability.

**Recommended direction:** Define a supported hosted topology and security/recovery runbook before claiming production support.

## R5 — Audit redaction misses historical dynamic field sensitivity

**Current design:** Name-based redaction still does not match UUID-keyed `Record.data` values. Dynamic `Field.audit_redacted` is implemented: `listeners._record_redacted_fields` loads the current flagged field-UUID set (including renamed and soft-deleted fields) and redacts those values as `[REDACTED]` only in newly created Record audit snapshots, without changing `Record.data`. Previously stored clear snapshots are untouched; audit history still survives entity purge.

**Problem:** Sensitive business-field values stored before flagging remain in clear in audit JSON and backups.

**Consequence:** Extended retention and failed erasure expectations for historical rows.

**Affected:** Records, `Field.audit_redacted`, audit snapshots/listeners, lifecycle purge, retention policy.

**Recommended direction:** Keep the current flag for new snapshots; define retention and separately approved historical remediation (rewrite/backfill policy) for pre-flag clear values and backups.

## R6 — Last-administrator invariant relies on mutex plus revalidation, with a cross-system crash window

**Current design:** User/role updates, deletes, activation, and restore use `backend/app/systems/users/account_operations.py` with `backend/app/systems/users/coordination.py` to lock the literal admin role and target rows (`require_fresh_exact_admin` plus `with_for_update`), evaluate the projected active-admin count, and revalidate admin plus unchanged user/role state after remote Auth calls before committing. `backend/app/systems/users/reconciliation.py` provides explicit Auth realignment.

**Problem:** The single-database race is now serialized, but activation/restore enable the Auth identity before the local commit. A crash between provider success and local finalization still leaves Auth enabled while the local profile is not active.

**Consequence:** Administrative divergence requiring explicit recovery (`POST /users/{user_id}/reconcile-auth`) rather than silent lockout; concurrent edge cases outside the locked transaction still need regression coverage.

**Affected:** `users/account_operations.py`, `users/reconciliation.py`, `users/coordination.py`, `require_fresh_exact_admin`, admin operations, integration tests.

**Recommended direction:** Keep the mutex/revalidation pattern; add multi-connection regression tests and document the crash-window recovery via explicit reconcile plus correlated `SecurityEvent` outcomes.

## R7 — Application bounds exist, but aggregate traffic controls remain absent

**Current design:** FastAPI rejects request bodies over 1 MiB, and the BFF
stream-counts request bodies and buffered backend responses (8 MiB default),
uses a total deadline, and returns diagnostic IDs. Backend database pool,
connection, statement, concurrency, and readiness-probe bounds are configured.
There is still no distributed or ingress-level general rate limiter.

**Problem:** Oversized or repeated requests can consume memory, connections, DB capacity, and audit storage.

**Consequence:** Service degradation or denial of service.

**Affected:** Next BFF/session routes, FastAPI, records/roles/fields, ingress,
database capacity, and hosted topology.

**Recommended direction:** Retain the application bounds and safe failure
responses. Priority 3 must select and prove trusted-proxy-aware aggregate
ingress limiting, traffic admission from readiness, and a database connection
budget before public production exposure.

## R8 — Browser-exposed access token has a revocation window

**Current design:** The Realtime-token endpoint returns a general Supabase access token to browser JavaScript; FastAPI validates signed JWT state but not session revocation.

**Problem:** Same-origin script compromise can exfiltrate a token usable until expiry.

**Consequence:** Temporary API access after browser logout.

**Affected:** Realtime token route/provider, FastAPI JWT validation, session policy.

**Recommended direction:** Use a narrower server-mediated Realtime credential/channel or define a shorter/revocable token policy and test revocation expectations.

## R9 — Auth/local user operations can diverge across the crash/provider/session boundary

**Current design:** User invite/resend/accept/disable/enable/restore/reconcile spans Supabase Auth and short local SQL phases with durable correlated `SecurityEvent` attempt/outcome rows (`operation_id`), no destructive compensation after Auth success (pending trigger profile is left for acceptance/retry), local-first disable/delete with `tokens_valid_after` cutoff, fail-closed activation/restore with post-Auth revalidation, and explicit `POST /users/{user_id}/reconcile-auth` realignment. Invitation preflight/finalization and acceptance capture immutable actor/target/email/role primitives before provider I/O and start a fresh request transaction for revalidation; the implementation is split across `backend/app/systems/users/service.py`, `backend/app/systems/users/acceptance.py`, `backend/app/systems/users/account_operations.py`, `backend/app/systems/users/coordination.py`, and `backend/app/systems/users/reconciliation.py`, with `backend/app/common/dependencies/auth.py:get_verified_pending_identity`. Acceptance depends on private FastAPI via `/session/password`; the BFF denies `auth/invitations/accept`, and bootstrap concurrent-loser/external residuals remain pending without destructive compensation.

Invitation provenance is classified centrally: `pending` is always ineligible; a non-pending profile with a sent invitation and no acceptance is unaccepted; an accepted non-pending profile is established; and a non-pending profile with neither timestamp remains a legacy account. Deleted unaccepted invitations remain deleted and their email identities remain reserved; recovery or reuse requires a separately approved procedure. Pending-to-disabled returns `409`, pending deletion preserves pending status, and known corrupted active profiles are denied authentication and excluded from active-administrator counts. No acceptance timestamp is guessed or backfilled.

**Problem:** One system can still succeed while the other fails: Auth success plus a crash before finalization leaves a pending profile, provider errors leave Auth/local out of sync, and refresh-session revocation remains unverified/absent (only the access-token cutoff plus local status gate apply).

**Consequence:** Orphaned or temporarily inconsistent identities requiring retry/reconciliation via the explicit endpoint and correlated event ledger.

**Affected:** Users service/router, invitation accept/resend, Supabase admin integration, token cutoff, operations.

**Recommended direction:** Keep short DB phases, correlated events, fail-closed ordering, and explicit reconcile; add observable failure-state runbook coverage and integration tests for each partial-failure order, including crash-after-provider-success and session-residual expectations.

An unverified concern remains around whether the provider resend contract exactly matches local `resend_invitation` assumptions. This is not a confirmed defect; verify it through the API/provider test phase before changing the integration. No provider resend redesign is included in the current scope.

## R10 — Frontend contract and invalidation are coarse

**Status:** Deferred from the current backend/docs work. Any frontend pagination or stale-response remediation requires separate human approval before changes under `frontend/`.

**Current design:** `apiFetch<T>` trusts unchecked casts; lists often request 100 rows and ignore `has_more`; every invalidation remounts/refetches the page.

**Problem:** Contract drift can fail at runtime, larger datasets disappear from UI, and unrelated mutations trigger expensive refetches.

**Consequence:** Incorrect UI state, scalability limits, and unnecessary load.

**Affected:** Frontend API client/pages, Realtime provider, backend list API.

**Recommended direction:** Generate or runtime-validate contracts, implement pagination, and scope/cache invalidation. The identified ignored-pagination and stale-request findings remain deferred pending that approval.

## R11 — Setup guidance (resolved)

**Current design:** `/setup` points to the supported Supabase, Alembic,
runtime-role provisioning, and administrator bootstrap commands, while the root
README remains the canonical environment and operations guide. The bootstrap
command requires both email and username.

Keep the page concise and aligned with the README and scripts.

## R12 — Hosted-control gaps remain without frontend full-stack automation

**Current design:** Frontend CI uses static checks, isolated product/security
tests, three HTTP boundary tests, and one production build. It does not run a
browser or a frontend full-stack journey. Backend behavior, database integration,
coverage, scanner behavior, and container checks remain owned by backend and
infrastructure suites.

**Problem:** CI does not verify browser rendering, hydration, responsive layout,
cross-browser behavior, or a complete Next.js → BFF → FastAPI → PostgreSQL user
journey. Hosted ingress, network, secret, backup, recovery, aggregate rate
limiting, log collection, and alert delivery also remain operational checks.

**Consequence:** CI may pass individual layers while selected integrated, hosted, or operational workflows still regress.

**Affected:** Test suites, CI, auth, BFF, lifecycle, Realtime, and hosted operations.

**Recommended direction:** Require the stable full-stack check through branch
protection after landing. Priority 3 must prove hosted controls and alert
delivery before production traffic; retain targeted unit, integration, and
disposable release coverage for application behavior.

## R13 — Placeholder capabilities can be mistaken for working features

**Current design:** Files, reports, views, businesses, and admin packages exist without runtime wiring; Storage has only a bucket foundation.

**Problem:** Folder names and stale docstrings imply behavior that does not exist.

**Consequence:** Incorrect dependency/design assumptions and unsafe file-feature activation.

**Affected:** Backend package tree, docs, Storage.

**Recommended direction:** Mark placeholders explicitly or remove stale scaffolding until requirements and security design exist.

## R14 — Browser-side SecurityEvent producers are incomplete

**Current design:** Backend administrative operations persist durable correlated
`SecurityEvent` attempt/outcome rows. The BFF and session routes emit safe
structured logs with request correlation, but the Priority 4 Next.js
SecurityEvent producers are not implemented.

**Problem:** Browser/session operations do not yet have the same durable event
coverage as backend administrative operations. The read-only operational checker
therefore reports only the backend event families it knows.

**Consequence:** Cross-system incident visibility and reconciliation context are
incomplete even when request logs identify a failure.

**Affected:** Next.js BFF/session routes, SecurityEvent ingestion, operational
checker, and alerting.

**Recommended direction:** Priority 4 should add the scoped Next.js producers
and their ingestion failure signals. Priority 3 must collect, retain, and alert
on the resulting operational events before production exposure.
