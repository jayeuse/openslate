# Runtime Flows

> **Scope:** Current request paths and their durable boundaries.

## Developer startup

1. Start the documented disposable PostgreSQL service and validate root configuration.
2. Use the owner connection to apply the Alembic baseline and provision the constrained runtime login.
3. Start FastAPI and Next.js on loopback. Use Caddy when the same-origin gateway is required.
4. Create the first local administrator through the documented bootstrap or host-recovery path.

## Browser sign-in and request

1. The browser posts email/username and password to FastAPI through `/api/auth/login`.
2. FastAPI verifies Argon2 credentials, applies local throttling, creates an Identity session, and sets access, refresh, and CSRF cookies.
3. `apiFetch()` sends same-origin API requests. Mutation requests carry the CSRF value.
4. FastAPI verifies JWT claims, local session state, active user state, and capability before executing the domain route.
5. A single coordinated refresh rotates the server-side session when the access token expires. Failed refresh clears the browser cookies and returns to sign-in.

## File upload and download

1. FastAPI authorizes upload and writes the opaque bytes into private quarantine.
2. Metadata and scan work are committed to PostgreSQL.
3. The worker validates size/digest and scans the quarantined bytes. Only a verified clean result promotes an immutable ready object.
4. Download rechecks file and parent authorization and streams the ready object through FastAPI.

## Mutation and invalidation

1. A route commits individual ORM changes through `AuditSession`.
2. Audit rows commit with the business state.
3. The listener publishes opaque PostgreSQL notification after commit.
4. Authenticated SSE subscribers receive invalidation or resync and refetch authorized resources.

## Optional action delivery

1. An invitation or recovery action creates a one-time local token.
2. With SMTP enabled, FastAPI encrypts the token for the PostgreSQL outbox; disabled SMTP leaves the local setup flow available without a mail server.
3. The bounded SMTP worker claims one delivery, sends its fragment-based link, and records delivery, retry, cancellation, or terminal failure while clearing encrypted token material when it is no longer usable.

Native installers and backup recovery are not part of these implemented runtime flows.
