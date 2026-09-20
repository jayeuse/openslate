# Glossary

| Term | Meaning |
| --- | --- |
| Action token | One-time, purpose-bound local token for invitation, recovery, or password actions. |
| `AuditSession` | SQLAlchemy session that captures supported application ORM mutations. |
| Caddy gateway | Same-origin reverse proxy from the canonical browser origin to Next.js and FastAPI. |
| Identity session | Server-side PostgreSQL state for refresh rotation, revocation, and browser/CLI credentials. |
| Owner connection | High-privilege migration connection used only by Alembic. |
| Runtime connection | Constrained PostgreSQL login used by FastAPI. |
| SMTP delivery outbox | PostgreSQL queue containing encrypted optional invitation or recovery delivery payloads for the bounded SMTP worker. |
| Quarantine object | Private file byte object awaiting verified scan/promotion. |
| Ready object | Immutable private file byte object that passed scanner and integrity checks. |
| SSE invalidation | Authenticated opaque signal that asks a client to refetch authorized data. |
| Setup-only session | Limited identity session that may complete password activation but cannot enter the workspace. |
| Workspace sample state | Browser-local placeholder data used by UI-first screens. |
