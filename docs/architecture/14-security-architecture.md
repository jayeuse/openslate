# Security Architecture

> **Scope:** Implemented application controls and deployment gaps.

FastAPI is the application authorization and data boundary. Browsers use a same-origin Caddy gateway and Secure, HttpOnly access/refresh cookies. State-changing browser requests require an exact Origin and CSRF token. CLI clients use bearer tokens. Mixed cookie and bearer credentials are rejected.

Local Identity uses Argon2 password hashing, server-side session state, rotated refresh tokens, one-time action tokens, and login throttling. Protected dependencies validate signed JWTs and then reload active user, role, and session state. Setup-only, disabled, deleted, pending, or revoked identities fail closed.

PostgreSQL uses separate owner and constrained runtime credentials. FastAPI alone accesses application rows; the browser has no database credentials. Local files use opaque keys, private directory permissions, no-follow/handle-safe access, quarantine, digest/size verification, scanner gating, and authorization on every transfer.

SSE is authenticated and contains opaque invalidation data only. Subscriber limits, short-lived authorization checks, bounded queues, and send timeouts limit retained stream resources. Audit redacts sensitive fields and does not record raw passwords, tokens, object paths, or bytes.

Windows/macOS installer security, disk encryption checks, LAN TLS setup, secret delivery, backup encryption, restore validation, and operational monitoring are pending. They must not be represented as verified production controls.
