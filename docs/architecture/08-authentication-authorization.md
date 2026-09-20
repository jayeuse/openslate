# Authentication and Authorization

> **Scope:** Local FastAPI Identity, browser and CLI credentials, and role authorization.

FastAPI Identity owns passwords, invitations, refresh sessions, recovery links, and session revocation. Passwords are Argon2 hashes and the password policy rejects known common passwords. Identity data is stored in PostgreSQL alongside the user and role model.

Browser login accepts email or username. It issues short-lived access and rotated refresh tokens in Secure, HttpOnly cookies, plus a CSRF cookie. Refresh requires exact Origin and matching CSRF input. Setup-only sessions have limited lifetime and cannot open workspace routes until password activation completes. Logout and administrator session revocation invalidate server-side session state.

CLI users exchange local credentials for bearer tokens. The signed JWT contains the identity required for API verification; protected dependencies reload the local user, role, and session state before authorizing the request. Token replay, disabled users, expired tokens, incomplete setup, and invalid credentials fail closed.

Administrators create and resend invitations. When optional SMTP is enabled, FastAPI stores an encrypted invitation or recovery payload in the PostgreSQL delivery outbox and the bounded worker sends it through the configured transport. Disabled SMTP retains the local temporary-password and action-token flow. Delivery is at least once and records transport state, so a sent message is not proof that its recipient received or used the link. Local elevated recovery can create a one-time recovery secret under the documented host-administration guard.

Authorization uses ten flat read/write capabilities. Malformed permissions deny access. The literal `admin` role has all capabilities, and administration, audit, invitations, user management, and purge retain their administrator restrictions.
