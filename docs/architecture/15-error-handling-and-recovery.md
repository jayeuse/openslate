# Error Handling and Recovery

> **Scope:** Error origins, HTTP mappings, rollback, BFF refresh, external failures, and per-request recovery paths.
> **Audience:** API consumers, backend/frontend engineers, operators, and reviewers tracing failed requests.
> **Related documents:** [Backend architecture](04-backend-architecture.md), [API architecture](07-api-architecture.md), [Authentication and authorization](08-authentication-authorization.md), [Audit and history](10-audit-and-history.md)

## Status summary

| Area                                             | Status                       | Evidence-based state                                                                                                                                 |
| ------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local route/service status mapping               | **Implemented**              | Routers and domain services translate known validation, authorization, conflict, external-service, and lifecycle failures to explicit HTTP statuses. |
| Process-boundary exception handling              | **Implemented**              | Request middleware returns generic `500` responses for unexpected application exceptions and generic `503` responses for database operational/pool failures, with a backend-generated diagnostic ID. |
| Transaction rollback for known mutation failures | **Implemented**              | Commit helpers and locking/lifecycle services explicitly roll back selected database failures before raising.                                        |
| Generic backend retry                            | **Absent**                   | No backend-wide retry wrapper is present; selected external clients are explicitly non-retrying.                                                     |
| BFF session refresh                              | **Implemented**              | The Next BFF retries one backend `401` after a refresh-token exchange, then clears cookies on failure.                                               |
| Request correlation and safe operational logs    | **Implemented**              | FastAPI and the BFF generate independent IDs, return the final backend ID when available, and emit allowlisted structured records without request bodies, cookies, credentials, or raw query values. |
| Application resource bounds                      | **Implemented**              | FastAPI and the BFF enforce bounded JSON/request buffering, BFF deadlines, database pool/query timeouts, and a bounded readiness probe. Hosted aggregate limits remain a Priority 3 gate. |

## Common error envelope and origin

FastAPI validation and most application errors use the default `{ "detail": ... }` body. Route-local contracts remain unchanged. The request middleware in `backend/app/main.py:create_app` supplies a generic `500` for unexpected application exceptions and `503` for database operational/pool failures; each application response receives a backend-generated `X-Request-ID`. Server rejection before application middleware remains outside that guarantee.

