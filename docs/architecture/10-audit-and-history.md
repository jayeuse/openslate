# Audit and History

> **Scope:** Application ORM audit capture and post-commit invalidation.

`AuditSession` captures normal application ORM entity mutations and writes redacted minimal before/after snapshots in the same transaction as the business change. It records request and actor context when available. Bulk ORM mutation statements and raw ORM mutation execution are rejected because they cannot provide reliable per-row snapshots.

Audit capture includes application data mutated through FastAPI. It excludes Alembic, administrative direct SQL, database provisioning, and filesystem byte operations. These boundaries must remain explicit in operational reporting.

After a successful audited commit, the listener queues one or more opaque invalidation events and publishes them through PostgreSQL notification. The event payload identifies only safe entity scope and never contains row snapshots, credentials, filenames, or file bytes. Delivery is best effort: database and audit state remain canonical if an SSE listener is unavailable.

Audit history is not a backup, a security-information event stream, or a complete record of host-level operations. Backup, restore, and installed-host observability remain pending deployment work.
