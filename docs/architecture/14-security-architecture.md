# Security Architecture

> **Scope:** Implemented security controls, trust boundaries, and controls that are partial, absent, or deployment-dependent.
> **Audience:** Developers, security reviewers, and operators evaluating present-day protection.
> **Related documents:** [Authentication and authorization](08-authentication-authorization.md), [Data architecture](06-data-architecture.md), [Infrastructure](11-infrastructure.md), [Architecture risks](20-architecture-risks.md)

## Security posture summary

The checked-in local system has strong application-level identity verification, an explicit FastAPI data boundary, capability/admin authorization, same-origin mutation checks, private Realtime invalidation, constrained runtime database role attributes, and transactional audit capture. It is not evidence of production readiness: hosted network exposure, TLS, secret delivery, backup, monitoring, and ingress controls are **Unknown**. Each deployment is one trust domain with isolated Auth, PostgreSQL, Storage, secrets, backups, and administrator population; shared tenancy is deferred and tenant/RLS isolation is not implemented.

No unconditional critical vulnerability is established from repository evidence alone. Direct SQL access is an operational trust boundary, not a vulnerability through normal HTTP; sharing a deployment between mutually untrusted businesses or publicly exposing the database would materially change that conclusion.

## Trust boundaries

```mermaid
flowchart LR
    Browser[Untrusted browser] --> Next[Next.js session + BFF]
    Next --> API[FastAPI JWT + capability/admin boundary]
    API --> RuntimeDB[PostgreSQL runtime role]
    API --> Supabase[Supabase Admin/Auth/Realtime]
    Owner[Migration/operator principal] --> RuntimeDB
```

- Browser input and tokens are untrusted at the Next.js boundary.
- FastAPI independently validates identity and local authorization; the frontend gate is not authoritative.
- Runtime database credentials permit broad application-table operations and must remain private.
- Migration/database owners and the Supabase server secret are higher-trust principals outside application audit guarantees.

## Implemented controls

### Authentication and session protection

- `verify_supabase_jwt` restricts algorithms and verifies JWKS signature, issuer, audience, expiry, and UUID subject.
- `get_current_user` reloads the local profile and role on every protected API request and rejects missing, deleted, disabled, pending, or role-less users; it additionally rejects access tokens with `iat` earlier than `User.tokens_valid_after`. Disable/delete advance that cutoff local-first. Supabase refresh-session revocation is not verified by the backend and remains absent/unverified.
- Access/refresh cookies are HttpOnly, host-only, SameSite=Lax, and Secure in production.
- Session and BFF mutations use `isSameOriginRequest`; the BFF forwards an allowlist of headers and never forwards the refresh token.
- Global public signup and anonymous sign-in are disabled; local password minimum and complexity are configured in `supabase/config.toml`.

Sources: `backend/app/core/security/supabase.py`, `backend/app/common/dependencies/auth.py`, `frontend/src/lib/auth-cookies.ts`, `frontend/src/lib/request-security.ts`, `frontend/src/app/bff/[...path]/route.ts`.

### Authorization

Domain routers for departments, modules, fields, records, and relationships enforce matching flat `.read` and `.write` capabilities. The exact `admin` role is implicitly granted all ten capabilities. Each capability is independent; a read grant does not imply write and a write grant does not imply read. Users, roles, invitations, audit, security-event read/export, and purge remain literal-admin-only. `/api/auth/me` is AuthN-only and returns the role plus sorted effective permissions. This is global authorization within one trust domain, not resource ownership or tenant authorization. FastAPI is authoritative; direct database access bypasses RBAC.

### Browser and request controls

- React's normal escaped rendering is used; no unsafe HTML sink was identified in the reviewed source.
- `frontend/src/proxy.ts` generates a nonce-based CSP and limits connection origins.
- `frontend/next.config.ts` sets frame denial, MIME sniffing protection, referrer policy, and permissions policy.
- Pydantic schemas, UUID parsing, sort allowlists, field validation, and SQLAlchemy expressions constrain inputs; no confirmed SQL, command, path-traversal, open-redirect, or SSRF injection path was found.

### Database privilege boundary

Migration `0010` begins the application-role/RLS/grant boundary, with later revisions extending it. `supabase/config.toml` excludes the application schema from the local Data API. Provisioning creates `openslate_runtime` without superuser, create-db, create-role, replication, or bypass-RLS attributes and fails closed on unsafe role attributes, membership options, or unexpected inherited roles; it does not silently revoke drift.

This is not row-level tenant isolation: runtime policies use true predicates and the role has broad application CRUD. RLS does not evaluate application RBAC. FastAPI is the effective authorization and audit boundary.

The confirmed boundary is that a provisioned `openslate_runtime` connection can issue direct SQL within its granted tables. PostgreSQL structural constraints still apply, but direct SQL bypasses FastAPI dynamic validation and `AuditSession` audit capture. The Data API exclusion and browser-facing role revocations remain protected, so runtime and owner database credentials and network access to PostgreSQL must stay private. This does not imply a vulnerability through normal HTTP: browser requests still traverse FastAPI. See the [dynamic field validation test plan](../dynamic-field-validation-test-plan.md) for the application-owned validation boundary.

### Audit and lifecycle controls