| Origin                                         | Status/body behavior                                                                                                                                                                 | Transaction state and recovery behavior                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path, query, or body Pydantic validation       | `422 Unprocessable Entity` with FastAPI validation detail. Explicit validators also produce `422` when their model validation fails.                                                 | Handler mutation code has not run; no application rollback is invoked for pure request validation. Correct the request shape/value and resubmit.                                                                    |
| Missing/malformed access credentials           | Rejected by `HTTPBearer(auto_error=True)` before `get_current_user`; framework-generated response, not a custom application envelope.                                                | No domain mutation has run. The caller must provide a valid access token.                                                                                                                                           |
| Invalid JWT or missing/inactive local identity | `401` with `Invalid authentication credentials` and `WWW-Authenticate: Bearer` from `get_current_user`.                                                                              | No domain mutation has run. The BFF attempts one refresh for a backend `401`; failed refresh clears cookies and returns `401`.                                                                                      |
| Role mismatch                                  | `403` with `Forbidden` from `require_roles`.                                                                                                                                         | No mutation has run. The BFF does not refresh a `403`; the local role must satisfy the route guard.                                                                                                                 |
| Resource lookup                                | `404` with a resource-specific string such as `Department not found`, `Record not found`, or `Audit log not found`.                                                                  | No mutation is committed. Re-resolve the resource ID before a new request.                                                                                                                                          |
| Domain conflict/precondition                   | Usually `409` with a string detail; examples include active-name conflicts, deleted/open state conflicts, accepted-schema requirements, cardinality conflicts, and `close_required`. | Domain commit helpers roll back when the conflict came from `IntegrityError`; pre-handler business checks have no commit. The caller must resolve the reported state conflict.                                      |
| Record data validation                         | Structured `record_validation_failed` detail; ordinary validation is `422`, while changed/new closed-field values are `409`.                                                         | Validation runs before commit. The response contains deterministic errors capped at 20 plus `truncated`; the caller must correct the submitted data or leave closed values unchanged.                            |
| Request body or buffered BFF payload too large | `413` with a safe size detail.                                                                                                                                                  | Declared sizes are rejected early and streamed bytes are authoritative. No body content is returned or logged.                                                                                                            |
| BFF upstream timeout/oversized response        | `504` for the total BFF deadline or `502` for an oversized backend response, each with a diagnostic ID.                                                                          | A mutation may already have committed when the response outcome is unknown; inspect current state or reconcile before resubmitting.                                                                                        |
| Relationship input/availability                | `422` for `RelationshipInvalid`; `404` for `RelationshipNotFound`; `409` for `RelationshipConflict`; `503` for `RelationshipUnavailable`.                                            | `lock_row`, relationship list locking, and relationship commit paths roll back selected operational failures. There is no relationship retry in the backend.                                                        |
| Supabase invitation adapter                    | `409` for Auth status `409/422` conflicts; `502` for handled `InvitationError` failures. Client-construction/configuration errors can escape local normalization.                    | Invitation/resend/accept record durable correlated attempt/failure/partial `SecurityEvent` outcomes (`operation_id`); local finalization failure rolls back, emits `partial`, and leaves the trigger profile pending without deleting the external Auth identity. Retry uses resend/accept and drift uses `POST /users/{user_id}/reconcile-auth`. |
| Supabase user enable/disable adapter           | `503` with a generic enable/disable detail when `SupabaseAdminClient` fails.                                                                                                         | Disable/delete are local-first: they commit the local disabled/deleted state and token cutoff before the remote call, and remote provider errors after that commit are recorded as correlated `partial` outcomes. Enable/restore are fail-closed: they call the remote enable first, then revalidate and commit; local finalization failure after remote success is `partial`. Explicit recovery is `POST /users/{user_id}/reconcile-auth`. |
| Lifecycle                                      | Lifecycle-router endpoints use structured `detail` with `code`, `message`, and optional `blockers`; compatibility restore routes map lifecycle failures to plain string detail.      | Challenge state and password lease transactions are committed separately from the final lifecycle mutation. Final plan execution rolls back on drift, blockers, integrity, operational, or lifecycle failures.      |
| Audit listener/insertion                       | Known `IntegrityError` can be handled by the caller’s commit helper; immutability/bulk guards raise `RuntimeError` and are not globally normalized.                                  | Audit rows are in the same transaction as the domain mutation; a failed transaction does not commit its audit row.                                                                                                  |
| Post-commit Realtime invalidation              | No API error is returned for `SupabaseAdminError` from the after-commit broadcast listener.                                                                                          | The database/audit commit is already complete; the invalidation failure is logged as a safe operational signal and is not retried by the backend.                                                                       |
| Database operational/pool failure              | `503` with a generic database-unavailable detail and a diagnostic ID.                                                                                                               | The middleware records a safe failure signal. The caller may retry a read; a failed mutation requires current-state inspection before resubmission.                                                                        |
| Unhandled application exception                | `500` with a generic detail and a diagnostic ID.                                                                                                                                 | The middleware logs an allowlisted failure record. No backend-wide replay is performed.                                                                                                                                |

## Lifecycle status and code map

`backend/app/systems/lifecycle/router.py:_error_response` converts `LifecycleError` into the structured detail object for lifecycle-router endpoints. Compatibility restore routes use plain string details. The exception classes in `backend/app/systems/lifecycle/exceptions.py` provide the following implemented mapping:

