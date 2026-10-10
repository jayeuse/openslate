# Access recovery and host compatibility

## Current authority

The earlier isolated Access rollout's version-2 database-dump/private-root
proposal is historical. It is not the recovery contract for a current Supabase
installation. Use the support-operated [offline backup and restore procedure](../../infra/supabase/RESTORE.md)
and [deployment architecture](../architecture/12-deployment-architecture.md).
An Alembic downgrade that recreates empty tables does not recover Access data.

## Version 3 recovery set

The [configuration example](../../packaging/backup/backup-config.example.json)
uses version 3. The [backup](../../packaging/backup/backup_installation.py) and
[restore](../../packaging/backup/restore_installation.py) commands preserve an
offline physical installation set: PostgreSQL, private Storage and the other
named provider volumes, private configuration, and the manifest. Auth and
Storage are provider-owned; an application-only SQL dump is not a substitute.
Protect the Restic repository/password, staging, configuration and target
environment files. Never put secrets in tracked configuration or reports.

The operator establishes the exact owned source and stopped-service maintenance
state, then restores to a new target project and fresh volumes under the
procedure's identity, path, inventory and confirmation guards. Inspection is
not execution authorization. A failed or partial restore keeps public ingress
closed; a completion marker alone does not admit the application.

Before opening ingress, follow the procedure's role/schema, origin/secret,
session-finalization, readiness, sign-in and private-file authorization checks.
Application profiles, roles/groups/access, sessions and audit are OpenSlate
data; provider credentials, subjects and Storage objects must remain coherent
with them. File bytes are in Supabase Storage, not a selectable filesystem
adapter; there is no scanner recovery stage.

## Host and release limitations

The supported server target is Linux or Windows Docker Desktop/WSL2 with Linux
containers, one stack per client. A guarded Linux-container restore rehearsal
on macOS Docker Desktop establishes that Compose path only. Native Linux host
boot/reboot and Windows startup, reboot, persistent-volume and restore
acceptance remain pending. macOS is a development workstation, not a server
target; no native Windows or cross-OS recovery certification is implied.

Release admission, retention, key recovery and customer recovery objectives
must follow the current operator/deployment contracts. See
[known gaps](../reviews/known-gaps.md#deployment-and-recovery-acceptance);
no historical Access review grants merge, deployment or active-database access.