- Normal `AuditSession` mutations create same-transaction minimal before/after logs. `GET /audit-logs/export` returns a bounded JSON array of at most 100 rows.
- ORM attempts to mutate audit logs or run bulk/raw mutation statements are rejected.
- `SecurityEvent` is a separate append-only ledger; ordinary ORM insert/update/delete attempts are rejected, actor/subject IDs are immutable UUID snapshots without user FKs, exact-admin list/detail/export (at most 100 events) plus `SECURITY_EVENT_SERVER_KEY` internal ingestion apply, and request-facing flows use independent-session durable commits. Direct database access remains outside the append-only boundary.
- Lifecycle confirmation stores a token hash, binds actor/operation/target/digest, expires after five minutes, rate-limits failures, and performs password verification outside long-held DB transactions.
- Audit immutability is application-scoped, not cryptographic or owner-proof.

### Realtime, Storage, containers, and CI

- Realtime uses a private Broadcast topic with opaque invalidation payloads and no application-table publication.
- File objects are private and FastAPI mediates metadata and object transfer. Purpose-specific authorization distinguishes record attachments from literal-admin library/logo operations; the generic file API does not expose historical workspace logos. A serial worker verifies stored digest/size before streaming through `clamdpy` to a private ClamAV engine. Publication rechecks the claim, requester authority and parent/file state. Uncertain execution blocks admission across restart until an operator confirms engine replacement; absent/stale/mismatched definitions fail closed. The engine has no database or Storage credentials and uses read-only definitions. Infrastructure artifacts do not establish production provisioning or operational readiness.
- Backend and frontend images run as non-root users; `.env` is excluded from Docker build context.
- CI uses read-only repository permissions and disposable local Supabase services.

## Partial or absent controls

| Control                                     | State                       | Evidence-based qualification                                                                                                                                  |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation                            | **Absent**                  | No tenant key or tenant predicate exists. The supported model is one trust domain per deployment; shared tenancy requires an architecture change.             |
| Fine-grained permissions                    | **Implemented**             | Exactly ten flat read/write capabilities are enforced by FastAPI; omitted or malformed non-admin permissions default to deny, with no capability implication. |
| Token revocation introspection              | **Absent**                  | Signed JWTs remain acceptable until expiry unless the local status gate or `tokens_valid_after` cutoff blocks them. Refresh-session revocation is unverified/absent. |
| Request body limits/general API rate limits | **Absent in repository**    | BFF buffers full bodies; only Supabase Auth and lifecycle password controls have scoped limits.                                                               |
| Hosted TLS/HSTS/network policy              | **Unknown**                 | Images serve HTTP and no ingress is checked in.                                                                                                               |
| Per-service hosted secret delivery/rotation | **Unknown**                 | Only process environment consumption is defined.                                                                                                              |
| File security controls                      | **Implemented / fail closed** | Private addressing, purpose checks, bounded validation, durable scan claims, immutable-definition checks, serialized quarantine admission, archive/reconciliation and no-store downloads exist. The private engine and worker need operator provisioning, daily definition maintenance and explicit uncertain-execution recovery. |
| Dependency/SBOM/image scanning              | **Absent**                  | Lockfiles exist; CI does not run dedicated supply-chain security checks.                                                                                      |
| Monitoring/alerting/forensic sink           | **Absent / Unknown hosted** | No metrics, tracing, alerts, DB audit, or external immutable audit sink.                                                                                      |
| Backup/PITR/restore testing                 | **Absent / Unknown hosted** | No policy or runbook is checked in.                                                                                                                           |

## Sensitive-data handling

Configuration models wrap server keys in `SecretStr`, `.env` is ignored, examples contain placeholders, and browser code reads only public Supabase variables. The supported local frontend path uses `frontend/.env.local` based on `frontend/.env.example`, containing only `BACKEND_URL`, public Supabase values, and the optional purge flag. The root `.env` is not sourced into npm or Next.js, and `npm ci` runs without backend secrets.

Audit redaction matches sensitive serialized key names. Dynamic record values are nested under field UUID keys, so name-based markers do not match them; only the explicit `Field.audit_redacted` flag redacts those UUID-keyed values, and only in newly created Record audit snapshots (including renamed and soft-deleted fields, via `listeners._record_redacted_fields`). Flagged values do not change `Record.data`. Previously stored clear snapshots, copies in backups, and values that survive record/field purge remain: historical remediation was not performed and requires separate approval. Product decision: users with `fields.write` are trusted field data-classification owners allowed to toggle `audit_redacted` (`POST /fields` and `PATCH /fields/{field_id}` require `fields.write`); the flag affects only future snapshots. Retention policy and historical remediation remain undefined.

## Deployment-dependent security gates

Before treating a hosted system as secure, repository evidence leaves these
hosted requirements to be implemented or verified:

1. enforcing one trust domain per deployment and deferring shared tenancy;
2. isolating Auth, PostgreSQL, Storage, secrets, backups, and administrator population for each deployment;
3. applying the contract's public/private exposure: Next.js is browser-facing, FastAPI is private, and only the required Supabase Auth, JWKS, and Realtime surfaces are controlled public surfaces;
4. TLS/HSTS, internal encryption, trusted proxy/Host configuration, and production CORS/redirects;
5. per-service secrets, rotation, revocation, and short-lived migration credentials;
6. body, timeout, connection, WAF, rate limits, hosted Realtime publication, and Storage object policies;
7. backup, restore, RPO/RTO, retention, disaster recovery, monitoring, and forensic retention.

These are **Unknown**, not implemented controls. Detailed consequences and recommended directions are kept in [Architecture risks](20-architecture-risks.md).