| Origin/class or code                                                                                                                                                                                                           | Status | Response code/detail behavior                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LifecycleNotFound`, `LifecycleChallengeNotFound`                                                                                                                                                                              | `404`  | `not_found` or `challenge_not_found`.                                                                                                                                             |
| `LifecycleInvalidTarget`, `LifecycleUnsupportedOperation`                                                                                                                                                                      | `422`  | `invalid_target` or `unsupported_operation`.                                                                                                                                      |
| Confirmation name mismatch; `confirmed` not true                                                                                                                                                                               | `422`  | `confirmation_name_mismatch` or `confirmation_required`. The latter is raised directly by `_reopen`.                                                                              |
| `LifecycleAlreadyClosed`, `LifecycleAlreadyOpen`, `LifecycleClosedAncestorError`, `LifecycleRecordCloseError`, `LifecyclePlanDriftError`, `LifecyclePreflightError`, challenge state errors, `LifecyclePurgePreconditionError` | `409`  | State/ancestor/unsupported-record-close, impact drift, preflight, challenge expiry/exhaustion/in-progress, or purge-precondition codes. Preflight errors include blocker objects. |
| `LifecyclePurgeDisabled`                                                                                                                                                                                                       | `403`  | `purge_disabled`; purge preview and execution first require the setting to be enabled.                                                                                            |
| `LifecycleChallengeBindingMismatch`, `LifecycleActorMismatch`, `LifecyclePasswordError`, `LifecycleInvalidCredentials`                                                                                                         | `403`  | Binding/actor/password failure codes; an invalid password is not treated as an expired backend session.                                                                           |
| `LifecycleActorBlocked`, `LifecyclePasswordRateLimited`                                                                                                                                                                        | `429`  | `actor_blocked` or `password_upstream_rate_limited`. Actor failed-attempt state is persisted for its rolling window.                                                              |
| `LifecycleUnavailable`, `LifecyclePasswordServiceUnavailable`                                                                                                                                                                  | `503`  | `temporarily_unavailable` or `password_upstream_unavailable`.                                                                                                                     |

The base `LifecycleError` status is `409`, so subclasses without an override retain conflict status. `SupabasePasswordGrantClient` maps Supabase password-grant HTTP `400/401/403` to invalid credentials, `429` to upstream rate limiting, and other non-2xx results to service unavailable.

## Rollback and commit behavior

The backend does not use an implicit request-wide commit. `get_db` yields an `AuditSession`, and route/service code explicitly commits successful writes.

### Dynamic record validation

Record create and update errors use `detail.code = "record_validation_failed"`, a message, an `errors` array of `{code, field_id, message}`, and `truncated`. Submitted keys are processed in deterministic order and four phases: closed-field values, known active values, malformed/unknown keys, and missing required active fields. At most 20 issues are returned; `truncated` is true when additional issues were found. A changed or newly supplied closed-field value makes the response `409`; all other record validation failures are `422`. Record creation requires an accepted schema with at least one active field; updates remain allowed after field lifecycle invalidation so closed values can be retained.

The [dynamic-field validation test plan](../dynamic-field-validation-test-plan.md) contains the detailed contract evidence without duplicating its full matrix here.

### Standard domain commits

Departments, modules, fields, records, users, and roles use local `_commit` helpers that catch `IntegrityError`, call `db.rollback()`, and raise a `409`-mapped conflict. This covers uniqueness and other integrity failures encountered during the explicit commit. Relationship `_commit` also catches `OperationalError`, rolls back, and raises `RelationshipUnavailable` (`503`).

### Lock and lifecycle failures

`relationships.service:lock_row`, `lock_modules`, `_lock_relationship_rows`, and `_locked_edge` catch selected `OperationalError` values, roll back, and raise temporary unavailability. `lifecycle.service:_lock_collection` and `_execute` do likewise for scope locking and final execution.

Lifecycle execution recomputes the displayed plan after locking. Digest drift and blockers call `db.rollback()` before returning a structured error. An `IntegrityError` in `_execute` rolls back and becomes `LifecyclePreflightError`; an `OperationalError` rolls back and becomes `LifecycleUnavailable`.

Challenge issuance, verification-lease reservation, failure recording, and success consumption have their own commits in `lifecycle.service`. The password network call is made after the verification lease is committed, so the database transaction is not held open across that call. Invalid credentials record a failure; other password-client exceptions release the verification lease before propagating.

## Retry and recovery behavior

### Session refresh retry

`frontend/src/app/bff/[...path]/route.ts:handle` performs the only general request replay visible in the request path:

1. Forward the original method, URL query, selected headers, and buffered body with the current access token.
2. If the backend returns `401`, read the refresh cookie and call Supabase `refreshSession`.
3. If refresh succeeds, forward the same request body once with the new access token.
4. If refresh fails or the retry still returns `401`, clear both cookies and return the response; `frontend/src/lib/api.ts:apiFetch` navigates the browser to `/login` for a `401`.

A successful refresh is retained in cookies even if the subsequent backend response exceeds the buffer limit or a transport/deadline failure occurs. A final backend `401` clears cookies even if its error body cannot be read. Neither path adds another mutation replay.

There is no second refresh attempt and no replay for `403`, `409`, `422`, `502`, or `503`.

### External and lock operations

`SupabaseAdminClient._request` and `SupabasePasswordGrantClient` use explicit bounded HTTP stage timeouts and do not retry. Relationship/lifecycle row locks use `NOWAIT` and return `503` when an operational lock failure is caught; no server-side wait/retry loop is present. Runtime SQL connections have bounded pool, connection, and statement waits; readiness uses a separate single-connection probe and never creates replacement probes while one is in flight.

The post-commit Realtime broadcast is best effort: `broadcast_committed_changes` catches `SupabaseAdminError` and returns normally. There is no outbox, durable notification queue, or invalidation retry path in the reviewed code.

## Recovery by caller-visible condition

| Condition                                   | Current recovery path evidenced in code                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401`                                       | BFF refreshes once; on failure cookies are cleared and the frontend navigates to login. A direct backend client must obtain a new valid access token.                                          |
| `403`                                       | No refresh or replay. The caller must use an identity/role permitted by the route or, for lifecycle step-up, provide a valid bound password/actor context.                                     |
| `404`                                       | The referenced resource/challenge is not available to the route; a later request must resolve a current ID/token.                                                                              |
| `409`                                       | The response identifies a state, uniqueness, schema, cardinality, or lifecycle precondition conflict. The failed mutation is not committed; the next request must use the current valid state. |
| `422`                                       | Correct request shape, enum, UUID, model validation, confirmation, or relationship input; no mutation handler commit occurs for request validation failures.                                   |
| `429`                                       | Lifecycle actor/password verification is blocked or upstream rate-limited. The backend persists the relevant attempt window/block state and does not replay the request.                       |
| `502`                                       | Invitation delivery/finalization did not complete as a normal API operation; the invitation service records durable correlated attempt/failure/partial outcomes (`operation_id`) with no destructive compensation. The pending profile remains for resend/accept retry or explicit reconciliation. |
| `503`                                       | A known external, lock, or temporary database path failed. No backend retry or queue is created for the request.                                                                               |
| `504`                                       | The BFF deadline expired. The upstream operation may have completed; inspect state or use the explicit reconciliation path before retrying an unsafe request.                                   |
| Successful mutation but missed invalidation | Realtime is not the database of record; the API response and subsequent reads remain the available data path because post-commit broadcast failure is swallowed.                               |

