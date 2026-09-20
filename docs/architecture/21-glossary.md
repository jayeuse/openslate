# Glossary

| Term | Meaning |
| --- | --- |
| Action token | One-time, purpose-bound local token for invitation, recovery, or password actions. |
| `AuditSession` | SQLAlchemy session that captures supported application ORM mutations. |
| Caddy gateway | Installed, configured, opt-in `gateway` Compose profile for a manually prepared production preview, production, and production-level acceptance. It has one FastAPI upstream and remains disabled in daily development. |
| Development API proxy | Next.js development-only forwarding of same-origin `/api` requests to loopback FastAPI. It is not part of the static production export. |
| Identity session | Server-side PostgreSQL state for refresh rotation, revocation, and browser/CLI credentials. |
| Owner connection | High-privilege migration connection used only by Alembic. |
| Runtime connection | Constrained PostgreSQL login used by FastAPI. |
| Static export | Build-time Next.js output containing the browser routes and assets served by FastAPI. |
| `WEB_ASSETS_ROOT` | Server-only path to the static export FastAPI serves in production. |
| SMTP delivery outbox | PostgreSQL queue containing encrypted optional invitation or recovery delivery payloads for the bounded SMTP worker. |
| Quarantine object | Private file byte object awaiting verified scan/promotion. |
| Ready object | Immutable private file byte object that passed scanner and integrity checks. |
| SSE invalidation | Authenticated opaque signal that asks a client to refetch authorized data. |
| Setup-only session | Limited identity session that may complete password activation but cannot enter the workspace. |
| Workspace sample state | Browser-local placeholder data used by UI-first screens. |
