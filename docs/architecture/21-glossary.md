# Glossary

| Term | Meaning |
| --- | --- |
| Application profile | OpenSlate's PostgreSQL-backed user record. It is explicitly bound to a Supabase Auth subject; provider email or metadata alone does not create application access. |
| Application session | OpenSlate's server-side session state used for application session listing and revocation. Revocation is enforced by FastAPI even if provider sign-out is unavailable. |
| Application schema | OpenSlate-owned tables and types managed by SQLAlchemy models and Alembic migrations. |
| Authorization | FastAPI's decision about whether a bound, eligible profile may access an application route or resource under current OpenSlate roles, groups, capabilities, and grants. |
| Authentication | Verification of who signed in. Supabase Auth performs provider identity and credential checks; this does not decide what a person may access in OpenSlate. |
| `DATABASE_BOOTSTRAP_URL` | Operator-only Supabase database connection used to provision OpenSlate database roles and grants. |
| `MIGRATION_DATABASE_URL` | Owner connection used by Alembic for OpenSlate application-schema changes. |
| `DATABASE_URL` | Constrained `openslate_runtime` connection used by FastAPI and application workers. |
| Provider subject | The Supabase Auth user identifier explicitly associated with an OpenSlate application profile. |
| Provider schema | Supabase-owned database objects, such as Auth or Storage metadata, which OpenSlate's Alembic migrations do not own. |
| Ready object | Immutable private Storage object in `openslate-ready`, written after file-type validation; FastAPI still authorizes each download. |
| Session revocation | OpenSlate's application-level denial of a previously issued session. It remains authoritative even when provider-side sign-out cannot complete. |
| Supabase Compose installation | One self-hosted Supabase and OpenSlate deployment with its own Compose project, credentials, networks, and persistent volumes. It is per client; it is not a shared multi-tenant hosted service. |
| Supabase Realtime | Optional provider change-stream service. It is not started; OpenSlate currently uses PostgreSQL invalidations over authenticated SSE. |
| Supabase Storage | Provider-managed object API and persistent volume for OpenSlate's private file bytes. FastAPI, not the browser, uses its privileged credentials. |
| SSE invalidation | Authenticated opaque signal asking a client to refetch authorized application data through FastAPI. It does not include protected row snapshots. |
| `/api/ready` | Bounded component readiness report for Database, Auth, Storage, and SMTP configuration, all required; mail delivery, schema compatibility, and backup integrity need separate checks. |
| `WEB_ASSETS_ROOT` | Server-side path to the static frontend export served by FastAPI in production. |
| Workspace sample state | Browser-local placeholder data used by UI-first screens; it is not authoritative application authorization or durable backend data. |
