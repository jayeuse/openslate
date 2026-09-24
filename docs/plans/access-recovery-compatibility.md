# Access recovery proof and future host compatibility

> **Status: draft operator contract.** This is a manual recovery path for the isolated Access rollout, not an installer, scheduler, customer backup service, or native Windows/macOS certification. The release recovery procedure needs separate approval before publication.

## Current recovery set

A version-2 backup configuration names one installation, one PostgreSQL database, an encrypted local Restic repository, and each private-file root by a stable logical ID. The backup manifest records the database dump hash and size, schema revision, installation ID, and the source path/flavor plus tree hash/count/bytes for each logical root. The same root IDs can map to different paths in a restore configuration. Version-1 backup verification remains supported; the manual restore command requires version 2.

The [backup command](../../packaging/backup/backup_installation.py), [restore command](../../packaging/backup/restore_installation.py), and [version-2 configuration example](../../packaging/backup/backup-config.example.json) are operator tools. They do not start, stop, register, or update services. The operator must establish a stopped-service maintenance state and lock using the documented installation-operation contract before either command. The repository, password files, staging, database, and private roots must meet the commands' path and ownership checks. Keep PostgreSQL and Restic secrets in protected files, never in a tracked configuration or command argument.

## Manual isolated recovery sequence

1. Preserve the encrypted snapshot and its password file. Record the full snapshot ID and installation ID. Keep the browser/API and other mutation-capable services stopped. Do not substitute Alembic downgrade for recovery.
2. Prepare a **new empty database** and **empty private-file target directories**, with a version-2 restore configuration that maps every backed-up logical root ID to its new target path. Confirm the target's host, port, database name, identity, and physical storage before allowing a write. Do not point it at the current active database.
3. From `backend/`, inspect first with `PYTHONPATH=../packaging uv run python -m backup.restore_installation --config <protected-restore-config> --snapshot <full-64-character-id> --source-installation-id <installation-id>`. This checks the snapshot inventory, restored dump/tree hashes, schema revision metadata, target emptiness, and maintenance lease without writing target data. The command prints a confirmation string bound to that snapshot and target.
4. Only after inspecting the printed target, run the same command with `--execute --confirm '<exact printed confirmation>'`. The database restore uses one transaction. The command promotes verified private files and writes its completion marker only after temporary staging is removed. A failure leaves the installation offline; do not reuse a partial target as if it were fresh.
5. Independently verify the restored Alembic revision, representative Access users/roles/groups/rules/defaults/service metadata, private-file bytes, and the completion marker before reopening any service. A customer release must additionally prove runtime-role permissions, sign-in, file/scanner state, API readiness, and origin/secret rebinding.

The command currently fails closed for Windows-origin snapshot paths and for execution on Windows. Its present real-tool proof is a POSIX-host manual recovery, not cross-OS restoration. Source paths in the manifest are evidence about the backup source; logical root IDs are the future remapping contract. Do not infer Windows Restic snapshot path syntax or native ACL safety from a configuration parser test.

## Evidence completed for this rollout

- A fresh task-owned PostgreSQL 17 source migrated through the four Access revisions to `2bf95b237416`; synthetic Access identities, role, group/member, policy rule/defaults, service metadata, credential, file metadata, and matching private bytes were created. A separate task-owned PostgreSQL 17 target and file directory were empty before restore. Neither was the active development database.
- Real PostgreSQL `pg_dump` and Restic 0.19.1 produced and inspected a version-2 snapshot. The restore command's inspection made no database or private-file-target write; its confirmed execution restored the target. Guarded checks matched nine entity counts, the custom role, rule/defaults, schema revision, and private bytes; target `alembic check` found no drift.
- After the snapshot and first restore, the disposable source was downgraded to pre-Access revision `d1a731600968`; its new group, rule, and service tables were absent. A second empty target was then restored **after** that downgrade and passed the same nine entity-count, policy/defaults, schema, and private-byte checks. The [backup/restore contract tests](../../packaging/backup/tests/) also exercise malformed data, target guards, and logical-root behavior.
- Version-2 config tests accept macOS/POSIX and Windows absolute-path forms while preserving the same logical root ID. These are parser/format tests only. No installed-host, same-drive, Windows-native, service-runtime, or cross-OS restore was run.
- The repaired empty-target check accepted a new empty PostgreSQL 17 probe database, then rejected that same database after a public function was added. Its private-file target and completion-marker directory remained empty after rejection.

## Future Windows/macOS installation gates — outside this task

Before claiming customer recovery on either OS, certify native service stop/maintenance handoff, protected-path and ACL/ownership checks, Restic snapshot path interpretation, PostgreSQL and private-file restore on each host, secrets/origin rebinding, runtime-role and sign-in checks, scanner/file recovery, and repeated installed-host restore tests. Separately choose backup destination, schedule, retention, key recovery, and recovery-point/time objectives. None of these is implied by the manual isolated proof above.
