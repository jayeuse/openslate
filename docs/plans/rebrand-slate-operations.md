# Rebrand: OpenSlate to Slate Operations

Status: slice 1 done, not committed (2026-11-02). Slices 2 to 4 are pending.

## Decisions

| Item | Decision |
|---|---|
| Display name | **Slate Operations** in prose, titles, email, and errors. |
| Short form | **Slate Ops**, only where space is tight (for example, the mobile header). |
| Machine stem | `slateops`. It replaces `openslate` in every identifier. |
| Scope | Everything: brand copy, wire identifiers, env vars, Compose names, database schema, roles, and Storage buckets. |
| Accepted effects | All users sign out once (cookie rename). Browser preferences reset once (localStorage rename). |

Examples of the stem: schema `slateops`, roles `slateops_owner` and `slateops_runtime`, buckets `slateops-ready` and `slateops-avatars`, cookie `slateops_csrf`, env var `SLATEOPS_INSTANCE_ID`, Compose project `slateops-supabase-local-*`, header `X-SlateOps-Instance`.

## Fixed limits

1. Do not edit files in `backend/migrations/`. Migration history does not change. Old migrations keep the `openslate` name.
2. Do not read or print `.env` (SEC-R3). Edit `.env.example`. Give the owner the list of key renames for `.env`, or rename keys in place with no output.
3. Do not remove Docker volumes from other worktrees or earlier runs.
4. Do not reset the development database. The Harbor and School sample packs are permanent.

## Slices

One pull request for each slice. Run the pre-push gate once for each push.

1. **Visible brand.** Frontend copy and titles, the workspace name fallback, backend messages and the API name, email templates, README, docs, specs, and the native manager window name. `DESIGN.md`, `PRODUCT.md`, and `.impeccable/design.json` change through `impeccable` only. No runtime risk.
2. **Wire identifiers.** Headers `X-OpenSlate-*`, the `User-Agent` values, cookies `openslate_access`, `openslate_refresh`, and `openslate_csrf`, the localStorage keys, the `openslate_manager` package, and CI workflow names. Frontend, backend, and tests change in one pull request.
3. **Env vars, Compose names, and instance identity.** `OPENSLATE_*` to `SLATEOPS_*`, the Compose project prefix, `packaging/`, `infra/caddy/`, and `RESTORE.md`. Copy the development volumes before the prefix changes:
   1. Stop the development stack with `python3 scripts/dev.py stop`.
   2. Create each new volume.
   3. Copy each old volume into its new volume with `cp -a`.
   4. Start the stack and check that the sample packs are present.
   5. Keep the old volumes until the owner approves their removal.
4. **Schema, roles, and buckets.** Write a one-time operator command in `backend/operations/`. It renames the schema and the roles, fixes grants and policies, and copies the Storage buckets. It is not an Alembic migration: `alembic_version` lives in the `openslate` schema, so Alembic cannot find its history after the code points at the new name. Run the command on each installation before the renamed code starts.
   - Caution: `ALTER ROLE ... RENAME` clears MD5 passwords. Make sure that the roles use SCRAM before the rename.
   - Caution: `DATABASE_URL` and `MIGRATION_DATABASE_URL` contain the role names. Update them in the same step, or the API cannot connect.
   - Keep the old buckets until a download check passes, then remove them.

## Owner steps (not in the repository)

1. Rename the GitHub repository `jayeuse/openslate` to the new name. After that, update the remote URL in each checkout.
2. Rename the local checkout folder last. The Claude memory folder and worktree records use the folder path.
