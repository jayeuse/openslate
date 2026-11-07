# Audit and History

> **Scope:** Application ORM audit capture and post-commit invalidation.

`AuditSession` captures normal application ORM entity mutations and writes redacted minimal before/after snapshots in the same transaction as the business change. It records request and actor context when available. Work that runs as the workspace, such as a record trigger, has no user actor and names itself in `actor_label`. Bulk ORM mutation statements and raw ORM mutation execution are rejected because they cannot provide reliable per-row snapshots.

For department-owned entities, `manage/audit/department_ancestry.py` resolves the department before the ORM flush and `manage/audit/listeners.py` stores its ID with the audit row. This retains the department association even when a parent is hard-deleted in the same transaction. The audit column has no department foreign key, so the history survives a department purge. Company and project Board content and unrelated entities have a NULL department. `GET /api/audit-logs` allows administrators to list all entries or filter by department; a department manager must select a department where their department-level access is `manage`. Audit detail, export, and security-event routes remain administrator-only. Options: administrator and department manager (the manager for a department they manage, as for the list).

Record history for readers (S4, approved by the owner on 2026-11-03): any member may list the history of one record by sending `entity_id` without `department_id`, when the read check of `GET /api/records/{id}` passes (the module read of `app/systems/access/policy/scope.py`, shared through `app/systems/sandbox/records/access.py`). A record the member cannot open gives the same empty page as a missing ID. The reader sees only that record's entries and only readable fields: live fields of the record's module that are not audit-redacted, plus `is_deleted`. An entry with no readable change is left out in SQL, so the total stays right, and `request_method`, `request_path` and `note` are null. A reader gets 422 for any `search` and for sorting by request path, because both read values the page leaves out. Admins, and managers who select their department, keep the full snapshot. This is a deliberate widening through the one access function (SEC-R6).

Audit entries and security events can be found by the full `request_id` or by its last 8 characters, the error reference that the interface shows (`reference` on both lists, D7). The full ID uses `ix_audit_logs_request`; the 8-character search scans the rows of the bound organization (owner decision 2026-11-03: no expression index, because row-level security keeps PostgreSQL from using one for `right()`).

Audit capture includes application data mutated through FastAPI. It excludes Alembic, administrative direct SQL, database provisioning, and filesystem byte operations. These boundaries must remain explicit in operational reporting.

Some models set `__audit_enabled__ = False`, so their row changes write no audit row and queue no invalidation. Bulk mutations stay rejected on them. Queue and job state is outside audit: [`ScheduledWork`](../../backend/app/systems/platform/scheduling/models.py), the [Comms job models](../../backend/app/systems/comms/jobs/models.py), and [`RecordTriggerEvent`](../../backend/app/systems/sandbox/record_triggers/models.py). A trigger's runs, its record changes and its notifications stay audited. The output rows of a report are also outside audit: [`ReportRunRow`](../../backend/app/systems/openview/reports/models.py) and `ReportRunEligibleUser`. The audited `ReportRun` holds the row count and an unredacted `csv_sha256`, so a saved copy of the CSV can be proved after the sweep removes the run.

After a successful audited commit, the listener queues one or more opaque invalidation events and publishes them through PostgreSQL notification. The event payload identifies only safe entity scope and never contains row snapshots, credentials, filenames, or file bytes. Delivery is best effort: database and audit state remain canonical if an SSE listener is unavailable.

Audit history is not a backup, a security-information event stream, or a complete
record of host-level operations. A guarded encrypted backup and manual restore
foundation exists; supported customer recovery, automated backup scheduling and
installed-host observability remain pending deployment work. See
[Deployment Architecture](12-deployment-architecture.md).
