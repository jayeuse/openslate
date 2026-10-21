# Self-hosted Supabase migration

Status: Implementation in progress. A guarded production Compose restore/recovery rehearsal has passed using Linux containers on macOS Docker Desktop. Native Linux host boot/reboot and Windows acceptance, the canonical pre-push gate, and final review remain pending; this is not general production approval.

Source baseline: `26413df79efc8f223415c9c23305d1a0afb4a7e3`.

## 1. Outcome and agreed boundaries

Replace the standalone PostgreSQL/pgweb development topology, FastAPI-owned password authentication, and direct filesystem file adapter with a self-hosted Supabase stack. Each customer has an isolated installation. Supabase authenticates people; FastAPI decides their application access.

Agreed decisions:

- Windows and Linux servers, Docker Compose first. Windows runs Linux containers through Docker Desktop/WSL2. Native installers and service bundling are outside this migration. Drop macOS as a supported server target; this does not require deleting unrelated workstation tooling.
- Windows runtime acceptance is explicitly pending by user decision: no Windows test host is available yet. Implement and document the Windows path, but leave startup, reboot, persistent-volume recovery, and restore checks unverified until executed on Windows. Linux-container evidence from another operating system does not satisfy those checks.
- Fresh application database, accounts, and files. No legacy account/password/data import and no seamless session migration. Fresh-start scope is not permission to delete an existing volume automatically.
- Email-only password login, invitation-only onboarding, and Supabase email invitations/password recovery. Preserve session listing/revocation, application authorization, account eligibility, and privileged-action reauthentication.
- Supabase Database, Auth, Storage, Studio, and Realtime are implemented services. OpenComms now adds private event/topic and HTTP contracts; its complete integrated S32 acceptance remains pending. Preserve working SSE for the other application invalidations.
- Retain synchronous SQLAlchemy, audited ORM transactions, Alembic, the static Next.js export, FastAPI, and Caddy.
- No antivirus file scanning (decided 2026-10-05). FastAPI validates each upload's file type, and the file is ready when its upload request finishes.

Supabase Database is PostgreSQL. This replaces its distribution and operating topology, not the relational engine. Self-hosting also retains responsibility for patching, capacity, backups, email, and availability. Supabase Storage will initially use its supported file backend on a persistent volume; OpenSlate accesses bytes through the Storage API rather than reading that volume directly.

## 2. Current code and effort

| Boundary | Source evidence | Migration impact |
| --- | --- | --- |
| Database | `backend/app/core/database/session.py`, `backend/migrations/env.py` | Keep SQLAlchemy and transaction behavior; change provisioning, target verification, and migration isolation. |
| Local infrastructure | `compose.yaml`, `scripts/dev.py`, `scripts/environment.py`, `backend/app/core/config/instance.py` | Current admission verifies a particular `postgres:` container, volume, cluster name, database, and role. Supabase needs equivalent owned-instance admission, not bypassed checks. |
| Database privileges | `backend/operations/provision_database_role.py`, baseline revision `1ae6c84fce12` | Current provisioning changes database ownership and PUBLIC privileges; the baseline revokes privileges across `public`. Do not apply this indiscriminately to Supabase-owned objects/services. |
| Authentication | `backend/app/systems/access/identity/`, `backend/app/common/dependencies/auth.py`, `frontend/src/lib/auth-api.ts` | Local hashes, JWTs, refresh replay handling, invitations/recovery, account setup, session administration, and cookies require replacement or adaptation. |
| Authorization | `backend/app/systems/access/policy/authorization.py`, user/role models and permissions | Preserve application IDs, roles, groups, Workspace rules, Board grants/audiences, and Report recipient checks. |
| Files | `backend/app/systems/platform/files/providers.py`, `storage.py`, `service.py`, `purge.py` | A usable storage protocol already exists; preserve immutable keys, integrity checks, and reconciliation. |
| Events | `backend/app/systems/platform/events/` and audit listeners | Existing direct PostgreSQL LISTEN/NOTIFY feeds authorized SSE. Keep this functioning on Supabase PostgreSQL. |
| Operations and tests | `backend/tests/postgres_runtime.py`, `fullstack_runner.py`, reset operations, `packaging/backup/` | Replace container assumptions and local-file inventory; prove restore of provider identity and Storage bytes as well as application data. |