## Operational diagnostics and remaining delivery gates

`backend/scripts/check_operational_health.py` is a read-only bounded checker for
unresolved or partial backend administrative `SecurityEvent` operations. It
uses database time and returns `0` for no issue, `1` for attention, and `2` for
an unavailable check; it performs no reconciliation. Structured logs and this
checker are application signals only. Priority 3 must provide collection,
retention, alert routing, ownership, and demonstrated delivery before hosted
production traffic.

The checker covers backend administrative event families. Priority 4's Next.js
session/BFF SecurityEvent producers remain absent, so browser-side operation
visibility is incomplete even though the BFF emits safe structured logs.

## Source grounding

- `backend/app/main.py:create_app` for request IDs, bounded request bodies, readiness, and process-boundary failure handling.
- `backend/app/common/dependencies/auth.py:get_current_user` and `require_roles`.
- `_commit` helpers in `backend/app/systems/departments/router.py`, `modules/router.py`, `fields/router.py`, `records/router.py`, and `users/router.py`.
- `backend/app/systems/relationships/service.py:RelationshipError`, lock helpers, and `_commit`.
- `backend/app/systems/lifecycle/exceptions.py`, `router.py:_error_response`, `service.py`, and `password.py`.
- `backend/app/systems/users/service.py:invite_user` and `backend/app/core/integrations/supabase.py:SupabaseAdminClient`.
- `backend/app/systems/audit/listeners.py:broadcast_committed_changes`.
- `frontend/src/app/bff/[...path]/route.ts:handle` and `frontend/src/lib/api.ts:apiFetch`.
- `backend/scripts/check_operational_health.py` and `backend/app/core/observability.py`.
