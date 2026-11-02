# Rebrand: OpenSlate to Slate Operations

Status: slices 1 to 4 committed (2026-11-02). The development sample data is not repopulated yet.

## Decisions

| Item | Decision |
|---|---|
| Display name | **Slate Operations** in prose, titles, email, and errors. |
| Short form | **Slate Ops**, only where space is tight (for example, the mobile header). |
| Machine stem | `slateops`. It replaces `openslate` in every identifier. |
| Scope | Everything: brand copy, wire identifiers, env vars, Compose names, database schema, roles, and Storage buckets. |
| Accepted effects | All users sign out once (cookie rename). Browser preferences reset once (localStorage rename). |

Examples of the stem: roles `slateops_owner` and `slateops_runtime`, buckets `slateops-ready` and `slateops-avatars`, cookie `slateops_csrf`, env var `SLATEOPS_INSTANCE_ID`, Compose project `slateops-supabase-local-*`, header `X-SlateOps-Instance`.

## Fixed limits

1. Do not edit applied revisions. Slice 4 archives them unchanged; they keep the `openslate` names.
2. Do not read or print `.env` (SEC-R3). Edit `.env.example`. Give the owner the list of key renames for `.env`, or rename keys in place with no output.
3. Do not remove Docker volumes from other worktrees or earlier runs.
4. Do not reset the development database, except for the slice 4 rebuild that the owner approved on 2026-11-02.

## Slices

One pull request for each slice. Run the pre-push gate once for each push.

1. **Visible brand.** Frontend copy and titles, the workspace name fallback, backend messages and the API name, email templates, README, docs, specs, and the native manager window name. `DESIGN.md`, `PRODUCT.md`, and `.impeccable/design.json` change through `impeccable` only. No runtime risk.
2. **Wire identifiers.** Headers `X-SlateOps-*`, the `User-Agent` values, cookies `slateops_access`, `slateops_refresh`, and `slateops_csrf`, the localStorage keys, the `slateops_manager` package, and CI workflow names. Frontend, backend, and tests change in one pull request.
3. **Env vars, Compose names, and instance identity.** Done. `OPENSLATE_*` became `SLATEOPS_*`, and the Compose, Docker label, image, test-stack, and host-path names use `slateops`. The development stack moved as follows:
   1. Stop the old containers. Rename the `.env` keys and the instance ID value in place, with no output.
   2. Run `python3 scripts/dev.py db` once. Compose creates the new labelled volumes and the attestation.
   3. Stop the stack. Copy each old volume into its new volume with `cp -a`.
   4. Compare entries, file checksums, owners, and modes. All four volumes matched.
   5. Start the stack. Alembic is at head, all 7 sample packs are present, and a sample account signs in.
   - The old `openslate-supabase-local-d131ecd3` containers and volumes are stopped and kept. Remove them only when the owner approves.
4. **Database names, roles, and buckets: new migration root.** Decided with the owner on 2026-11-02. There is no production installation, so the development database is rebuilt instead of renamed in place.
   - **Outcome:** one new model-generated root replaces the 28 active revisions, with `slateops_owner`, `slateops_runtime`, `slateops_app`, the `slateops.org_id` setting, and the `slateops-ready` and `slateops-avatars` buckets. The old revisions move unchanged to `migrations/history/organization_root/`.
   - **Proof:** a schema-only dump of the new database must equal the reference dump of the old database after the name changes. The roles, default privileges, provider policies, provider privileges, and buckets must also match.
   - **This decision removes:** the operator rename command, the Auth metadata rewrite, the bucket copy, the policy rewrite, the import rule for Sandbox files exported before the rename (they are now rejected; development data only), and 11 tests that downgrade to archived revisions.
   - **Not kept:** the development data. The owner repopulates the sample packs and the testing accounts. The old `openslate-supabase-local-d131ecd3` volumes stay until the owner approves their removal.
   - **Exceptions in the rules:** `backend/migrations/AGENTS.md` records this as the second authorized rebuild after S04/D13.

### Names that slices 2 and 3 keep, and why

| Name | Reason | Owner |
|---|---|---|
| `openslate-accent`, `openslate-radius`, `openslate.sample.draft-text.v1.`, `openslate.sample.v1.` | Legacy browser keys. The code reads or removes them because old browsers still hold them. | Keep |
| `slateops_user_id`, `slateops_invitation_operation_id` | Keys in Supabase Auth `app_metadata`. Each existing user stores them. | Slice 4 (data update) |
| `slateops-sandbox` (design file `kind`) | Stored in design rows and in exported design files. | Slice 4 (data update, import decision) |
| `openslate.backup.export.request.v1` | HMAC context of backup export requests. Kept so the line matches the CodeQL alert that main dismissed (idempotency HMAC, not a password hash). | Keep |
| `slateops-sample-people-v1` | File format of sample-run records on disk. | Slice 4 |
| `slateops_session_liveness` | Policy on `auth.sessions`. | Slice 4 |
| Sample-pack `uuid_namespace` values (`slateops:harbor-operations:v4` and others) | They decide the IDs of the permanent sample data. A change creates duplicates on the next run. | Keep |
| Hash domain strings (`slateops:identity-rate-limit:v1:`, `slateops:security-representative:v1:`) | Stored digests depend on them. | Keep |
| `openslate-quarantine` | Name of a retired bucket that the cleanup command removes. | Keep |
| `~/.config/openslate-handson/` | Owner-only file outside the repository. | Owner choice |
| `github.com/jayeuse/openslate` URLs | They change when the repository is renamed. | Owner step 1 |

## Owner steps (not in the repository)

1. Rename the GitHub repository `jayeuse/openslate` to the new name. After that, update the remote URL in each checkout.
2. Approve the removal of the old `openslate-supabase-local-d131ecd3` containers and volumes after a few days of use.
3. Rename the local checkout folder last. The Claude memory folder and worktree records use the folder path.
