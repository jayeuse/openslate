# Audit and History

> **Scope:** Application ORM audit capture and post-commit invalidation.

`AuditSession` captures normal application ORM entity mutations and writes redacted minimal before/after snapshots in the same transaction as the business change. It records request and actor context when available. Work that runs as the workspace, such as a record trigger, has no user actor and names itself in `actor_label`. Bulk ORM mutation statements and raw ORM mutation execution are rejected because they cannot provide reliable per-row snapshots.

For department-owned entities, `manage/audit/department_ancestry.py` resolves the department before the ORM flush and `manage/audit/listeners.py` stores its ID with the audit row. This retains the department association even when a parent is hard-deleted in the same transaction. The audit column has no department foreign key, so the history survives a department purge. Company and project Board content and unrelated entities have a NULL department. `GET /api/audit-logs` allows administrators to list all entries or filter by department; a department manager must select a department where their department-level access is `manage`. Audit detail, export, and security-event routes remain administrator-only.

Audit capture includes application data mutated through FastAPI. It excludes Alembic, administrative direct SQL, database provisioning, and filesystem byte operations. These boundaries must remain explicit in operational reporting.

After a successful audited commit, the listener queues one or more opaque invalidation events and publishes them through PostgreSQL notification. The event payload identifies only safe entity scope and never contains row snapshots, credentials, filenames, or file bytes. Delivery is best effort: database and audit state remain canonical if an SSE listener is unavailable.

Audit history is not a backup, a security-information event stream, or a complete
record of host-level operations. A guarded encrypted backup and manual restore
foundation exists; supported customer recovery, automated backup scheduling and
installed-host observability remain pending deployment work. See
[Deployment Architecture](12-deployment-architecture.md).
