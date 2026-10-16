# System Overview

> **Scope:** OpenSlate's self-hosted server contract, ownership boundaries, and implementation status.

OpenSlate is a self-hosted web application installed separately for each client. One installation holds one or more organizations, and one account can belong to several of them. The selected deployment topology is Docker Compose with Linux containers on Linux servers or Windows through Docker Desktop and WSL2. The checked-in Supabase Compose stack supplies PostgreSQL, Auth, Storage, and Studio. FastAPI remains the application API and authorization authority. It serves a statically exported Next.js frontend, uses SQLAlchemy for application data, and mediates private file access. The production Compose overlay adds Caddy. Production and Windows runtime acceptance remain pending.

## Server runtime contract

| Concern | Owner |
| --- | --- |
| Browser UI | Static Next.js export and React, delivered by FastAPI |
| HTTPS ingress | Caddy in the production Compose overlay, with one FastAPI application upstream |
| Browser routes, assets, and 404s | FastAPI static-site delivery |
| Business API and application authorization | FastAPI with synchronous SQLAlchemy and OpenSlate roles, groups, permissions, and domain policies |
| Relational database | Supabase Database (PostgreSQL), with separate Supabase-owned and OpenSlate-owned schemas |
| Application schema | Alembic using the owner connection; the active fresh-install root is `8db89b6c6c35` |
| Authentication | Supabase Auth verifies email/password and issues provider sessions and JWTs |
| Application identity and sessions | FastAPI maps provider subjects to local users and keeps revocable `identity_sessions`; `memberships` give each user a role in each organization |
| Organization context | The `X-Org` request header, else the session's active organization; FastAPI binds each transaction to that organization |
| Files | PostgreSQL file metadata; private Supabase Storage buckets `openslate-ready` (organization files) and `openslate-avatars` (account avatars), mediated by FastAPI |
| File-type validation | FastAPI allowlist and bounded parser subprocess before the Storage write |
| Invalidation | Authenticated SSE using PostgreSQL `LISTEN`/`NOTIFY` |
| Realtime channels | Supabase Realtime private channels `org:<org_id>:…`, joined with a 5-minute token from `POST /api/realtime/token`; OpenComms (Phase 2) is the first user |
| Operator database UI | Supabase Studio, loopback-bound behind gateway Basic Auth |

The browser does not write application rows or read private objects directly. FastAPI verifies provider JWTs against the configured issuer and JWKS, confirms provider subject/session liveness, resolves an explicitly bound OpenSlate user, and checks the application's session and current authorization state. The backend never derives application roles from provider metadata. Normal application mutations use `AuditSession`; Alembic and provider-managed Auth/Storage operations remain outside that application ORM audit boundary.

The application runtime role has normal application-table privileges needed by FastAPI. Its provider-schema exception is deliberately narrow: an operator provisions `openslate_app` for read-only access to `auth.sessions.id` and `auth.sessions.user_id` through the `openslate_session_liveness` SELECT policy. It has no Auth mutation access. PostgreSQL row-level security on organization tables refuses rows of other organizations as a backstop to FastAPI's explicit filters. OpenSlate does not duplicate its roles, groups, or domain authorization model in PostgreSQL row policies. Provider APIs for Auth and Storage use server-only credentials, and provider Data API routes for application tables are blocked.

## Development boundary

The pinned self-hosted provider stack is also the Compose-based development and test database/Auth/Storage environment. Its development overlay publishes the database and provider gateway on loopback and adds Mailpit; host-run FastAPI and `next dev` can remain the daily application workflow. Installation-specific environment, project names, ports, and volumes keep each instance isolated.

Production uses `infra/supabase/compose.production.yaml` to add the unified FastAPI/static-UI image and Caddy. The database is not published to the host; Studio's provider gateway remains loopback-only. This Compose path is documented and implemented in configuration, while production TLS, complete operator acceptance, Windows startup/restart, and restore on Windows remain unverified release work. No Node.js or Next.js process runs as a production application service.

## Status boundaries

- The repository contains a per-installation self-hosted Supabase Compose stack for PostgreSQL, Auth, Storage, and Studio, plus OpenSlate's PostgreSQL, Auth, and Storage adapters.
- Supabase Auth owns password verification, provider tokens, invitations, and password-recovery email actions. FastAPI owns application identity binding, sessions, authorization, and session revocation.
- A private Supabase Storage bucket replaces the former local-filesystem file adapter. FastAPI validates each upload's file type, and the file is ready when its upload request finishes. File authorization stays in OpenSlate.
- Alembic owns only OpenSlate's application schema. The prior Supabase/schema-redesign and vanilla PostgreSQL chains are retained as history; the active root is for fresh installations and does not import an existing database.
- The OpenSlate event endpoint remains authenticated SSE over PostgreSQL notifications. Supabase Realtime carries private organization channels only; it never carries invalidations.
- The selected server target is Linux and Windows with Linux containers. Windows acceptance remains pending; macOS is a workstation platform, not a server target.
- `/api/ready` reports Database, Auth, Storage, and SMTP configuration states. All four are required. These probes do not establish mail delivery, backup integrity, or complete deployment acceptance.

See [system context](02-system-context.md), [data architecture](06-data-architecture.md), [authentication and authorization](08-authentication-authorization.md), and [deployment architecture](12-deployment-architecture.md).