The previous Supabase implementation exists before Git commit `4e31b4d`, but it predates newer authorization, local session behavior, and static deployment changes. Use it as a reference for individual adapters; do not revert or wholesale cherry-pick it.

Planning estimate for one experienced engineer familiar with this repository:

| Work unit | Engineering days |
| --- | ---: |
| Compose, configuration, ownership guards, database/schema setup | 3–5 |
| Authentication, onboarding/recovery, session and frontend adaptation | 5–8 |
| Storage adapter, reconciliation and cleanup | 3–5 |
| Reset, backup/restore, Windows/Linux operating procedures | 3–5 |
| Integrated tests, security review, documentation and release rehearsal | 4–7 |
| Total | 18–30 |

Budget roughly **4–6 engineering weeks**, allowing **5–7 calendar weeks** for integration surprises and review. A developer milestone with real login, CRUD, and file upload/download should be achievable earlier, approximately 1–2 weeks, but is not client-release readiness. These are judgment-based estimates, not measured task durations. Realtime features and native installers are excluded. Windows container behavior, provider/session failure handling, and restore validation are the largest uncertainties.

## 3. Target architecture and contracts

### Deployment and database

- Maintain one versioned Compose definition for Supabase services, with development and production overlays. Pin the official self-hosted release and image digests; use `self-hosted/v0.8.2` as the initial reviewed reference, not floating `latest`. Preserve its necessary initialization assets and service dependencies.
- Required services are Supabase PostgreSQL, Auth, Storage, API gateway, Studio and postgres-meta, plus PostgREST/imgproxy where required by the selected upstream Storage configuration. Run Realtime for private channels (see Realtime boundary). Disable Edge Functions and optional analytics. Use direct internal PostgreSQL connections, so a pooler is unnecessary for the first topology.
- Development retains host-run FastAPI/Next. Production Compose runs the unified FastAPI/static-UI image and Caddy alongside Supabase. Studio is an operator-only administration surface, loopback-bound and password protected. It replaces pgweb but is more privileged than the former read-only inspector.
- Keep application HTTP traffic same-origin through FastAPI. Keep database, Storage, PostgREST, metadata, and administrative APIs on private networks. Expose only the Auth paths necessary for email verification through the configured TLS ingress; never expose the entire administrative gateway as a shortcut.
- Generate unique secrets per installation. Keep database owner/bootstrap credentials, Auth administration keys, Storage keys, and refresh-token encryption material out of frontend builds, the public Manager configuration, logs, and shared examples.
- Preserve `DATABASE_URL` for the constrained runtime role and `MIGRATION_DATABASE_URL` for the application owner. Supabase service roles retain their own databases/schema privileges. Do not transfer ownership of the provider database or revoke provider-wide access. Ordinary domain queries never use a service-role API key.
- Preserve application table names and the current `public` placement to avoid an unrelated schema move. Deny `anon` and `authenticated` application-table access; do not expose application tables through Data API/GraphQL routes. Verify grants and actual bypass attempts independently of gateway routing. These are coarse boundary protections, not a duplicate implementation of roles/groups in RLS.
- Use a fresh-install Supabase Alembic lineage generated from the final application models, including required seeds, constraints, indexes, and narrowly scoped grants. Preserve old applied revisions as historical files outside the active version path; do not edit them or silently stamp existing databases. The new initializer refuses a populated legacy installation. Alembic reflection/checks explicitly include application-owned objects and exclude Supabase schemas/objects.
- Supabase owns `auth`, `storage`, and other provider schema initialization/upgrades. Alembic owns application schema evolution. Do not add a second application migration system or modify provider tables through ORM models.
- Replace ownership checks with installation-specific Compose project/container/volume/image and live database identity checks. Test manifests remain run-specific and reject personal/customer targets. Database, Auth URL, and Storage URL must resolve to the same admitted installation.

