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

**Problem:** Same-origin script compromise can exfiltrate a token usable until expiry.

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

## R11 — Setup guidance (resolved)

**Current design:** `/setup` points to the supported Supabase, Alembic,
runtime-role provisioning, and administrator bootstrap commands, while the root
README remains the canonical environment and operations guide. The bootstrap
command requires both email and username.

Keep the page concise and aligned with the README and scripts.

## R12 — Verification gaps hide cross-system failures

**Current design:** Default frontend domain Playwright tests mock sessions/BFF/backend, while an opt-in local live suite exercises real Auth, BFF, FastAPI, and PostgreSQL outside CI. Backend PostgreSQL integration now covers dynamic-field persistence, selected field/relationship races, and runtime-role trust boundaries when the guarded database environment is available.

**Problem:** The live suite is not a CI gate and does not verify Realtime delivery or hosted ingress, network, secret, backup, and recovery controls. Concurrent last-administrator mutations and broader multi-worker/load scenarios also remain uncovered.

**Consequence:** CI may pass individual layers while selected integrated, hosted, or operational workflows still regress.

**Affected:** Test suites, CI, auth, BFF, lifecycle, Realtime, and hosted operations.

**Recommended direction:** Preserve the unit/integration and opt-in live layers; add a controlled CI or staging live smoke gate where operationally feasible, plus Realtime-delivery, remaining concurrency, and hosted-control verification.

## R13 — Placeholder capabilities can be mistaken for working features

**Current design:** Files, reports, views, businesses, and admin packages exist without runtime wiring; Storage has only a bucket foundation.

**Problem:** Folder names and stale docstrings imply behavior that does not exist.

**Consequence:** Incorrect dependency/design assumptions and unsafe file-feature activation.

**Affected:** Backend package tree, docs, Storage.

**Recommended direction:** Mark placeholders explicitly or remove stale scaffolding until requirements and security design exist.
