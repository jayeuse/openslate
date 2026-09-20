# Backend Architecture

> **Scope:** FastAPI application boundaries and request execution.

`app/main.py` assembles API routers, configuration, database lifecycle, audit listeners, file worker, and event hub. The stack is synchronous SQLAlchemy 2 with FastAPI; application code does not use an asynchronous ORM or direct browser-to-database access.

`app/core/` holds configuration, database, security, middleware, and audit-aware session infrastructure. `app/common/` holds shared dependencies and list behavior. `app/systems/<area>/<capability>/` owns domain models, schemas, routers, and coordination services.

Identity is a FastAPI module. Passwords use Argon2. Access tokens are short-lived FastAPI-signed JWTs; refresh tokens rotate and are checked against server-side sessions. Browser endpoints issue HttpOnly cookies and require Origin plus CSRF validation. Bearer-token routes remain available for CLI use.

The events module maintains authenticated SSE subscriptions. Commit-time audit listeners publish opaque PostgreSQL notifications. Event streams reauthorize subscribers, have bounded queues and send timeouts, and contain invalidation data only.

File services use the local storage backend, quarantine uploads, verify digest and size, invoke the scanner, and publish only clean bytes. The storage root is server-only and every public file operation is authorized by FastAPI.
