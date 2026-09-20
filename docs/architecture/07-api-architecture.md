# API Architecture

> **Scope:** HTTP contracts, browser boundary, and SSE.

FastAPI routes are mounted below `/api`. Caddy forwards the same-origin `/api` and `/api/events` paths to FastAPI; all other browser paths go to Next.js. The browser does not receive a database credential or a server-side signing secret.

Cookie-authenticated browser mutations require an exact allowed `Origin` and `X-CSRF-Token`. Browser login, refresh, logout, setup, and session status are FastAPI routes. CLI clients use bearer tokens from the token endpoints. A request containing ambiguous cookie and bearer credentials is rejected.

Domain routes use capability dependencies. Lists use the standard offset-pagination contract with explicit sorts and UUID tie-breakers. Routes commit or roll back their own `AuditSession` transaction before translating expected integrity or concurrency errors.

`GET /api/events` is authenticated SSE. It emits `resync` and opaque `invalidate` events only, sends heartbeats, bounds subscriber queues, and rechecks access as the stream runs. Clients must refetch authorized data; event messages are never a data API.

The normal error shape remains route-local `HTTPException` detail. Authentication failures are generic; API responses and logs must not disclose passwords, tokens, raw storage paths, or internal database details.