### Authentication and application sessions

- Keep `/api/auth/*` as the frontend boundary. FastAPI delegates password verification, token issuance/refresh, password updates, and email action verification to Supabase Auth. Remove local password hashing and local access-JWT issuance.
- Fresh installations explicitly use provider refresh-token algorithm version 2, rotation enabled, a 10-second reuse interval, and unrestricted reuse disabled. Exercise older-ancestor replay after the latest rotation's grace window and require provider-session invalidation, while preserving the provider's immediately preceding-token recovery exception. Do not rely on the pinned release's legacy algorithm default for this contract.
- Add a unique nullable `supabase_user_id` to the application user model. Keep the existing `users.id` for every application relationship and audit actor. Pending invitations and service identities can remain unbound; an interactive session requires an explicitly bound, eligible human profile. Do not create application access merely because a provider user exists or its email matches a row.
- Verify provider JWT signature, configured issuer, audience, expiry, subject and session ID using the installation's public JWKS. Configure asymmetric signing in the pinned self-hosted stack. Reject another installation's JWT and do not accept provider `role` or editable metadata as an OpenSlate role.
- Retain application session rows for CSRF, expiry, device information, immediate revocation and existing session screens. Bind each row to the provider subject/session. A JWT is necessary but not sufficient: each request also checks the application session and current user/authorization state.
- Keep provider access tokens in Secure/HttpOnly cookies. Use a high-entropy opaque HttpOnly refresh handle, stored only as a digest, backed by an application session record containing the encrypted provider refresh token. The handle remains stable until session expiry/revocation; Supabase rotates the provider refresh credential. Serialize refresh for that session across processes, persist the latest token pair, and reuse a freshly obtained access token for concurrent refresh requests. Do not put provider refresh tokens in JavaScript storage. An ambiguous provider-refresh/DB-commit failure fails closed and requires login instead of replaying stale credentials blindly. This deliberately replaces local JWT-refresh replay semantics with provider rotation plus a revocable server-managed session.
- Preserve the API session identity and user ID shapes consumed by the frontend. CLI bearer endpoints delegate to the same provider and local session admission; reject mixed bearer/cookie credentials. Refresh handles and JWT formats are intentionally incompatible with old sessions.
- Logout, self/admin session revocation, account disablement and password recovery revoke application sessions immediately. Provider sign-out follows, with bounded durable retry on provider failure. A valid but locally revoked JWT remains denied. Provider-only administrative changes must also be detected through provider user/session validation; use a narrowly scoped read-only provider session check if required for immediate session deletion detection, never provider-table writes. The operator provisions `openslate_session_liveness`, a SELECT-only policy on provider-owned `auth.sessions` for `openslate_app`, together with grants limited to `id` and `user_id`. This permits the verified JWT session-existence check under Supabase RLS without granting Auth mutation, extra columns, or moving application authorization into RLS. Alembic continues to own application schema only.
- Keep authorization reads authoritative in FastAPI on every request and in existing stream/policy rechecks. Preserve last-admin protections, guest expiry/sponsors, service identity rules, and account-switch/draft boundaries.

### Onboarding, recovery and frontend changes

