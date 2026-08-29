# Architecture Decisions

> **Scope:** Significant design choices evidenced by code and configuration, without inventing unrecorded historical rationale.
> **Audience:** Developers evaluating whether a proposed change fits the current system.
> **Related documents:** [System overview](01-system-overview.md), [Data architecture](06-data-architecture.md), [Infrastructure](11-infrastructure.md), [Architecture risks](20-architecture-risks.md)

The repository contains no formal ADR set. The entries below are reconstructed decisions: the code proves the design and its technical effect, but usually not the original reason.

## AD-01 — FastAPI is the application data API

**State:** Implemented.

`supabase/config.toml` excludes the application schema from the Data API, and frontend domain calls use the Next BFF to reach FastAPI. The effect is one application validation/authorization/audit path. Direct SQL and Studio remain outside it.

## AD-02 — Alembic exclusively owns application schema evolution

**State:** Implemented.

Supabase migrations and seeds are disabled. `backend/migrations/` contains a linear chain and CI performs upgrade plus drift check. Schema startup is therefore explicit and separate from service startup.

## AD-03 — Backend organization is capability-oriented

**State:** Implemented with uneven internal layering.

Cross-cutting code lives in `app/core`, shared application code in `app/common`, and domains in `app/systems`. Routers commonly query/mutate models directly; relationships and lifecycle add services/planners. There is no repository layer.

## AD-04 — Supabase Auth owns identity and credentials

**State:** Implemented.

Local users key to `auth.users`; passwords are not stored by OpenSlate. Invitations and password changes use Supabase. Local profiles/roles remain the application authorization source.

## AD-05 — Browser sessions terminate at Next.js

**State:** Implemented.

Next route handlers keep access/refresh tokens in HttpOnly cookies. The BFF forwards an access token to FastAPI and performs one refresh/retry. Protected page gating is client-side, while FastAPI remains authoritative.

## AD-06 — Auditing is an ORM transaction concern

**State:** Implemented.

`AuditSession` listeners capture per-model changes, insert minimal redacted logs in the same transaction, reject bulk/raw ORM mutation, and broadcast after commit. The explicit effect is exact application-ORM coverage, not database-wide auditing.

## AD-07 — Domain entities use soft lifecycle state

**State:** Implemented.

`BaseModel` supplies open/closed columns. Default lists exclude closed rows; lifecycle planning controls hierarchical close/reopen and optional purge. Database FKs restrict physical deletion, so purge orders rows explicitly.

## AD-08 — Realtime carries invalidation only

**State:** Implemented.

No application table publication exists. The backend broadcasts an opaque event after commit; clients refetch from FastAPI. Realtime failure cannot invalidate the committed DB result.

## AD-09 — Local infrastructure is Supabase CLI plus host processes

**State:** Implemented locally.

The root has no Compose/reverse-proxy stack. Supabase CLI owns local platform containers; Uvicorn and Next.js run on the host. Dockerfiles are standalone artifacts, not the supported local orchestration path.

## AD-10 — Authorization is literal role-name based

**State:** Implemented; fine-grained authorization absent.

Domain routes require `admin`. Permissions JSON is persisted but ignored. The technical effect is fail-closed behavior for all other roles, not a permission system.

## AD-11 — PostgreSQL-specific behavior is part of the contract

**State:** Implemented.

JSONB, partial indexes, checks, RLS, Auth triggers, and lock behavior are architecture dependencies. Migration and schema verification therefore use PostgreSQL rather than SQLite.

## Decisions not present

No repository evidence establishes a hosted provider, shared-tenancy model, production ingress/TLS, secrets platform, backup/restore policy, monitoring stack, or file-processing design. Those subjects are **Unknown**, not implicit decisions.
