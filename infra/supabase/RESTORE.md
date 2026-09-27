# Offline installation backup and restore

This is a support-operated backup and recovery procedure for a version 3 Supabase installation. Run the commands below from the root of the matching OpenSlate release checkout on a Linux host or WSL2, with the pinned images used by the installation. Windows Docker Desktop acceptance is still pending. A guarded production Compose backup and restore rehearsal passed using Linux containers on macOS Docker Desktop; native Linux host boot/reboot and Windows operation remain unverified. Keep restored public ingress closed until the final admission step; restore markers record operations and do not gate application startup.

The backup is an offline physical set of PostgreSQL, Storage, and other named volumes, plus private configuration and a manifest. Treat the backup and restored private files, and Compose output, as secrets. Use an owner-controlled Restic repository, password file, staging directory, backup config, target parent directory, and target environment files. Never restore into an existing customer project or volume.

## Back up the source installation

Schedule an outage and identify the exact source Compose project, `OPENSLATE_INSTANCE_ID`, and release checkout. The [version 3 configuration example](../../packaging/backup/backup-config.example.json) lists every required JSON field. Create a new owner-only config file outside the checkout for this backup run; replace all example values with real absolute paths. Set `installation_id` to the source instance ID, `project_name` to the source Compose project, `deployment` to `production` or `development`, and `compose_root` to this checkout's `infra/supabase` directory. Supply the source provider environment and, for production, the source application environment, Caddyfile, and TLS directory. Development requires those three production-only entries to be `null`. The command copies these inputs, the matching Compose files, and the named volumes into one encrypted snapshot. It does not copy scanner definitions or their manifest; retain and verify those separately for recovery.

Create distinct absolute directories for the Restic repository, staging, and completion-marker parent. They must not overlap each other or the recursively copied Compose/TLS inputs. Keep the repository and staging directory outside the installation's named volumes, and keep the marker outside both. Create a strong Restic password in a separate owner-only regular file; protect the config, environment files, Caddyfile, and password file with owner-only permissions. The tool rejects symlinks in protected paths, group/world-writable directories, and group/world-readable private files. Initialize the empty repository **once** with that password file before the first backup; for later runs, reuse the repository and password without reinitializing it:

```sh
RESTIC_REPOSITORY=ABSOLUTE_REPOSITORY_PATH \
  RESTIC_PASSWORD_FILE=ABSOLUTE_PASSWORD_FILE restic init
```

Set `completion_marker` in each new config to a **new, nonexistent** absolute filename under its private parent. The backup command refuses to overwrite a marker. Retain prior markers because each contains the full snapshot ID needed for restore. Validate the source provider environment and release Compose files with `docker compose --project-name SOURCE_PROJECT --env-file SOURCE_PROVIDER_ENV -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml config --quiet` (use the development overlay for development). Confirm the project identity and expected four development or five production named volumes. Use the same project name, provider environment, and Compose files throughout the outage. Before stopping anything, record `ps --all` output and the state of any host-run API or worker in the private outage record. In particular, distinguish a running scanner worker from one deliberately halted for inspection. Stop all source services, including PostgreSQL, without deleting containers or volumes:

```sh
docker compose --project-name SOURCE_PROJECT --env-file SOURCE_PROVIDER_ENV \
  -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml stop
```

For a development installation, replace `compose.production.yaml` with `compose.dev.yaml` in the stop and restart commands. Do not use `down -v`. Use the same `docker compose` prefix with `ps --all` to confirm every source-project container is stopped, and ensure no process can write its volumes. The backup command independently verifies the complete stopped service and named-volume inventory, pinned images, matching Compose configuration, and unchanged inventory during export. Run it while the source remains quiescent:

```sh
PYTHONPATH=packaging python3 -m backup.backup_installation \
  --config SOURCE_BACKUP_CONFIG
```

The command admits the initialized repository, writes one Restic snapshot, runs `restic check --read-data`, restores the manifest for a hash comparison, and only then creates the owner-only completion marker. Record the full `snapshot_id` from that marker with the matching config and release. If the command fails or the marker is absent, treat this run as incomplete; inspect the failure before relying on any snapshot or restarting writes.

After a completed backup, use the original source project, environment and overlay. Resume only services recorded as running before the outage. Keep public Caddy stopped while restoring dependencies, the API and scanning. Use explicit service names and `--no-deps` at each stage, so Compose cannot implicitly start a deliberately halted service:

```sh
docker compose --project-name SOURCE_PROJECT --env-file SOURCE_PROVIDER_ENV \
  -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml \
  up -d --no-deps PREVIOUSLY_RUNNING_SERVICE_NAMES
```

Replace the final placeholder with the services for the current stage: first `db`, then its previously running provider dependants; wait for their health checks. In production, restore previously running `clamav` and `api` next. Inspect scanner health, definitions and any recorded worker failure before explicitly resuming `scanner-worker`. A worker that was halted before backup remains halted until the operator resolves its cause and authorizes resumption. Development installations similarly resume only their intended host-run API and worker processes.

Check `/api/ready` through an operator-only/internal path with the configured Host header, while Caddy remains stopped. If any required component is unready, keep ingress closed and investigate. Only after readiness succeeds may the operator explicitly start `caddy` with `--no-deps`, and only if it was running before the outage. Verify the public endpoint before ending the outage. A previously stopped installation remains stopped.

This command does not schedule backups, expire snapshots, or copy them off host. The installation operator must set a backup cadence and retention policy, copy the encrypted Restic repository off host, protect the password separately, keep the marker/config/release identity with the recovery record, monitor backup failures and capacity, and rehearse restoration to a distinct owned target. Do not delete a source snapshot or its required private material until a later usable recovery point is verified.

## Select and inspect the target

Read the full 64-character `snapshot_id` from the completed version 3 backup marker. Use the source backup configuration as `SOURCE_BACKUP_CONFIG`; its `installation_id` and project must match the manifest. Its `compose_root` must point to the matching release checkout's `infra/supabase` directory. The restored `compose/` directory is evidence of the backed-up file set; do not run Compose from it, because the production overlay's relative build contexts require the release checkout. The restore command checks that the checkout's bundled Compose files match the snapshot and that pinned image IDs are present locally.

Choose a **new** Compose project, a **new** `OPENSLATE_INSTANCE_ID` different from the source config's `installation_id`, and a fresh absolute target directory under an owner-controlled parent. Keep these exact values for every command. The target project must have no existing Docker containers, volumes, or networks. The following names stand for operator-supplied real paths and IDs; do not paste them as values:

```sh
PYTHONPATH=packaging python3 -m backup.restore_installation \
  --config SOURCE_BACKUP_CONFIG --snapshot FULL_SNAPSHOT_ID \
  --target-project NEW_TARGET_PROJECT --target-instance-id NEW_TARGET_INSTANCE_ID \
  --target-directory FRESH_ABSOLUTE_TARGET_DIRECTORY
```

Inspection validates the Restic inventory, manifest, file hashes, image IDs, tar members, release Compose files, and target collision checks without creating a target. It prints the exact confirmation text. In an interactive terminal, execute with that exact text:

```sh
PYTHONPATH=packaging python3 -m backup.restore_installation \
  --config SOURCE_BACKUP_CONFIG --snapshot FULL_SNAPSHOT_ID \
  --target-project NEW_TARGET_PROJECT --target-instance-id NEW_TARGET_INSTANCE_ID \
  --target-directory FRESH_ABSOLUTE_TARGET_DIRECTORY \
  --execute --confirm 'EXACT_TEXT_FROM_INSPECTION'
```

The confirmation binds the source, snapshot, target project, target instance ID, and target directory. Execution imports volumes, then writes `restore-pending.json` and owner-only copies under `restored-source-private/`. If it fails after a volume is created, keep ingress closed and investigate the partial target; do not retry with the occupied project as though it were fresh.

## Rebind while ingress is closed

Prepare a separate owner-only **target** provider environment from the restored source material. Retain the restored secrets required to read the physical database and provider data, including the PostgreSQL password and Auth signing keys; set `OPENSLATE_INSTANCE_ID` to `NEW_TARGET_INSTANCE_ID`. Change the target's site/origin/issuer/gateway URLs and any host ports so they belong only to this installation. For production, prepare a separate owner-only application environment using the restored application secrets that still protect stored data, the target `OPENSLATE_INSTANCE_ID`, target `PUBLIC_ORIGIN`, and the target database/provider endpoints. Set `API_EXTERNAL_URL` and `SUPABASE_AUTH_ISSUER` consistently. Do not point either environment at the source installation or put bootstrap/provider secrets in the API or worker environment. Review every restored path and replace it with an existing target-owned absolute path where the production overlay expects one.