- Change login input/API from `identifier` to `email`; keep usernames only where they are useful profile labels. Remove temporary-password onboarding, local action-token generation, local password hash tables, and the custom credential-email delivery worker/outbox after their callers are replaced.
- Keep administrator-controlled invitation eligibility, roles and groups in OpenSlate. Persist a pending invitation/profile before requesting the provider invitation; persist the returned subject mapping. Failure leaves a visible retryable pending state, never an active unbound profile. Provider success followed by application failure is reconciled by the explicit invitation operation, without trusting email alone for automatic account linking.
- Preserve resend after a revoked invitation link is attempted. Supabase can confirm the provider identity before local admission rejects the action, making another `/invite` fail. The implementation must replace only the exact owned provider identity of a still-pending local profile when that provider identity is confirmed. Keep the local profile and invitation operation marker; retain the old provider ID until the replacement invitation and new binding are committed. An authoritative old-ID 404 permits exact-marker recovery after a partial failure; authorization errors, timeouts, malformed responses, ambiguous matches, or mismatched ownership never permit deletion or email-only linking. Serialize against acceptance, revocation and profile deletion, and prove old-link replay denial plus partial-failure recovery on disposable accounts. This is a required behavior, not a claim that replacement has passed acceptance.
- Configure Supabase invitation/recovery email templates to return users to OpenSlate confirmation pages with `#token_hash=...&type=invite` or `#token_hash=...&type=recovery`. Fragment transport keeps credentials out of the initial document request and server logs. Exchange the provider token hash through the corresponding FastAPI endpoint after explicit form submission; do not let link preview GETs consume the credential. Clear action credentials from the URL, use no-referrer/no-store behavior, and never grant a full application session from a recovery token alone.
- Invitation completion sets the provider password and then activates the authorized application profile. Recovery resets the provider password and invalidates existing application sessions. Email/password changes reverify identity and preserve non-enumerating errors and rate limits.
- Require configured SMTP for customer invitation/recovery readiness; use an isolated mail catcher for development/tests. No silent temporary-password fallback. Replace the old local elevated recovery operation with a guarded provider-admin recovery action; it must preserve local-admin checks and audit the action.
- Adapt login/setup/recovery screens and invitation status to the new contract. Remove obsolete temporary-secret and local delivery-status controls while retaining useful account and session controls. Do not redesign the Access page.
- Replace lifecycle `LocalPasswordGrantClient` with a fresh Supabase password verification of the current actor for close and purge, including file purge. Map the verified provider subject back to the same application ID, retain challenge expiry/digest/locks, and discard/revoke any temporary verification session. Wrong actor/password or provider failure never permits the protected operation.

### Files and consistency

- Implement Supabase Storage against the existing `StorageBackend` protocol. Use one private bucket, `openslate-ready`; preserve opaque immutable keys and forbid overwrites. No public bucket or direct browser upload/download in this phase.
- All ordinary files, Board files and workspace logos continue through FastAPI authorization and file state checks. Use a server-only Storage client with no mutable shared user session. A private bucket plus a privileged key does not itself enforce OpenSlate permissions.
- Preserve upload-intent commit before external upload, file-type validation in a bounded subprocess before the Storage write, bounded errors/timeouts, and orphan reconciliation. An upload commits ready metadata in the same request after the Storage write succeeds; pending metadata never permits user download.
- Treat an uncertain upload as a cross-service reconciliation: read the exact object from the ready bucket and verify its size and SHA-256 before committing ready metadata. Do not treat an object-store ETag as the application's SHA-256. A missing or conflicting object fails closed.
- Deletion removes the object, confirms absence and preserves the existing durable deleting/uncertain states. Provider outage or partial deletion remains visible and retryable.
- Durable files belong only to the Supabase Storage volume, with bytes bounded by current upload limits.
- Remove the POSIX/Windows application storage adapters and filesystem-specific tests after equivalent protocol behavior passes against real Storage. Do not retain a selectable local-storage product mode.

### Realtime boundary

Keep `/api/events`, opaque invalidations, reconnect behavior, and per-user authorization. Connect its LISTEN subscriber directly to Supabase PostgreSQL; do not route this session-affine connection through transaction pooling.

Realtime runs in every stack (foundation plan S11, S12; decisions D22, D23, D24).
The implemented self-hosted design uses candidate A of D23, extended by OpenComms
grants and the same-origin browser path. Service/native component evidence does
not establish complete S32 browser/provider-pack, load, release-gate or target-OS acceptance:

