# Architecture Risks

> **Scope:** Current architectural weaknesses, consequences, affected components, and recommended directions.
> **Audience:** Maintainers prioritizing reliability, security, consistency, and delivery work.
> **Related documents:** [Security architecture](14-security-architecture.md), [Testing architecture](16-testing-architecture.md), [Deployment](12-deployment-architecture.md), [Architecture decisions](19-architecture-decisions.md)

This document is intentionally editorial. Descriptive documents state current behavior and link here rather than embedding recommendations.

## R1 — Tenancy intent is undefined

**Current design:** Users and all domain/audit rows have no tenant key; authorization is a global `admin` role; RLS has no tenant predicate.

**Problem:** If mutually untrusted businesses share one deployment, an administrator can access all application data through normal APIs.

**Consequence:** Complete cross-tenant confidentiality/integrity failure.

**Affected:** Users, all domain routers/models, audit, relationships, lifecycle, RLS.

**Recommended direction:** Explicitly declare one trust domain per deployment, or add end-to-end tenant identifiers, constraints, authorization context, RLS, and cross-tenant tests.

## R2 — Frontend process receives backend-only local secrets

**Current design:** Root setup exports the complete `.env` before frontend dependency installation/start. That environment includes owner/runtime database and Supabase server credentials.

**Problem:** npm lifecycle code or a compromised Next server can read credentials it does not need.

**Consequence:** Direct database/Auth compromise and unaudited mutation if that process is compromised.

**Affected:** Root README, frontend process, database and Supabase credentials.

**Recommended direction:** Install dependencies before runtime configuration and pass an explicit frontend allowlist: backend URL plus public Supabase values only. Keep migration credentials short-lived and isolated.

## R3 — Runtime DB access bypasses application authorization and audit

**Current design:** `openslate_app` receives broad CRUD with true-predicate RLS; `openslate_runtime` inherits it. Application audit is ORM-only.

**Problem:** A leaked/reachable DB credential can bypass JWT checks, application invariants, and listener-based audit, and can insert misleading audit rows.

**Consequence:** Broad data compromise and unreliable audit history.

**Affected:** Migration `0010`, role provisioning, all application tables, audit.

**Recommended direction:** Keep database private/TLS-protected, rotate and scope credentials, harden role verification, and consider restrictive tenant/procedure boundaries where the threat model requires them.

## R4 — Hosted deployment security and recovery are unspecified

**Current design:** Images exist but ingress, TLS/HSTS, trusted proxy/Host handling, network policy, secret delivery, backup/PITR, restore, and monitoring do not.

**Problem:** Operators can publish a topology that exposes tokens, passwords, server keys, DB, Studio, or backend ports and has no tested recovery.

**Consequence:** Account/data compromise, late detection, and unrecoverable failure.

**Affected:** Deployment, infrastructure, configuration, observability.

**Recommended direction:** Define a supported hosted topology and security/recovery runbook before claiming production support.

## R5 — Audit redaction misses dynamic field sensitivity

**Current design:** Redaction matches serialized key names; record JSON keys are field UUIDs. Audit history survives entity purge.

**Problem:** Sensitive business-field values can remain in audit JSON and backups.

**Consequence:** Extended retention and failed erasure expectations.

**Affected:** Records, audit snapshots, lifecycle purge, retention policy.

**Recommended direction:** Add field sensitivity classification and record-aware redaction; define retention and historical remediation.

## R6 — Last-administrator invariant is raceable

**Current design:** User update/delete counts active admins without serializing count plus mutation.

**Problem:** Concurrent operations can both observe more than one admin and remove the final two.

**Consequence:** Administrative lockout requiring privileged recovery.

**Affected:** `users/router.py`, admin operations, integration tests.

**Recommended direction:** Lock a stable admin/role boundary or use serializable transactions with retry; add multi-connection regression tests.

## R7 — Request size and general rate controls are absent

**Current design:** The BFF buffers entire request/response bodies; dynamic JSON and search have incomplete size bounds; no general application rate limiter exists.

**Problem:** Oversized or repeated requests can consume memory, connections, DB capacity, and audit storage.

**Consequence:** Service degradation or denial of service.

**Affected:** Next BFF/session routes, FastAPI, records/roles/fields, ingress.

**Recommended direction:** Enforce early byte/depth/cardinality limits, timeouts, streaming where possible, and trusted-proxy-aware rate controls.

## R8 — Browser-exposed access token has a revocation window

**Current design:** The Realtime-token endpoint returns a general Supabase access token to browser JavaScript; FastAPI validates signed JWT state but not session revocation.

**Problem:** Same-origin script compromise can exfiltrate a token usable until expiry, including through the direct API rewrite.

**Consequence:** Temporary API access after browser logout.

**Affected:** Realtime token route/provider, FastAPI JWT validation, session policy.

**Recommended direction:** Use a narrower server-mediated Realtime credential/channel or define a shorter/revocable token policy and test revocation expectations.

## R9 — Auth/local user operations can diverge

**Current design:** User invite/disable/enable/restore spans Supabase Auth and a local SQL transaction with best-effort compensation/fail-closed ordering.

**Problem:** One system can succeed while the other fails.

**Consequence:** Orphaned or temporarily inconsistent identities requiring retry/reconciliation.

**Affected:** Users service/router, Supabase admin integration, operations.

**Recommended direction:** Add explicit reconciliation tooling, observable failure state, and integration tests for each partial-failure order.

## R10 — Frontend contract and invalidation are coarse

**Current design:** `apiFetch<T>` trusts unchecked casts; lists often request 100 rows and ignore `has_more`; every invalidation remounts/refetches the page.

**Problem:** Contract drift can fail at runtime, larger datasets disappear from UI, and unrelated mutations trigger expensive refetches.

**Consequence:** Incorrect UI state, scalability limits, and unnecessary load.

**Affected:** Frontend API client/pages, Realtime provider, backend list API.

**Recommended direction:** Generate or runtime-validate contracts, implement pagination, and scope/cache invalidation.

## R11 — Setup UI conflicts with the supported path

**Current design:** `/setup` describes Docker Compose and legacy bootstrap values, while the repository supports Supabase CLI and requires both bootstrap email and username.

**Problem:** New operators can follow a nonexistent or incomplete procedure.

**Consequence:** Failed onboarding and insecure ad hoc workarounds.

**Affected:** Frontend setup page, root README, scripts.

**Recommended direction:** Make one canonical setup source and test/document links and commands against scripts.

## R12 — Verification gaps hide cross-system failures

**Current design:** Frontend domain Playwright tests mock sessions/BFF/backend; backend integration tests depend on PostgreSQL environment; the sampled local pytest run failed its coverage threshold.

**Problem:** Cookie refresh, real JWT/local-role authorization, Realtime, concurrency, and hosted controls can regress across boundaries.

**Consequence:** CI may pass individual layers while the integrated workflow fails.

**Affected:** Test suites, CI, auth, BFF, lifecycle, Realtime.

**Recommended direction:** Preserve unit/integration layers and add a small live full-stack acceptance suite plus targeted concurrency/security tests.

## R13 — Placeholder capabilities can be mistaken for working features

**Current design:** Files, reports, views, businesses, and admin packages exist without runtime wiring; Storage has only a bucket foundation.

**Problem:** Folder names and stale docstrings imply behavior that does not exist.

**Consequence:** Incorrect dependency/design assumptions and unsafe file-feature activation.

**Affected:** Backend package tree, docs, Storage.

**Recommended direction:** Mark placeholders explicitly or remove stale scaffolding until requirements and security design exist.
