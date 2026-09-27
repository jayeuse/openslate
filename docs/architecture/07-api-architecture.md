# API Architecture

> **Scope:** HTTP contracts, browser boundary, and SSE.

FastAPI routes are mounted below `/api`. In production, Caddy forwards the
same-origin browser origin to one FastAPI upstream; FastAPI serves exact static
UI exports alongside `/api` and `/api/events`. Daily development opens `next
dev` directly, whose development-only `/api` proxy reaches loopback FastAPI.
The browser does not receive a database credential or a server-side signing
secret.

Cookie-authenticated browser mutations require an exact allowed `Origin` and `X-CSRF-Token`. Browser login, refresh, logout, setup, and session status are FastAPI routes. CLI clients use bearer tokens from the token endpoints. A request containing ambiguous cookie and bearer credentials is rejected.

Domain routes use capability dependencies. Lists use the standard offset-pagination contract with explicit sorts and UUID tie-breakers. Department, module, and field routes are read-only (`GET` lists and details); the [Sandbox publish](../../backend/app/systems/sandbox/publications/executor.py) is the only write path for them, and close, reopen, and purge use the [lifecycle routes](../../backend/app/systems/sandbox/lifecycle/router.py). Routes commit or roll back their own `AuditSession` transaction before translating expected integrity or concurrency errors.

`GET /api/events` is authenticated SSE. It emits `resync` and opaque `invalidate` events only, sends heartbeats, bounds subscriber queues, and rechecks access as the stream runs. Clients must refetch authorized data; event messages are never a data API.

The normal error shape remains route-local `HTTPException` detail. Authentication failures are generic; API responses and logs must not disclose passwords, tokens, raw storage paths, or internal database details.