1. The browser asks FastAPI for a channel token: `POST /api/realtime/token` with `X-Org`. FastAPI admits the request through the normal session and membership checks (session, organization, MFA, IP policy).
2. FastAPI signs a 5-minute ES256 token with its own key, `REALTIME_TOKEN_SIGNING_KEY`. The claims are `role: authenticated`, `sub` (local account id), `org_id`, `purpose: realtime`, `iat`, and `exp`. Only the public key is in `JWT_JWKS`. Supabase Auth signs and publishes only `JWT_KEYS`, so FastAPI and `/auth/v1/user` refuse the token.
3. The browser opens the same-origin `/realtime/v1/websocket`, then joins private channels with the token in the join payload. Production Caddy validates the exact origin/upgrade and injects the gateway `apikey` header; the browser does not send a gateway key in a query string. Daily development uses the existing host-run frontend launcher upgrade proxy, not a Caddy requirement or a new FastAPI WebSocket route. Its exact origin uses the configured development hostname and `FRONTEND_DEV_PORT`; HTTP `/api` still reaches loopback FastAPI at the configured `BACKEND_PORT`.
4. RLS on `realtime.messages` uses `public.can_join_realtime_topic(topic)`. The function requires `purpose: realtime` and an active, eligible account/membership in the claimed organization. Conversation joins additionally require a live, unarchived conversation and an unexpired `comms_realtime_grants` row produced by FastAPI's current access projection. This table backs join admission; it is not a separate content-authorization policy.
5. Product topics are `org:<org>:conversation:<id>`, `org:<org>:user:<local-user-id>` for that user only, and `org:<org>:presence`. Unknown suffixes are refused. Browser Comms subscriptions are read-only: the INSERT policy retains only the foundation `org:<org>:probe` exception, not client message/presence/typing publication.
6. FastAPI stages opaque private envelopes in the audited transaction. Request-buffered events publish after commit and response completion; resource-owned durable jobs submit committed events after closing their own SQL session, independently of any triggering HTTP response, including manual Send Now. Neither path retains a session or pooled connection through HTTP publication. The bounded HTTP publisher uses the separate `api-gw:8001/realtime/v1/api/broadcast` listener with the server key. It is unpublished in production and loopback-mapped by `SUPABASE_REALTIME_PUBLISH_PORT` in development. Neither Caddy nor the public gateway listener exposes this publisher route. Delivery is best effort; authoritative content remains on current-authorized HTTP reads.

