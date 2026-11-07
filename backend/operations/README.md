# Operator commands

Backend-owned operator commands. Run them from `backend/`. The guarded reset rules are in `../AGENTS.md`.

- `supabase_keys.py --output <new-private-path>` creates a new owner-only key file without printing values. It does not assemble the full installation environment.
- `provision_database_role.py` provisions the application owner and runtime roles and the narrowly scoped Auth-session read.
- `provision_storage.py` creates the private `slateops-ready` bucket.
- `retire_legacy_upload_bucket.py` is a one-time upgrade step after `alembic upgrade head` for installations from before 2026-10-05. It is a dry run by default. `--execute` deletes the retired upload bucket and verifies its absence; outside development `--execute` also needs `--confirm`.
- `bootstrap_admin.py` sends the first administrator's provider invitation after the API is available.
- `check_file_storage.py` is read-only. It compares `ready` file rows with the objects and sizes in both private buckets and exits 0 (no difference), 1 (differences listed by bucket and file ID), or 2 (database or Storage unreadable). `infra/supabase/RESTORE.md` runs it after a restore.
- `verify_audit_seals.py` is read-only. It recomputes each sealed audit hour of every organization and of the installation as the runtime, and checks the chain of seals. It exits 0 (no difference), 1 (findings listed by organization, hour and kind), or 2 (the check could not run). `--heads FILE` (repeatable) also checks a backup's exported chain heads; `--write-heads FILE` writes the current heads to a new owner-only file instead. `infra/supabase/RESTORE.md` runs it after a restore.