Prepare the release-specific server, ClamAV, and Caddy images referenced by `OPENSLATE_SERVER_IMAGE`, `OPENSLATE_CLAMAV_IMAGE`, and `OPENSLATE_CADDY_IMAGE`. Create the target log directory, verified immutable scanner definitions and matching manifest, and the intended TLS material. Render the target Caddyfile with `infra/caddy/generate_config.py` for the target public host, HTTPS port, certificate mode, and `api:8000` upstream. Keep `CADDY_CONFIG_PATH`, `CADDY_TLS_DIR`, `SCANNER_DEFINITIONS_DIR`, `SCANNER_MANIFEST_PATH`, and `OPENSLATE_LOG_ROOT` on target-owned paths. The archived Caddyfile and TLS files are source recovery material, not automatically safe target ingress configuration. See [README.md](README.md) for the production input contract and scanner/TLS requirements.

From the matching release checkout, validate both the base and production overlay with the **target** environment. `config --quiet` avoids printing interpolated secrets:

```sh
docker compose --project-name NEW_TARGET_PROJECT --env-file TARGET_PROVIDER_ENV \
  -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml config --quiet
```

Start only PostgreSQL using the base Compose file. It has internal provider and operator networks and no published database port. Do not use the development overlay or start Auth, API, worker, gateway, or Caddy yet:

```sh
docker compose --project-name NEW_TARGET_PROJECT --env-file TARGET_PROVIDER_ENV \
  -f infra/supabase/compose.yaml up -d --no-deps db
```

Wait for the target `db` health check. Finalization checks the target project's container and volume ownership, verifies that the running DB actually mounts the target project's data and config volumes at PostgreSQL's expected paths, checks its pinned image and internal-only network, requires no published database port, and permits only its DB to run. It connects as the pinned provider's `supabase_admin` role, verifies `current_setting('cluster_name')` equals `NEW_TARGET_INSTANCE_ID`, revokes OpenSlate application sessions, clears their encrypted provider tokens, and verifies the resulting database state before writing `restore-finalized.json`. A missing or mismatched identity, failed SQL, or nonzero session residue leaves the finalized marker absent. Keep ingress closed and investigate any such failure.

```sh
PYTHONPATH=packaging python3 -m backup.restore_installation \
  --config SOURCE_BACKUP_CONFIG --snapshot FULL_SNAPSHOT_ID \
  --target-project NEW_TARGET_PROJECT --target-instance-id NEW_TARGET_INSTANCE_ID \
  --target-directory FRESH_ABSOLUTE_TARGET_DIRECTORY --finalize
```

## Admit services and public traffic

With finalization recorded and ingress still closed, start the provider services from the target production environment:

```sh
docker compose --project-name NEW_TARGET_PROJECT --env-file TARGET_PROVIDER_ENV \
  -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml \
  up -d auth rest storage imgproxy meta studio api-gw
```

Check their health, confirm target database/schema admission and application roles, verify the two private Storage buckets, and confirm the target's provider configuration. Do not rerun initialization or a migration that changes restored data without a release-specific migration decision. Start the API and verify its target identity, authenticated behavior, file access, and email-template route. Then start ClamAV and the scanner worker and verify the scanner generation and worker state:

```sh
docker compose --project-name NEW_TARGET_PROJECT --env-file TARGET_PROVIDER_ENV \
  -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml up -d api
docker compose --project-name NEW_TARGET_PROJECT --env-file TARGET_PROVIDER_ENV \
  -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml \
  up -d clamav scanner-worker
```

Bring up public Caddy only after target TLS, origin, ports, application health, and the absence of source routes have been checked:

```sh
docker compose --project-name NEW_TARGET_PROJECT --env-file TARGET_PROVIDER_ENV \
  -f infra/supabase/compose.yaml -f infra/supabase/compose.production.yaml up -d caddy
```

The source and target may coexist only with distinct projects, volumes, host ports, URLs, and paths. Do not use `down -v` on either project.

A guarded disposable production Compose rehearsal has exercised the real five-volume restore with a separate target, database-only session finalization, TLS trust, restored application authorization and file access, and service restart using Linux containers on macOS Docker Desktop. This does not prove native Linux host boot/reboot behavior or Windows Docker Desktop acceptance. Customer-specific configuration, the canonical pre-push gate, and final release review remain pending; do not treat the rehearsal as general production approval.
