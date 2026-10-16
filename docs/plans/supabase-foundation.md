# Supabase foundation plan (Phase 1)

Base revision: `main` at `907e6351` (after PR #51, the security policy). Alembic head: `d3703f345c2f`.

Status: approved for delegation (owner, 2026-10-15). The owner answered the integration questions on 2026-10-15. Section 7 holds the decisions. Each default in section 7 stands unless the owner edits the table before the affected slice starts. Section 11 is the execution order.

Out of scope: OpenComms (a separate session owns it), and Phases 2–4 in section 10.

Final acceptance ownership: the owner performs S19 and S20 and fixes found during that acceptance. The implementation agent completes S01–S18, then hands off under section 11.9.

The evidence comes from static reads of the source at the base revision, one read-only query against the running development database, and upstream sources fetched on 2026-10-15. Nothing was executed against the application. Section 9 lists the claims that are not tested yet.

## 1. Intent

The integration work has four phases. This plan covers Phase 1 only.

| Phase | Content |
|---|---|
| **1. Foundation (this plan)** | Image upgrade, authentication hardening (H1, H2), multi-organization tenancy, organization scope in every subsystem, Storage buckets and avatars, the Realtime service with one authenticated private channel |
| 2. OpenComms | Chat, presence, typing, chat attachments (separate plan, on hold) |
| 3. Cloud launch | Supabase Cloud target, self-serve signup, plans and limits, operator console, Google and Microsoft sign-in, platform metrics |
| 4. Installer hardening | Passkeys and the local CA, Supabase Logs on-premise, the higher host specification, the Docker-or-native runtime test |

Outcomes of Phase 1:

1. The provider stack runs on patched images (Postgres 17.11 and current Storage, postgres-meta and Studio). PostgREST is gone.
2. MFA verification and password sign-in have durable account and source budgets (H1, H2).
3. One install holds many organizations. One account can belong to many organizations, with a role, groups and access per organization.
4. Every query, background job, live event, file and audit row is scoped to one organization. Postgres row level security (RLS) refuses rows of another organization when the application forgets a filter.
5. A person can switch the current organization in the app. The app shows avatars in the shell and in people lists.
6. The Realtime service runs in every stack. A signed-in browser joins one private Realtime channel of its organization, and a non-member is refused.
7. The Harbor and School sample packs load as two organizations in one install, and neither can see the other.

Non-goals (the speculative-schema rule in `AGENTS.md` applies, even though this plan rebuilds the migration root):

- No chat tables, no presence UI, no typing indicators.
- No signup page, no "create organization" screen, no plans, limits, or billing columns.
- No Google, Microsoft, or passkey sign-in.
- No Supabase Logs, Edge Functions, Supavisor, or Vault.
- No Supabase Cloud target. Section 5.12 keeps the code from moving further away from it.
- No retention settings, no exports or backups stored in Storage.

## 2. Baseline

### 2.1 What the owner asked for, and where it goes

| Owner item (2026-10-15) | Phase |
|---|---|
| Several organizations per install, shared tables, `org_id`, RLS backstop | 1 |
| One account across organizations with an organization switcher | 1 (switcher), 3 (self-serve creation) |
| Operator above organization admins | 1 (table and CLI), 3 (console) |
| On-premise and Supabase Cloud | 1 keeps Cloud possible, 3 delivers it |
| Self-serve signup, free tier with 1 owned organization, no OpenComms in free tier | 3 |
| Username or email sign-in, one account per email | 1 (global username and email) |
| Google, Microsoft, passkeys, LAN HTTPS by local CA | 3 and 4 |
| Authentication hardening H1 and H2 inside this phase | 1 |
| FastAPI is the only way into data, except a short-lived Realtime token | 1 |
| Realtime for OpenComms and presence, SSE stays for invalidations | 1 (service and auth), 2 (chat) |
| Storage through FastAPI, 10 MB limit, avatars and thumbnails | 1 |
| Record attachments, file library, exports, chat attachments in Storage | 1 prepares keys and buckets; features come later |
| Supabase Logs on-premise, higher host specification | 4 |
| Postgres 17.11 image upgrade as the first slice | 1 |
| Plan document, Codex executes, Claude supervises and accepts | 1 |

### 2.2 Facts that shape the design

**Tables.** There are 55 tables. 47 hold organization data, 4 hold account data (`users`, `identity_sessions`, `identity_mfa_observations`, `identity_rate_limit_buckets`), and 4 hold install data (`backup_policies`, `backup_runs`, `backup_export_operations`, `update_statuses`). Three organization tables are mixed: `security_events` (login events happen before an organization is known), `files` (the `user_avatar` purpose belongs to the account, `platform/files/models.py:16-27`), and `in_app_notifications` (the `backup-failed` kind is install-level, `scheduling/models.py:164`).

**Role on the user.** `users.role` holds admin, member, or guest for the whole install (`access/users/models.py:84`, check at `:47`). Guest sponsor and expiry are tied to it (`ck_users_guest`, `:73`). Routes use `get_current_user` (95 references), `require_admin` (53), `require_fresh_exact_admin` (70), `require_non_guest` (10), and about 50 direct `.role ==` comparisons in about 25 files. The frontend has 47 role checks.

**One workspace row.** `workspace_profiles` allows one row (`manage/workspace/models.py:25,95,101`). It mixes organization identity, security policy, and people settings. `load_workspace_policy` runs on every authenticated request (`common/dependencies/auth.py:92`, about 30 call sites). `GET /workspace/appearance` runs before sign-in with no user (`workspace/router.py:113`).

**Connections outside the request dependency.** `get_db` opens the request session (`core/database/session.py:48-62`). There are also 14 direct `AuditSession(get_engine())` sites, 4 raw REPEATABLE READ connections (`run_service.py:155`, `export.py:270`, `aggregation.py:355,371`), and psycopg connections for NOTIFY and LISTEN (`events/publisher.py:42`, `events/hub.py:299`). An organization setting applied only in `get_db` misses all of them.

**Roles and RLS.** `openslate_owner` owns the tables. `openslate_runtime` inherits `openslate_app` privileges and has `NOBYPASSRLS` (`provision_database_role.py:239-273`). The only RLS policy is on Supabase's `auth.sessions` (`:211`). `retain_security_events()` is `SECURITY DEFINER`, owned by `openslate_owner`, and reads the workspace row directly (`dfa5340b47ba:47-63,97`).

**Migrations.** 20 revisions in one chain. The root `089c54b88aa6` has 4,244 lines, 8 trigger functions, all grants, and 3 seed rows (workspace, sandbox document, Company board). 17 test files exercise single revisions. `migrations/AGENTS.md` says an applied root is immutable.

**SSE.** One global `pg_notify` channel (`events/publisher.py:42`). The payload has no organization (`events/models.py:179`). "All authenticated" and "admins only" events reach everyone (`events/models.py:27-38`). The viewer record has no organization (`events/router.py:259-264`).

**Storage.** One bucket `openslate-ready`, flat `uuid4().hex` keys (`files/service.py:139,163`). No bucket `file_size_limit`, no MIME list, no `storage.objects` policies (live check). Size limits differ by layer: middleware 25 MiB (`core/middleware/file_transfers.py:43`), validation 25 MiB and 2 MiB for logos and avatars (`files/validation.py:18-19`), Storage 50 MiB (`compose.yaml:202`). imgproxy runs, but nothing calls it. Avatars exist end to end (`frontend/src/components/profile/adapters/profile-api.ts:195-256`) and are served full size.

**Gateway.** Envoy returns 404 for `/rest/`, `/realtime/`, `/graphql/`, and `/functions/` (`upstream/envoy/lds.template.yaml:229-287`). WebSocket upgrade is already on (`:24-25`). Nothing in the backend or frontend calls PostgREST.

**Realtime.** The `realtime` and `_realtime` schemas and the `supabase_realtime` publication exist in the development database. There are no tables yet and no Realtime role. Upstream runs Realtime as `supabase_admin` with `SECRET_KEY_BASE`, `DB_ENC_KEY`, and `API_JWT_SECRET`, or `API_JWT_JWKS` for asymmetric keys (upstream `docker/docker-compose.yml`, realtime service). Realtime reads the tenant id from the host name.

**Keys.** `supabase_keys.py:29-64` creates an ES256 key and an HS256 secret. `JWT_JWKS` holds the EC public key and the symmetric key, so it is server-only. FastAPI holds neither `JWT_SECRET` nor `JWT_KEYS` (`infra/supabase/README.md:123`). FastAPI verifies ES256 tokens with a `kid` against the JWKS endpoint (`core/integrations/supabase_auth.py:278-378`).

**Authentication hardening (H1, H2).** The private security review of 2026-10-13 names two items for this phase. Its details stay in the ignored file `.agent-runtime/security-review-2026-10-13.md` (items F5 and F6) and never go into a tracked file, commit message, or pull request (`SECURITY.md`, SEC-R1). H1 concerns MFA verification (`identity/mfa.py`, `core/integrations/supabase_mfa.py`). H2 concerns password sign-in budgets (`identity/rate_limits.py`, `identity/provider_login.py`). Recovery already uses separate recipient and source buckets (`rate_limits.py:163-182`), which is the pattern to reuse.

**Frontend.** Every call goes through `apiFetch` in `frontend/src/lib/api.ts` (`requestHeaders()` at `:340`). The static export has no dynamic route segments, and `StaticSite` serves exact page keys only (`backend/app/core/static_site.py:70-84`). The query cache resets when `key={verifiedUserId}` changes (`app-page.tsx:664`). `EventSource("/api/events")` cannot send headers (`invalidation-events.ts:81`).

**Tests.** 47 frontend test files mock `/api/auth/me`. 38 backend test files override `get_current_user`, 85 construct `User(` directly, 34 use `role='admin'`, and 16 insert users with raw SQL. `create_owned_admin` inserts a raw admin row (`backend/tests/api_integration_support.py:11-56`). The route manifest has 251 method-and-path pairs; `SEEDER_ROUTES` has about 281 tuples.

## 3. Workstreams

| ID | Workstream | Slices |
|---|---|---|
| W1 | Provider image upgrade and PostgREST removal | S01 |
| W2 | Authentication hardening H1 and H2 | S02, S03 |
| W3 | Tenancy schema and migration root | S04 |
| W4 | Organization context and RLS | S05, S06 |
| W5 | Authorization per organization | S07 |
| W6 | Organization scope in subsystems | S08, S09 |
| W7 | Storage buckets, limits, avatars, thumbnails | S10 |
| W8 | Realtime service and authentication | S11, S12 |
| W9 | Frontend organization context and switcher | S13, S14 |
| W10 | Operator, bootstrap, reset, recovery, sample tooling | S15, S16 |
| W11 | Contracts and documents | S17, S18 |
| — | Owner acceptance | S19, S20 |

**Size.** This is the largest change in the repository's history. W3–W6 rewrite the data model, authorization, and every connection path. A credible estimate is possible only after S04 is scoped against the 4,244-line root. The working range is 6 to 10 weeks of agent run time. S04 records a revised estimate in the run record.

## 4. Order of work

```
Phase A  Small and independent
            ├─ S01 image upgrade, PostgREST removal
            ├─ S02 H1 MFA verification budget
            └─ S03 H2 account and source sign-in budgets
            │
Phase B  Tenancy core
            ├─ S04 schema and new migration root
            ├─ S05 organization context
            ├─ S06 RLS on every connection path
            └─ S07 authorization per organization
            │
         ── Owner checkpoint: review the tenancy model before Phase C ──
            │
Phase C  Subsystems
            ├─ S08 audit, notifications, search, workers, reports
            ├─ S09 SSE
            ├─ S10 Storage
            ├─ S11 Realtime service
            └─ S12 Realtime authentication spike and private channel
            │
Phase D  Frontend and tooling
            ├─ S13 frontend organization context
            ├─ S14 organization switcher and avatars
            ├─ S15 reset and recovery for many organizations
            └─ S16 sample packs as two organizations
            │
Phase E  Contracts, documents, acceptance
            ├─ S17 contracts and route manifest
            ├─ S18 documents
            └─ S19, S20 owner acceptance
```

Phase A comes first because each slice is small and does not touch tenancy. H1 has the highest priority in the review. S04 must come before every other tenancy slice, because it defines the tables they filter. The owner checkpoint sits after S07 because a wrong tenancy decision costs least there. S11 can run during Phase B, because it only changes infrastructure files.

## 5. Workstream details

### 5.1 W1. Provider image upgrade and PostgREST removal (S01)

**Owner decision:** upgrade first, with backup and restore rehearsed (D29). Remove PostgREST (D20).

Today:
- Postgres `17.6.1.136`, storage-api `v1.74.0` (pinned twice, `compose.yaml:165,182`), postgres-meta `v0.99.0`, Studio `2026.09.07-sha-7996410`.
- PostgREST `v14.17` runs, is blocked at the gateway, and has no caller.
- The storage-api source (`src/config.ts`, upstream `master`) reads no `POSTGREST_URL`; upstream compose still lists it.

Steps:
1. Take a backup of the development stack with the existing backup runner.
2. Pin the D29 images by digest in `infra/supabase/compose.yaml` and in `PROVIDER_IMAGES` (`backend/tests/disposable_instance.py:22-60`).
3. Read the Postgres 17.11 release notes for the `ltree`, `btree_gist`, and `pgcrypto` notes. Check which of these extensions the image enables, and record it. The application uses none of them.
4. Remove the `rest` service, the `depends_on: rest` and `POSTGREST_URL` on storage, the PGRST variable on Studio, and the `rest` Envoy cluster (`cds.yaml:34-64`).
5. Remove `rest` from these lists: `backups/host.py:25`, `backups/docker.py:171`, `packaging/backup/backup_installation.py:52`, `backup_runner_fixtures.py:29`, `packaging/backup/tests/test_supabase_installation.py:23`, `disposable_instance.py:28`, `infra/supabase/README.md:17,55`, `RESTORE.md:193`.
6. Start the stack. Run `provision_storage.py`. Upload and download one file through the API.
7. Restore the backup into a disposable stack and run the reset acceptance.
8. Record the memory use of each container (`docker stats`, idle and after the sample run). This feeds Phase 4.

Pain point: storage-api could still need PostgREST at start, even though the source has no such setting. Solution: if storage does not start without it, keep `rest` on the internal network only, keep it blocked at the gateway, and record the reason under D20.

Cloud tag: neutral.

Acceptance: all services healthy on the new images. File upload and download work. Restore rehearsal passes. Reset acceptance passes. Memory figures are in the run record.

### 5.2 W2. Authentication hardening H1 and H2 (S02, S03)

**Owner decision:** fix both inside this phase (D27, D28). Both are account-level and do not depend on tenancy.

Read items F5 and F6 and the section "Fixes ranked by risk" in the ignored review file before you start. Follow its recommended fixes.

**S02 — H1.**
1. Add an account-wide MFA verification budget in `identity_rate_limit_buckets`, keyed by the account. Use one key per account, plus one key per source.
2. Check the budget **before** the provider call in `identity/mfa.py`.
3. Write each failure in its own short transaction. Follow `append_committed_security_event` (`audit/service.py:354`).
4. When the budget is spent, return 429 with `Retry-After`, and write a security event.
5. A correct code clears the per-account budget.

**S03 — H2.**
1. Add a per-account bucket and a per-source bucket next to the existing composite bucket. Reuse the recovery pattern (`rate_limits.py:163-182`).
2. Apply them to `/auth/login`, `/auth/token`, and password reauthentication.
3. A spent per-account bucket starts a cooldown, never a permanent lock. This limits deliberate lockout of a victim.
4. Write a security event when any bucket is spent.

Pain point: per-account limits let an attacker lock out a known user. Solution: the cooldown is short (D28), recovery stays available, and the security event lets an admin see the attack.

Cloud tag: helps (the budgets live in the application, not in the provider).

Commit messages and test names stay generic, for example `fix(auth): add account-wide MFA verification budget` (SEC-R1).

Acceptance: the integration tests prove each fix that the review file recommends for F5 and F6, and that a correct sign-in or code clears the per-account budget.

### 5.3 W3. Tenancy schema and new migration root (S04)

**Owner decision:** shared tables with `org_id` and RLS (D01). One account, many memberships (D02). An operator above organization admins (D08). Resets are allowed, so the root is rebuilt (D13).

Steps:
1. Write a new single root revision that replaces the 20 revisions. Keep the trigger functions, grants, and default privileges, rewritten for `org_id`.
2. Add `organizations`. It is the per-organization part of `workspace_profiles` without the singleton (D03), plus a unique `slug`.
3. Add `platform_settings` as a one-row install table for the pre-organization security settings (D04).
4. Add `memberships` (D02) and `platform_operators` (D08).
5. Remove `role`, sponsor, expiry, and invitation fields from `users`. Keep `email` and `username` unique for the whole install (D35).
6. Add `org_id NOT NULL` to every organization table, with a foreign key to `organizations`. Add composite `(org_id, id)` foreign keys for references between organization tables (D09).
7. Add `org_id` to the unique constraints in D10.
8. Make `org_id` nullable on the three mixed tables, with a check that says which rows may have no organization (D15).
9. Do not seed an organization, a sandbox document, or a Company board in the migration. S15 creates them for each new organization.
10. Update `migrations/AGENTS.md` with the documented exception (D13).
11. Retire the revision-specific migration tests with the consolidation evidence that `scripts/assertion_guard.py` requires (D1–D6 of the Tier 2.5 test rules). Keep one root-level schema test that checks every organization table has `org_id`, an RLS policy, and the composite keys.
12. Add the shared test fixtures: `create_organization`, `create_member(org, role)`, and an updated `create_owned_admin`. Update the backend tests that this slice breaks (85 `User(` constructions, 16 raw inserts, 38 `get_current_user` overrides). A slice fixes the tests it breaks.
13. Rebuild the owned development database once. Its `alembic_version` holds `d3703f345c2f`, which the new root does not contain. Caution: do not run `docker compose down -v`; the volumes hold the Auth accounts and Storage bytes.
    1. Take a backup with the backup runner.
    2. Drop the objects that `openslate_owner` owns in `public`. Keep the `auth`, `storage`, `realtime`, `vault`, and other Supabase schemas.
    3. Run `alembic upgrade head` and `alembic check`.
    4. Record the commands and their output in the run record. S05 creates the first organization on this database.

Disposable test stacks start empty and need no rebuild.

Pain point: this one slice is very large. Solution: the slice may land as up to four commits (schema, model classes, fixtures, test updates) as long as the branch only moves to S05 after all four are in. Record the commit set in the run record.

Pain point: the trigger functions look up parent rows across tables. Solution: each trigger function checks that the parent has the same `org_id`, and raises an error if not.

Cloud tag: neutral to helps (standard roles and RLS work on Cloud; nothing new depends on `cluster_name`).

Acceptance: `alembic upgrade head` on an empty database builds the schema. `alembic check` reports no drift. The schema test passes. The backend unit lane passes.

### 5.4 W4. Organization context and RLS (S05, S06)

**S05 — organization context (D05, D06, D33).**
1. Add `identity_sessions.active_org_id`.
2. Add a dependency `get_current_membership`. It reads `X-Org`, or uses the session's active organization when the header is absent. It checks an active membership, the organization's MFA requirement (D32), and the organization's IP allow list. Without a membership it returns 403 `organization_required`. An unknown organization returns 404.
3. `GET /auth/me` returns the account, the list of memberships (organization id, name, slug, role), and the current organization with role and access.
   Account reads (`/auth/me`, `/auth/session`) and self-profile updates remain available when an implicitly saved organization refuses entry. They project no current organization or organization authority and expose required nullable `default_organization_blocked`: `mfa_required`, `ip_not_allowed`, or `organization_required` for an invalid membership; no saved selection returns null. Explicit `X-Org` and organization resources retain their actual entry denials. Account-owned verified MFA still requires AAL2 before any account projection.
4. Add `POST /auth/session/organization` to set the active organization.
5. An account with no membership can sign in and reaches only `/auth/me`, sign-out, profile, and invitation acceptance.
6. Invitations to an email that already has an account add a membership, instead of returning "Email or username is already in use" (`users/service.py:180-185`).
7. Add the operator CLI `backend/operations/create_organization.py`. It creates the organization, its sandbox document, its Company board, and the first admin membership or invitation.
8. Change `bootstrap_admin.py` to create the first account, the first organization, and the first operator. The GoTrue account of the existing development admin survives the S04 rebuild, so bootstrap must link an existing provider user instead of failing.
9. Run bootstrap on the development database, so that Phase C and the S13 and S14 screenshots have a real organization.

**S06 — RLS on every connection path (D11, D12).**
1. Add one helper that runs `SET LOCAL openslate.org_id = '<uuid>'` at the start of each transaction. Call it from `get_db`, all 14 `AuditSession(get_engine())` sites, and the 4 raw REPEATABLE READ connections.
2. Add an RLS policy on every organization table: `org_id = current_setting('openslate.org_id', true)::uuid`. When the setting is missing, no rows match, so the query fails closed.
3. Background workers claim due work through `SECURITY DEFINER` claim functions that return the job id and its `org_id`. The worker then sets `openslate.org_id` for that job's transaction.
4. Rewrite `retain_security_events()` so it reads the retention value of each organization, and the install value for rows without an organization.
5. The LISTEN connection stays unscoped. The hub filters events by organization (S09).

Pain point: a site that forgets the helper sees no rows and looks like an empty organization. Solution: in `development` and `test`, a statement on an organization table without the setting raises an error. A test runs every route once with the setting removed to prove that the guard fires.

Cloud tag: helps.

Acceptance: an integration test runs the same reads as members of two organizations and gets disjoint rows. A raw query without the setting returns no rows. A worker job of organization A cannot read rows of organization B.

### 5.5 W5. Authorization per organization (S07)

1. `scope.py` reads the role, status, expiry, and groups from the current membership, not from `users` (`effective_levels`, `:152`).
2. `require_admin`, `require_fresh_exact_admin`, and `require_non_guest` check the membership role.
3. Replace the about 50 `.role ==` comparisons with the membership role.
4. Key the administrator advisory lock by organization (`auth.py:35,169`). Last-admin counts run per organization.
5. Admin email and username changes stay account-level. Only an operator CLI or the account owner changes them.
6. People lists and person cards show only accounts with a membership in the current organization (D35).

Pain point: an account that is admin in organization A must have no power in organization B. Solution: a test matrix signs in one account with admin in A and guest in B, and calls every admin route in B. Every call must fail.

Cloud tag: neutral.

Acceptance: the matrix passes. The full backend coverage lane passes on the S04–S07 branch.

Restore the original exact statement budgets in `backend/tests/relationships_integration/test_statement_budgets.py`: GET Record 4, POST Record 13, PATCH Record 14, POST Relationship 13, and PUT Relationship 15. Remove the temporary S04 membership-read allowance after integrating S05 `get_current_membership`.

**Owner checkpoint.** After S07, the implementation agent stops and writes a checkpoint in the run record: the schema diagram, the D-row values used, and the test evidence. The owner reviews and releases Phase C.

### 5.6 W6. Organization scope in subsystems (S08, S09)

**S08.**
- **Audit:** add `org_id` to `AuditContext` (`audit/context.py:10`) and to `audit_logs`. Account actions (password, MFA, email) go to `security_events`.
- **Notifications:** add `org_id`. Admin recipients come from memberships (`scheduling/notification_creation.py:18`). `backup-failed` goes to operators (D15).
- **Search:** join memberships for people search (`search/query.py:245`).
- **Workers:** scheduling, reminders, posts, and triggers use the S06 claim functions.
- **Reports and records:** the timezone and week start come from the organization (`records/aggregation.py:46,58`, `windowing.py:32`, `export.py:279`, `run_service.py:185`, `publications/planner.py:287-300`).
- **Lifecycle buckets:** key by organization and actor (D15).
- **Bugs to fix:** `files/service.py:338` and `files/lifecycle_router.py:54` read `WorkspaceProfile` without a filter. With several organizations, they pick an arbitrary row.

**S09 — SSE (D16).**
1. Add `org_id` to the event payload and the parser (`events/models.py:179`).
2. Add `org_id` to the viewer record. The stream binds to one organization when it connects: the `org` query parameter, else the session's active organization.
3. The hub sends an event only to viewers of the same organization. "All authenticated" means all members of that organization. "Admins only" means its admins.
4. Switching the organization closes the stream, and the client opens a new one.

Cloud tag: neutral.

Acceptance: a test with two organizations shows that an event in A never reaches a viewer in B, for each event kind.

### 5.7 W7. Storage (S10)

1. Object keys become `org/<org_id>/<uuid>` in `openslate-ready`. Update the key check (`supabase_storage.py:12`).
2. Add the bucket `openslate-avatars` with keys `user/<user_id>/<uuid>` (D17). Avatars are account files, so a person keeps one avatar across organizations.
3. Set `file_size_limit` and `allowed_mime_types` on each bucket in `provision_storage.py`. Add the new bucket to `provision_storage.py:17` and `reset/storage.py:17`.
4. Set the upload limit to 10 MiB in validation, in the transfer middleware, and in the bucket limit (D18). Logos and avatars stay at 2 MiB. The global Storage limit stays at 50 MiB for later exports and backups.
5. Serve avatar thumbnails at 64 and 256 pixels. FastAPI fetches them from the Storage image transformation endpoint and returns them with the existing cache headers (D19). Superseded by the D19 amendment: FastAPI resizes with Pillow.
6. Pending-upload quotas count per organization (`files/quota.py:27-42`).
7. Keep `storage.objects` without policies for `anon` and `authenticated` (D17). This keeps any token that the shared JWKS accepts harmless against Storage (see S12).

Cloud tag: deepens slightly (image transformations need a paid Cloud plan). Recorded under D19.

Acceptance: a file from organization A cannot be read with a request in organization B. A 10.5 MiB upload returns 413. A thumbnail request returns an image at most 256 pixels wide.

### 5.8 W8. Realtime (S11, S12)

**S11 — service.**
1. Add the `realtime` service to `compose.yaml` at the D29 version. Follow the upstream service definition (`SECRET_KEY_BASE`, `DB_ENC_KEY`, `SEED_SELF_HOST`), with one change: do not copy the fixed `container_name` that upstream uses to encode the tenant. A fixed name is global on the Docker host, so the 3 local and 5 CI disposable stacks would collide. Set the tenant host name with a host rewrite on the Envoy route instead. Prove it against the `PROVIDER_IMAGES` and `compose ps` exact-match check (`disposable_instance.py:290-301`). Generate the new secrets in `supabase_keys.py`, and add their names to `PROVIDER_KEYS` (`scripts/environment.py:65-94`).
2. Add a gateway route `/realtime/v1/` with the WebSocket upgrade. Add it to the Lua apikey check (`lds:402-404`), the RBAC apikey policy (`:504-525`), and `cds.yaml`.
3. Add the service to every hard-coded list: `PROVIDER_IMAGES`, the networks and mounts in `disposable_instance.py:353-387`, the backup lists (`backups/host.py:21-35`, `backup_installation.py:49-59`, `backups/docker.py:51-70,169-174`), and the restart order. The disposable stack has room for 8 networks and uses 6 (`supabase_runtime.py:249-251`), so do not add a network.
4. Record the idle memory of the service.

**S12 — authentication spike and one private channel (D23).**

Candidates:
- **A.** FastAPI holds a dedicated ES256 key. Its public key is added to `JWT_JWKS`, which Realtime reads through `API_JWT_JWKS`. FastAPI mints a token valid for 5 minutes with `role: authenticated`, `sub` = the local account id, `org_id`, and `purpose: realtime`. RLS on `realtime.messages` checks the purpose, the topic prefix `org:<org_id>:`, and an active membership.
- **B.** FastAPI gives the browser the account's current GoTrue access token.
- **C.** FastAPI joins Realtime on the server and relays to SSE, as `infra/supabase/PLAN.md:103` says today. Presence then needs a separate design.

Steps:
1. Build A on the development stack: the token endpoint `POST /api/realtime/token`, the RLS policy, and a `SECURITY DEFINER` function `can_join_realtime_topic(topic)` that reads memberships.
2. Prove it with an HTTP-level test client: a member joins `org:<id>:probe`, sends a broadcast, and receives it. A non-member and an expired token are refused.
3. Check that the minted token cannot read Storage (no policies) and cannot call `/auth/v1/user`.
4. If A fails on self-hosted, try B with `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=true`, and record the result.
5. Record the Supabase Cloud situation. On Cloud, an imported key verifies tokens only as the current key or as a previously used key. One path: import FastAPI's key, rotate to it, then rotate to a fresh key; the FastAPI key then keeps verifying while GoTrue signs with the fresh key. Verifying that needs a Cloud project, which is an owner action. If the owner does not provide one, record Cloud compatibility as unverified, with B as the fallback for Phase 3.
6. Update `infra/supabase/PLAN.md:103` to the chosen design.

Pain point: every service that trusts `JWT_JWKS` accepts the minted token. Solution: PostgREST is gone (S01), Storage has no `authenticated` policies (S10), and RLS on `realtime.messages` requires `purpose: realtime`.

Cloud tag: deepens until the Cloud check is done. Recorded under D23.

Acceptance: the step 2 test passes in the HTTP or fullstack lane. No browser UI is part of this slice.

### 5.9 W9. Frontend (S13, S14)

**S13 — organization context.**
1. `requestHeaders()` in `api.ts:340` adds `X-Org` from the current organization.
2. The current organization lives in session storage for each tab, and it falls back to the session's active organization.
3. The query cache key becomes `${userId}:${orgId}` (`app-page.tsx:664`). Also reset `accountPreferencesOwner` (`theme-provider.tsx:42-43`) and `refreshInFlight` (`api.ts:270`).
4. `EventSource` uses `/api/events?org=<id>` (`invalidation-events.ts:81`).
5. `app-navigation.tsx` reads the role of the current membership.
6. Add a "No organization yet" page for accounts with no membership. It offers sign-out and shows pending invitations.
7. The invitation setup page joins an existing account to the organization.
8. Before sign-in, the theme is Slate, or the last organization theme cached in this browser (D26).
9. Update the HTTP base fixture (`frontend/tests/http/helpers/test.ts:149-200`) and `access-api.ts` with memberships. Update the 47 `/auth/me` mocks through the fixture helpers, not one by one.
10. Drive organization MFA/network gates from `default_organization_blocked`, not an implicit-context 403 from `/auth/session`. S05 exposes and parses that contract; the gate UI and its transitions remain S13 work.

**S14 — switcher and avatars.**
1. Turn the organization name in `AppSidebarHeader` (`app-shell.tsx:563-617`) into an organization menu. Include it in the mobile drawer.
2. The account menu trigger shows the avatar (`app-shell.tsx:769`).
3. People lists and `PersonCardPopover` sites show the 64-pixel avatar, with initials as the fallback.
4. Follow `DESIGN.md`, the tokens in `globals.css`, and the existing `ui/avatar.tsx`.

Cloud tag: neutral.

Acceptance: screenshots at 1440×900 and 390×844, light and dark, for the switcher, the empty-organization page, and a people list. A switch from A to B shows B's data with no stale data from A.

### 5.10 W10. Tooling (S15, S16)

**S15.** (The operator CLI and bootstrap come earlier, in S05.)
1. The application-data reset works on all organizations and recreates nothing. The operator runs `create_organization.py` afterwards. Update the checks in `reset/planning.py:212-215,356` and `reset/execution.py:60-111`.
2. `recover_local_admin.py` and `recover_workspace_security.py` take an organization argument.
3. The reset acceptance runs on an install with two organizations.

**S16.**
1. `SampleClient` sends `X-Org` (`backend/operations/sample/client.py:27`).
2. `seed_sample_data.py` creates one organization per pack. Harbor and School can both exist in one install.
3. Add a sample check that a Harbor actor cannot read School data.
4. Each slice that adds a route adds its sample executor and `SEEDER_ROUTES` entry in the same commit (section 11.7).

Acceptance: the Harbor Small and School Small profiles run in one install, and the isolation check passes.

### 5.11 W11. Contracts and documents (S17, S18)

**S17.** Regenerate `contracts/openapi.json`. Declare `X-Org` in the OpenAPI document. Regenerate the route manifest. Run the route coverage test and the frontend contract harness.

**S18.** Update these documents to the new model:
- `docs/architecture/` (system overview, data, authentication and authorization, runtime flows, glossary)
- root `AGENTS.md` (the authorization paragraph)
- `backend/migrations/AGENTS.md`
- `backend/AGENTS.md`: the line "single tenant … do not introduce … tenant-scoped schemas without an explicit decision". This plan is that decision (D01).
- `frontend/AGENTS.md`
- `infra/supabase/README.md`, `PLAN.md`, `RESTORE.md`
- `SECURITY.md`: the "For operators" line "One installation serves one organization" becomes the multi-organization rule; the in-scope examples gain "access to another organization's data"; the "Controls that reviews protect" table gains organization isolation (`org_id`, RLS, `get_current_membership`) and the Realtime token
- `docs/architecture/12-deployment-architecture.md`: the line "The self-hosted stack is not multi-tenant SaaS"

### 5.12 Cloud guardrails

Phase 3 delivers Supabase Cloud. These assumptions already block it:

1. Instance identity through Postgres `cluster_name` (`instance.py:366-391`).
2. Bootstrap through `supabase_admin` (`provision_database_role.py:71`).
3. `assert_provider_instance` requires host `db` and `http://api-gw:8000` (`provider_instance.py:28-34`).
4. The Storage client relies on the Envoy key swap (`supabase_storage.py:56-59`).
5. Settings that Cloud manages: GoTrue environment, email templates by URL, Storage backend, Envoy routes.
6. Physical volume backups.

Rule for every slice: do not add a new dependency on these items. Each slice records a tag: helps, neutral, or deepens. A "deepens" tag needs a D-row.

## 6. Migrations

S04 replaces the migration chain with one new root. After S04, each slice that changes the schema adds one Alembic revision. After a route change, regenerate the OpenAPI snapshot, the route manifest, and the contract fixtures in the same commit.

## 7. Decisions

Source values: **Owner** (answers of 2026-10-15), **Default** (proposed, stands unless edited), **Exploration** (changed by the 2026-10-15 code survey), **Amended** (changed during the run; the run record `.agent-runtime/supabase-foundation.md` has the reasons).

| ID | Decision | Value | Source | Slice |
|---|---|---|---|---|
| D01 | Tenancy model | Shared tables, `org_id NOT NULL` on organization tables, RLS as backstop | Owner | S04, S06 |
| D02 | Account and membership | `users` keeps email, username, provider id, account status, `tokens_valid_after`. `memberships` holds `org_id`, `user_id`, role, status, sponsor, `expires_at`, invitation timestamps, `mfa_required_since` | Default | S04 |
| D03 | Organization settings | `organizations` = per-organization part of `workspace_profiles`: identity, regional, theme, logo, MFA by role, IP allow list, invitation expiry, guest duration, plus unique `slug` | Default | S04 |
| D04 | Install settings | `platform_settings` (one row): password rules, session timeout and lifetime, concurrent sessions, login lockout | Exploration | S04 |
| D05 | Organization transport | `X-Org` header on each API call; `identity_sessions.active_org_id` as the default; `org` query parameter for `/api/events`; no organization in the URL path | Exploration | S05, S13 |
| D06 | Account with no organization | Can sign in; sees only profile, sign-out, and pending invitations | Default | S05, S13 |
| D07 | Organization creation in Phase 1 | Operator CLI and bootstrap only; no UI | Default | S05 |
| D08 | Operator | `platform_operators` table; CLI only; no access to organization data | Owner | S04, S05 |
| D09 | Cross-organization references | Composite `(org_id, id)` foreign keys between organization tables | Default | S04 |
| D10 | Unique constraints per organization | `uq_departments_name_active`, `uq_groups_name_active_ci`, `uq_boards_company`, the sandbox document and binding uniques, `uq_sandbox_publications_actor_key` | Exploration | S04 |
| D11 | RLS policy | `org_id = nullif(current_setting('openslate.org_id', true), '')::uuid`; no `FORCE` (the owner role runs migrations); missing setting returns no rows. No error in development and test: `tests/migrations/test_organization_row_security.py` and the serial shard lane find a missing scope (migration `f5a100021193`) | Amended (S06) | S06 |
| D12 | Setting the organization on connections | One session `after_begin` listener and one Engine `begin` listener (`organization_scope.py`). Workers loop over `active_organization_ids()` with `worker_organization()`, not `SECURITY DEFINER` claim functions; one organization's failure does not stop the others. Claim functions are Phase 3 cloud-scale work | Amended (S06, S08) | S06 |
| D13 | Migration root | New single root replaces 20 revisions; documented exception in `migrations/AGENTS.md`; revision tests retired with consolidation evidence | Owner (resets allowed) | S04 |
| D14 | Admin lock and last admin | Per organization: advisory lock `pg_advisory_xact_lock(0x4F534144, hashtext(org_id))`; the last-admin count is per organization | Amended (S07) | S07 |
| D15 | Mixed and per-user tables | `security_events.org_id` nullable for pre-organization events; avatars are account files; `backup-failed` notifications go to operators; lifecycle buckets keyed by organization and actor; identity buckets stay account-level | Exploration | S04, S08 |
| D16 | SSE | One stream per tab bound to one organization; payload and viewer carry `org_id`; a switch reconnects | Default | S09 |
| D17 | Buckets | `openslate-ready` with `org/<org_id>/<uuid>`; `openslate-avatars` with `user/<user_id>/<uuid>`; no `storage.objects` policies for `anon` or `authenticated` | Default | S10 |
| D18 | Upload limit | 10 MiB in validation, middleware, and bucket limit; logos and avatars 2 MiB; global Storage limit 50 MiB. Done in S10 | Owner (10 MB) | S10 |
| D19 | Thumbnails | FastAPI makes 64 and 256 pixel thumbnails with Pillow. Digest verification stays on the original bytes. No dependency on Storage image transformation, so the Cloud free plan works | Amended (S10) | S10 |
| D20 | PostgREST | Remove; if storage does not start without it, keep it internal and blocked | Exploration | S01 |
| D21 | Vault | Not in this phase: GoTrue reads SMTP from its environment, and no SQL consumer exists; keep Fernet for provider tokens | Exploration (changes the earlier default) | — |
| D22 | Realtime service | Upstream definition at the D29 version; tenant seeded for self-hosting; gateway route `/realtime/v1/` | Default | S11 |
| D23 | Realtime token | Spike: A first (FastAPI ES256 key in `JWT_JWKS`, 5-minute token, `purpose: realtime`), then B; Cloud check is an owner action, else unverified | Exploration | S12 |
| D24 | Realtime topic names | `org:<org_id>:<kind>:<id>`; Phase 2 adds kinds | Default | S12 |
| D25 | Sample packs | One organization per pack; Harbor and School in one install | Default | S16 |
| D26 | Theme before sign-in | Slate, or the last organization theme cached in the browser | Default | S13 |
| D27 | H1 budget | 5 wrong codes in 15 minutes per account, then 15 minutes cooldown; per-source budget 20 in 15 minutes; each failure committed in its own transaction | Default | S02 |
| D28 | H2 budgets | Per account 10 in 15 minutes, then 15 minutes cooldown; per source 30 in 15 minutes; existing composite bucket stays | Default | S03 |
| D29 | Image versions | Postgres `17.11.0.004`, storage-api `v1.81.0`, postgres-meta `v0.100.0`, Studio `2026.10.05-sha-94b8b06`, Realtime `v2.143.3` (Docker Hub, 2026-10-11); re-check at S01 and pin by digest | Owner | S01, S11 |
| D30 | Host specification | No change in Phase 1; record memory per service at S01 and S11 for Phase 4 | Default | S01, S11 |
| D31 | Guest across organizations | Role is per membership; a guest in one organization can be an admin in another | Default | S04, S07 |
| D32 | MFA per organization | The factor belongs to the account; the requirement belongs to the organization and applies on entry | Default | S05 |
| D33 | Session | `identity_sessions` stays account-level and gains `active_org_id` | Default | S05 |
| D34 | Audit placement | Organization actions in `audit_logs` with `org_id`; account actions in `security_events` | Default | S08 |
| D35 | People visibility | Email and username unique for the install; a person sees only accounts that share the current organization; display name and avatar are account-level | Owner (one account per email) | S04, S07 |
| D36 | Email templates per organization | Not in Phase 1: GoTrue fetches templates without organization context; Phase 3 decides | Exploration (changes the earlier default) | — |

### 7.1 Owner decisions (2026-10-16)

The owner answered the S07 checkpoint on 2026-10-16. The priority stays on-premises first, cloud second.

1. **Anonymous IP gating.** Keep as is. The IP allow list gates organization entry only, not sign-in, token, refresh, recovery, or invitation completion.
2. **Settings authority.** The installation owner (platform operator; on-premises, the first administrator) sets installation-wide password and session rules. The organization owner (`owner_user_id`) or the installation owner changes the organization's sensitive security settings. Other administrators do the rest.
3. **Signed-out theme.** Follow the organization's theme: the browser's last organization (`/api/workspace/appearance?org=`), else the only organization, else Slate.
4. **Backups.** Failure notices go to all administrators of the installation owner's organizations. Backup actions stay with administrators who are also the installation owner. Backup setup priority: database first, then server, then client.
5. **Local recovery commands.** Add an option to choose the organization (S15).
6. **Recovery of an expired guest account.** Keep it allowed. Disabled accounts stay refused.
7. **Pending invitations.** One pending invitation per person. A second invitation gets a neutral refusal.
8. **Worker scale.** Keep per-organization worker loops, and isolate each organization's failure now. Claim functions come later.
9. **Explicit filters and RLS.** Keep RLS-led isolation, with explicit predicates where RLS cannot help. A test fails on joins through `memberships` without an organization.
10. **Rows without an organization.** Keep the interim rule: an organization administrator sees such a row only when it concerns a person of that organization. Installation-wide rows stay hidden.
11. **People in several organizations.** Allowed. Organization administrators disable or remove the membership only. Account-level actions belong to the account owner or the installation owner. Organization creation per account is limited by subscription in Phase 3 (cloud, free plan = 1); on-premises has no limit.

## 8. Possible bugs found during the survey

| Bug | Evidence | Fixed in |
|---|---|---|
| Unfiltered reads of the workspace row pick an arbitrary row once several rows exist | `files/service.py:338`, `files/lifecycle_router.py:54` | S08 |
| `retain_security_events()` bypasses RLS and reads the single workspace row | `dfa5340b47ba:47-63,97` | S06 |
| storage-api is pinned in two places | `compose.yaml:165,182` | S01 |
| The Realtime plan text conflicts with the owner's choice | `infra/supabase/PLAN.md:103` | S12 |

## 9. Not verified

- That storage-api `v1.81.0` starts without PostgREST. The source shows no `POSTGREST_URL` setting; S01 proves it.
- That Realtime `v2.143.3` accepts `API_JWT_JWKS` with an added FastAPI key. The upstream compose file shows the variable as an option; S12 proves it.
- How Supabase Cloud handles an imported signing key for Realtime. This needs a Cloud project.
- The effect of the Postgres 17.11 notes on `ltree`, `btree_gist`, and `pgcrypto` for this image. S01 checks it.
- Memory use of each service. S01 and S11 measure it.
- The 6 to 10 week range. S04 revises it.

## 10. After Phase 1

The design must allow these without schema changes to the Phase 1 tables. None of them adds a column in Phase 1.

- **Phase 2 (OpenComms):** chat tables with `org_id`, Realtime topics under D24, presence on `org:<id>:presence`, chat attachments in `openslate-ready`. Re-check OpenComms decisions D6, D7, D20, and slices S20 and S27 against D23.
- **Phase 3 (Cloud launch):** signup that creates an account with no membership (D06); organization creation by users; plans and limits per organization; the operator console on `platform_operators`; Google and Microsoft identities linked to one account; the Cloud target and its test matrix; organization-branded email (D36).
- **Phase 4 (installer):** passkeys and the local CA; Supabase Logs on-premise; the host specification from the D30 figures; the Docker-or-native runtime test.

## 11. Execution

### 11.1 Rules for the whole run

1. Work on one branch in the main checkout: `codex/supabase-foundation`.
2. One Conventional Commit per slice. S04 may use up to four commits (section 5.3).
3. No push, no pull request, no history rewrite.
4. Do not change OpenComms files.
5. Read the skills named in `AGENTS.md` for the work: `sdd-workflow`, `tdd-workflow`, `verification-loop`, `fastapi-backend-patterns`, `fastapi-api-design`, `postgres-patterns`, `webapp-security-review` (S02, S03, S06, S07, S12), `react-frontend-patterns`, `query-cache-patterns`, `playwright-e2e-testing`.
6. Check library facts with Context7 before code that depends on a library.
7. Follow rule zero in `AGENTS.md`: never run backend and frontend test lanes at the same time.
8. Keep the run record in `.agent-runtime/supabase-foundation.md`.
9. Follow `SECURITY.md`, section "Reference for automated tools", rules SEC-R1 to SEC-R8:
   - SEC-R1: no vulnerability details in tracked files, commit messages, branch names, or code comments. Details stay in the ignored run record and review file.
   - SEC-R3: never read, print, or copy secret values. When a slice adds a secret (for example the Realtime keys in S11), generate it into the private `.env` with `supabase_keys.py` and refer to it by name only. Use `docker compose config --quiet` only.
   - SEC-R6: a slice that changes a control in the "Controls that reviews protect" table states why in its commit body. This plan changes three: the access function now reads memberships (S07), RLS joins the access function as a backstop (S06), and the gateway opens `/realtime/v1/` (S11).
   - SEC-R8: test only against the local stacks.

### 11.2 Definition of done for one slice

1. The behavior in the slice row and its section exists.
2. New behavior has tests: pytest for the backend, Playwright `isolated` or `http` for the frontend.
3. The tests needed to verify the slice and its affected boundaries pass. A slice fixes the tests it breaks.
4. Backend changes pass `uv run ruff check .` and `uv run mypy app operations`. Frontend changes pass `npm run check`.
5. A slice that changes UI has screenshots at 1440×900 and 390×844, light and dark, that match the request and `DESIGN.md`.
6. A `review` worker found no unresolved defect. S02, S03, S06, S07, and S12 also get a security review with `webapp-security-review`.
7. The slice records its Cloud tag (section 5.12).
8. The slice is committed, and the run record shows the evidence.

### 11.3 Slices

| Slice | Content | Section | Depends on |
|---|---|---|---|
| S01 | Image upgrade, PostgREST removal, backup and restore rehearsal, memory figures | 5.1 | — |
| S02 | H1 MFA verification budget | 5.2 | — |
| S03 | H2 account and source sign-in budgets | 5.2 | — |
| S04 | Tenancy schema, new migration root, fixtures, broken tests, development database rebuild | 5.3 | S01 |
| S05 | Organization context, `/auth/me`, active organization, invitations to existing accounts, operator CLI, bootstrap | 5.4 | S04 |
| S06 | RLS and the organization setting on every connection path, worker claim functions | 5.4 | S05 |
| S07 | Authorization per organization | 5.5 | S06 |
| — | **Owner checkpoint** | 5.5 | S07 |
| S08 | Audit, notifications, search, workers, reports, lifecycle buckets | 5.6 | checkpoint |
| S09 | SSE organization scope | 5.6 | checkpoint |
| S10 | Storage keys, avatar bucket, limits, thumbnails | 5.7 | checkpoint |
| S11 | Realtime service, gateway route, stack and backup lists | 5.8 | S01 |
| S12 | Realtime authentication spike and private channel | 5.8 | S07, S11 |
| S13 | Frontend organization context and test fixtures | 5.9 | S05, S09 |
| S14 | Organization switcher and avatars | 5.9 | S10, S13 |
| S15 | Reset and recovery for many organizations | 5.10 | S07 |
| S16 | Sample packs as two organizations | 5.10 | S15 |
| S17 | Contracts and route manifest | 5.11 | S16 |
| S18 | Documents | 5.11 | S17 |
| S19 | Owner: Harbor Small and School Small in one install, isolation check | — | S18 |
| S20 | Owner: full review and `python3 scripts/prepush.py --base main --serial` | — | S19 |

### 11.4 When to stop

- **Fix it yourself:** a failure inside the slice. Up to three attempts, each with a new diagnosis.
- **Block the slice:** three failed attempts, or a decision under section 11.6's block list. Record the evidence and continue with a slice that does not depend on it.
- **Stop the run:** the owner checkpoint after S07, a failure that corrupts the development stack, or a blocked slice that every remaining slice depends on.

### 11.5 Servers

Reuse the owned development Supabase stack. Start the API and Next only when the slice needs them, and stop the ones you started at the end of the slice. Disposable test stacks follow the runner's own cleanup.

### 11.6 Implementer decisions

For a detail that section 7 does not settle, decide yourself when it is one of these:

- validation of degenerate or empty input,
- the display of null, empty, or missing values,
- field, parameter, and error-code names,
- the test technique, fixtures, and clock control,
- the source of a derived value from existing columns.

Pick the most conservative option that matches an existing pattern in this repository. Record it in the run record under "Implementation decisions", with the pattern you followed. Then continue.

Block the slice only when the decision needs one of these:

- a new permission, or a change to who can see or change data, beyond section 7,
- deletion of data outside a reset or a test,
- a change to a public request or response shape that this plan does not list,
- work outside the slice's workstream,
- a new dependency on a Cloud blocker in section 5.12.

Correct: `S05: an X-Org value that is not a UUID → 422 invalid_organization, following the 422 style of the existing path validators; recorded; continued.`
Wrong: `S05: the error code for a bad X-Org value is not in section 7; slice blocked.`

Correct: `S08: a notification kind with no organization appeared in reminder_execution.py; it is not in D15; slice blocked with evidence.`
Wrong: `S08: made the kind install-level because it looked similar to backup-failed.`

### 11.7 Sample run coverage

Each slice that adds or changes a frontend-called route adds its sample executor and `SEEDER_ROUTES` entry in the same commit, so `test_frontend_route_coverage.py` passes at each slice.

### 11.8 Final verification (owner-owned S19, S20)

1. Seed Harbor Small and School Small into one install.
2. Sign in as members of each. Confirm that no list, search, event, file, or notification crosses organizations.
3. Run the Realtime probe from S12 against the seeded install.
4. Run the full review.
5. Run `python3 scripts/prepush.py --base main --serial`. Record the runtimes.

### 11.9 Handoff to acceptance

When no implementation slice is left, write a "Handoff to acceptance" checkpoint in the run record:

- branch and HEAD,
- the commits of each finished slice,
- the blocked slices, with evidence,
- the implementation decisions under section 11.6,
- the Cloud tag of each slice,
- the memory figures from S01 and S11,
- the D23 result and the Cloud verification state,
- the known issues, and the checks deferred to S19 and S20.

Stop the Next and test servers you started. Leave the development Supabase stack and the API running. Leave the tree clean.