Provisioning (`provision_database_role.py`, as `supabase_admin`) manages the recognized policies,
because Realtime owns `realtime.messages`; it requires a healthy Realtime service and refuses
unexpected policy drift. Alembic revision `071607de0f40` replaces the initial deny-all application
function, and forward revision `8410bb7874ff` adds the Comms topic/grant checks. Applied revisions
remain immutable. Sources: [grant projection](../../backend/app/systems/comms/realtime/grants.py),
[publication wrapper](../../backend/app/systems/comms/realtime/publication.py),
[Caddy ingress](../caddy/Caddyfile.template), [development launcher](../../frontend/tooling/run-next.mjs)
and the [operator boundary](README.md#opencomms-ingress-and-private-publication).

Limits that stay: after membership/access removal, HTTP content is refused immediately, while
already-joined ID-only subscriptions may persist until token expiry (at most five minutes).
New joins recheck membership and grants. OpenSlate sends nothing on public channels. A Realtime
token is not an ordinary Auth/API credential; Storage has no content policy granting this
`authenticated` role access. Supabase Cloud imported-key handling remains unverified and needs
owner-authorized Cloud evidence; candidate B is a future option, not a configured fallback.

Database row-change subscriptions stay off. SSE continues to carry opaque invalidations for
other pages, while Comms uses the private topics above. Browser connection coordination does not
change HTTP authorization. The `/comms` page and its administrator tools call the protected
backend routes; no browser-local example tools remain. Native Linux/Windows acceptance and the
full integrated browser/provider, load and purge-timing measurements remain deferred; see
[acceptance status](README.md#acceptance-status).

## 4. Delivery sequence

1. **Contract and foundation:** lock this spec; inventory preserved tests; pin upstream artifacts; implement isolated Supabase startup, secrets, application role provisioning, fresh Alembic lineage and target guards. Prove a blank installation and application CRUD/audit with Supabase services intact.
2. **Auth vertical slice:** drive email login, provider verification and local session admission with real Auth tests, then implement refresh/logout/revocation. Add invitations, recovery, profile binding, reauthentication and their frontend flows. Remove replaced local-identity code only after all callers are migrated.
3. **Storage vertical slice:** implement upload/validation/download first, then upload failures, purge and reconciliation. Auth and Storage editing can proceed independently after shared configuration contracts settle; serialize shared model/config changes.
4. **Operations:** replace pgweb commands with Studio; adapt bootstrap, seeding, reset, health/readiness, backup and restore; remove old Compose PostgreSQL services, inspector role/passfile setup, and direct-filesystem operating assumptions. Preserve unrelated gateway and Manager behavior.
5. **Integration and release evidence:** update test runners/classification/CI, verify Windows and Linux Compose, run the canonical gate once, review trust boundaries, and publish the operating runbook. Update current-state architecture and scoped guidance only when the corresponding implementation is verified.

Keep coherent commits per work unit, including relevant tests. Use the current SDD → TDD → review/verification rules. Decompose this migration into bounded slices rather than adding a generic provider framework.

## 5. Operations and cutover

- Development and tests use disposable isolated instances of the same pinned self-hosted stack, not a hosted project. Separate ports, networks, volumes, keys, mail catcher and run manifests for concurrent work. Keep teardown limited to the owned run.
- Startup order: validate configuration/ownership → start provider database and initialize Supabase services → provision app roles/schema → create the private bucket → bootstrap invitation → start API → check readiness. Migration/provisioning are explicit operator steps, not container-entrypoint side effects on every restart.
- Readiness reports Database/Auth/Storage/SMTP configuration state separately. Provider outage produces a useful unavailable state; it is not invalid credentials or a successful upload. No synthetic mutation is needed on every health poll.
- Reset uses Storage APIs to inventory/delete objects with pagination, preserving dry-run, exact plan confirmation, API quiescence, and partial-cleanup reporting. Account cleanup uses Auth APIs. Never delete `storage.objects` rows as a substitute for deleting bytes. Preserve the configured administrator according to the existing reset contract.
- Adapt the encrypted backup foundation to capture a coherent recovery set: application and required provider schemas, Auth users, Storage metadata and bytes, pinned stack versions, and encrypted installation secrets/configuration. Quiesce API, Auth/Storage writes and workers during the first supported backup procedure. A database dump alone is not a complete backup.
- Restore into a fresh isolated target with matching provider versions, then verify login, permissions, file download, session revocation and new writes. Preserve mappings and audit actors; invalidate restored application sessions so users authenticate again. Document scheduled backups, off-host destinations and retention as operator responsibilities until automation exists.
- Fresh cutover uses new named volumes and explicit initialization. Retain the old stopped volumes until separately approved for removal. Before new writes, rollback is switching back to the previous code/configuration/volumes. After new writes, rollback needs a tested recovery procedure and cannot simply switch databases without losing work.
- Support Linux Docker Engine/Compose and Windows Docker Desktop with WSL2/Linux containers, persistent volumes, reboot recovery and documented ports. This is an operator-installed Compose release, not a native Windows service/installer. macOS server certification is removed from the target roadmap/docs.

## 6. Acceptance and verification

Inspect existing coverage first. Reuse it where it proves retained behavior; introduce test-first cases only for new contracts or real gaps. Prefer full browser journeys across real provider services. Use isolated tests for deterministic timeout/partial-commit failure injection that cannot reliably be induced in a browser.

| Scenario | Required outcome |
| --- | --- |
| Blank stack / repeated startup | Provider services and app schema healthy; repeat startup does not recreate data or credentials. Wrong-instance and non-owned reset targets are refused. |
| Database authority | Runtime CRUD/audit works, DDL and audit rewriting fail; browser/public provider keys cannot query or mutate application tables. Alembic drift check ignores provider-owned objects and never drops them. |
| Email login | Valid invited user enters workspace; username login, unknown email, wrong password and provider outage have the intended distinct/non-enumerating behavior. |
| Identity binding | Valid JWT from wrong instance, unmapped subject, disabled/expired user, or ineligible service identity is denied. Provider metadata cannot elevate a role. |
| Session races and revocation | Concurrent refresh across tabs/processes is consistent; expired/revoked handles, logout, self/admin revoke and recovery deny subsequent requests even with an unexpired JWT. Failed provider sign-out cannot restore local access. Provider refresh-token replay protection is exercised separately. |
| Invitations / recovery | Email link completes once; preview GET does not consume it; expired/replayed link fails; partial provider/application failure is recoverable without duplicate users or grants. |
| Authorization regression | Existing role/group/Workspace deny, Board visibility, Report audience, guest expiry and last-admin restrictions remain enforced. |
| Privileged operation | Correct actor/password can satisfy the existing purge challenge; wrong actor, stale proof or unavailable Auth cannot. |
| Files | Authorized upload → file-type validation → ready download works; guessed keys, unauthorized users, files with a disallowed or mismatched type, and direct provider requests cannot expose bytes. |
| Storage failures | Upload timeout, duplicate retry, uncertain upload, digest mismatch and partial delete converge safely under existing reconciliation. |
| SSE | Cross-process invalidation/refetch works on the new DB; denied/revoked users receive no protected payloads and reconnect rechecks access. |
| Restore / operating systems | Windows and Linux startup/restart work; isolated restore proves Auth, application relationships, file bytes and subsequent writes together. |

Adapt `backend/tests/postgres_runtime.py` and `fullstack_runner.py` to runner-owned Supabase rather than weakening ownership guards. Update real Auth fixtures, SMTP capture and Storage fixtures. Keep retained targeted HTTP/isolated tests, frontend static checks/build, and backend 90% overall and changed-line coverage gates. Run each applicable full suite at its owning gate; repair narrowly and reuse valid passing evidence.

Final integration command remains `python3 scripts/prepush.py --base <recorded-base>`, after updating its change classification and provisioning to the new stack. Retain E2E command, working directory, revision, prerequisites, result and trace/report paths. Windows evidence must come from a Windows host; a Linux container on the current workstation is not Windows acceptance.

Implementation evidence is recorded in `.agent-runtime/supabase-implementation.md`. Provider checks do not establish complete application or operating-system acceptance; each outstanding criterion must be resolved independently.

## 7. External references

- [Supabase self-hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker): deployment responsibilities and published resource baseline. Current guidance lists 4 GB RAM/2 cores/40 GB SSD minimum and 8 GB+/4 cores+/80 GB+ SSD recommended for Supabase components; budget additional capacity for OpenSlate and customer data, then measure.
- [Pinned self-hosted Compose reference](https://github.com/supabase/supabase/blob/self-hosted/v0.8.2/docker/docker-compose.yml): service dependencies, PostgreSQL distribution and file-backed Storage configuration.
- [Self-hosted asymmetric authentication](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys): configure and verify JWKS, signing keys and server-only API keys.
- [Auth sign-out](https://supabase.com/docs/reference/javascript/auth-signout): issued JWTs remain usable until expiry without an additional revocation check.
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control): privileged service keys bypass RLS, so backend permission checks are mandatory for this design.
- [Connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres): persistent/direct connections and transaction-pooling limitations.
- [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization): private-channel policy evaluation and cached authorization matter before any future direct browser subscription.
