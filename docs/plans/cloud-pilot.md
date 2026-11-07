# Cloud pilot deployment

Status: **proposed**. Nothing here is built or deployed. Work starts after Database Improvements (Part 1), Sandbox as Heart (Part 2) and System Observability (Part 3) are done. Pull request 2d of Part 1 is deferred (database plan D18), so it does not gate this plan.

This plan is the pilot scope of Phase 3, "Cloud launch", from the Supabase integration decisions of 2026-10-15 (cloud on Supabase Cloud, with FastAPI as a container near the Supabase region). The code work in step C is therefore part of the planned cloud target. It is not a temporary pilot fork. The on-premise-first priority does not change.

## Progress

Checked on 2026-11-07.

| Item | State |
|---|---|
| Part 1, Database improvements | Pull requests 1 (#81), the follow-up (#91) and 2a (#94) are merged. 2b, 2c, 3a, 3b and 4 remain, in that order. 2d is deferred (D18). No decision is open. |
| Part 2, Sandbox as Heart | The direction is agreed. The spec `docs/specs/sandbox-department-setup.md` is proposed. No slice is built. |
| Part 3, System observability | Client side merged: slices S1 to S6 of `docs/specs/system-health.md` (#87, #88, #89). The developer side is deferred. |
| Rebrand to Slate Operations | Done (pull requests 84 and 85). This plan uses the new names, for example `SLATEOPS_INSTANCE_ID`. |
| This plan | Proposed. No phase has started. Phase −1 waits for decision D5. |

## Outcome

A small number of pilot organizations use Slate Operations at `https://app.slate-operations.com`. One installation holds all pilots as organizations. The API and the static frontend run on one EC2 instance. Supabase Cloud supplies the database, Auth, Storage and Realtime. The cash cost is the domain only, while the AWS credits last.

### Exclusions

- Self-serve sign-up, plans, billing and the operator console (later Phase 3 work). Pilots get access by invitation only.
- High availability. One instance and one free Supabase project are single points of failure.
- The in-app backup feature. It backs up Docker volumes and does not apply to Supabase Cloud (see C8).

### Preserved behavior

- FastAPI stays the only way into application data. The only exception stays the short-lived Realtime token.
- Every application control in production mode: Secure cookies, exact-origin CSRF, the allowed host list, API docs off, rate limits, and audit.
- The self-hosted stack and the on-premise procedures do not change. Cloud support is an added mode, not a replacement.

## Target topology

| Part | Service | Monthly cost |
|---|---|---|
| Domain and DNS | Cloudflare Registrar and DNS, `slate-operations.com` | About $11.15–11.17 each year (the .com wholesale price went up on 2026-11-01) |
| Server | One EC2 `t4g.small` (Arm, 2 GB), Singapore, Ubuntu arm64, 20 GB gp3, one public IPv4. Runs the API image and Caddy in Docker Compose. | $21.05 from credits (t4g.small $15.48, IPv4 $3.65, disk $1.92) |
| Database, Auth, Storage, Realtime | One Supabase Free project, Singapore | $0 |
| Email | Amazon SES SMTP, Singapore, port 587 | Under $1 at pilot volume (Essentials plan $0.16 per 1,000) |
| Images | GitHub Container Registry (container storage and transfer are free today) | $0 |
| Backups | Cloudflare R2 (10 GB-month free, free egress) | $0 |
| Uptime check | A free external monitor on `/api/ready` | $0 |

## Facts that change the original plan

Checked on 2026-11-02 against official sources. The sources are at the end of this file.

1. **AWS credits.** A new account gets $100 at sign-up and up to $100 more from five console activities, so $200 at most. The claim "$150 gives 7 months" is wrong.
2. **AWS Free plan.** The account closes at 6 months or when the credits run out, whichever comes first. AWS keeps the data for 90 days, then erases it. Remaining credits carry over when you upgrade to the Paid plan. On the Paid plan, $100 lasts 4.8 months and $200 lasts 9.5 months at $21.05 each month.
3. **t4g free trial.** It ends on 2026-12-31 and is probably for Paid-plan accounts only. The pilot starts later, so this plan does not count on it.
4. **SES on the Free plan is not confirmed.** Upgrade to the Paid plan before launch; this also removes the question. Production access takes up to 96 hours.
5. **Supabase Free has no backups.** It pauses a project after 7 days with too little database activity. The docs do not say if a `pg_dump` counts. Real pilot traffic counts.
6. **Supabase Free goes read-only above 500 MB of database size.** Writes then fail for every pilot. This is a hard limit, not a soft warning.
7. **The direct database connection is IPv6-only on Free.** The session pooler (port 5432) accepts IPv4 and supports `LISTEN`. The transaction pooler (port 6543) does not support `LISTEN`.
8. **Supabase Auth.** Invitations work with public sign-up turned off. Custom SMTP starts at 30 emails each hour (configurable). Cloud stores email templates as content in the project configuration; it does not fetch them from a URL.
9. **JWT key import.** Supabase Cloud can import an ES256 private key. The key starts as a standby key and is published in the JWKS. The docs do not say whether Realtime accepts a standby key without a rotation to current. The docs list Realtime as a product that verifies project keys, but they do not say that Realtime accepts an imported key.
10. **The `postgres` role is not a superuser,** and `supabase_admin` is internal only. You cannot create objects in the `realtime` schema; RLS policies on `realtime.messages` can call your own functions.

## Code gaps

Found by a read-only inventory of the current code on 2026-11-02. Size: S is under a day, M is one to three days, L is more than three days or unknown.

| ID | Area | Current assumption (source) | Change | Size |
|---|---|---|---|---|
| C1 | Startup admission | Production requires `POSTGRES_DATABASE=postgres`, an exact host and user (`_configured_production_target`, `app/core/config/instance.py:192`), no URL query (`assert_database_url`, `:341`), and `cluster_name` equal to `SLATEOPS_INSTANCE_ID` (`assert_instance_target`, `:365`). Development mode needs a live local Docker container (`assert_live_docker_ownership`, `:241`). Cloud cannot set `cluster_name`, and needs `?sslmode=require`. | Add an external-provider mode that replaces the cluster marker check with a project-reference check, and that accepts `sslmode`. The API startup (`app/main.py:106`), Alembic (`migrations/env.py:41`) and role provisioning (`provision_database_role.py:451`) all stop without this. | S |
| C2 | Provider admission | Production requires `db:5432` and `SUPABASE_URL=http://api-gw:8000` (`app/core/config/provider_instance.py:29-33`, `infra/supabase/compose.production.yaml:33`, `:45`). `provision_storage.py:42` and `check_file_storage.py:161` call the same check. | Accept `https://<ref>.supabase.co` in external-provider mode. | S |
| C3 | Connection path | The pooler needs the user name `<role>.<ref>`, but provisioning compares the URL user name with the role name exactly (`operations/provision_database_role.py:55-58`). The connection startup sends `options=-c statement_timeout=…` (`app/core/database/session.py:38-41`), which the pooler can refuse. | Decision D2. With IPv6 direct connections, this row goes away. With the pooler, accept the tenant suffix and move the timeout to `ALTER ROLE … SET` or a `SET` after connect. | S–M |
| C4 | Provisioning as `postgres` | Policies on `realtime.messages`, REVOKEs on `realtime.send` and schema `realtime`, and a column grant and policy on `auth.sessions` (`provision_database_role.py:206-322`). The request path reads `auth.sessions` with SQL (`session_credentials.py:37-49`). | Run it in spike S1. If `postgres` cannot do the `auth.sessions` part, replace the SQL read with a cached Auth admin API call. | M–L |
| C5 | Realtime token trust | FastAPI signs the Realtime token with `REALTIME_TOKEN_SIGNING_KEY` (ES256). Self-hosted Realtime trusts it through `API_JWT_JWKS` and the tenant `realtime-dev` (`app/systems/platform/realtime/tokens.py:45-66`, `infra/supabase/compose.yaml:218-232`). `infra/supabase/PLAN.md` marks the Cloud key import as unverified. | Import the key as a project signing key. Prefer standby state (spike S2). If Realtime does not accept it, see decision D3. | L |
| C6 | Browser Realtime path | Caddy proxies same-origin `/realtime/v1` to `api-gw:8000` and adds the publishable key (`Caddyfile.template:20-58`). | Proxy to `https://<ref>.supabase.co` with TLS and a Host rewrite. Keep the origin check. | M |
| C7 | Auth configuration | Site URL, redirect list, sign-up off, SMTP, refresh-token rotation, JWT expiry 900 s and the template URLs live in `infra/supabase/compose.yaml:52-87`. The API serves the templates for Auth to fetch (`template_router.py`). | Write one operator command that pushes the same settings and the template content through the Management API (`PATCH config/auth`). Site URL must equal `PUBLIC_ORIGIN`. Turn on TOTP MFA. | S–M |
| C8 | Backups | The backup runner makes offline Restic archives of Docker volumes with every container stopped (`packaging/backup/`). The in-app backup feature needs `cluster_name` to equal `SLATEOPS_INSTANCE_ID` (`installation_id`, `app/systems/manage/backups/service.py:46-56`). | Hide the backup controls in external-provider mode. Add `operations/cloud_backup.py`: `pg_dump` (PostgreSQL 17 client), a copy of both Storage buckets through the S3 endpoint, encryption, upload to R2, and a status record that the Part 3 health page can read (see "Dependencies on Parts 1 to 3"). | M–L |
| C9 | Readiness | Probes `/auth/v1/health` and `/storage/v1/status` with timeouts of 1–2 s (`app/core/readiness.py:139-171`). Over the internet, a TLS round trip can use most of that. | Raise the timeouts in external-provider mode, and check that the Cloud Storage status route exists. | S |
| C10 | Compose and TLS | The production overlay depends on `db` and `api-gw` and the provider networks. Caddy supports only `internal` and `custom` TLS (`infra/caddy/generate_config.py:130-143`). | Add a standalone API and Caddy Compose file that keeps the `app-private` subnet, so forwarded client IPs and rate limits stay correct. Add an ACME (Let's Encrypt) TLS mode. | M |
| C11 | Image build | CI builds amd64 only, with `push: false` (`.github/workflows/backend.yml:279-298`). File-type validation is pure Python. | Build amd64 and arm64 with buildx and push to GHCR on a release tag. Never build the frontend on the 2 GB instance. | S |
| C12 | Memory | One worker, `FILE_MEMORY_BUDGET_MIB=256`, 4 file slots, 512 MiB address limit for each validation child (`app/core/config/settings.py:159-169`). | Set `FILE_PROCESSING_SLOTS=2` and a budget of 128 MiB, add 2 GB swap, and measure the API memory on a Large sample pack before launch. | S |

## Spikes

Use one scratch Supabase Free project with no real data. The account must have a free project slot (Free allows 2 active projects). Delete the project after the spikes. Record each result in this file.

S1, S2, S4 and S5 need only Supabase. They are the go or no-go gate, and they come before any account for the pilot exists. S3 needs an EC2 instance, and it settles D2 before the code work. S6 needs the domain and SES, so it is the last step of the email phase.

**The current code stops S1.** Each command in S1 goes through the guards in C1 and C2: the API startup, Alembic, role provisioning and Storage provisioning. Development mode needs a local Docker container. Production mode needs a `cluster_name` that Cloud does not have, and a URL with no `sslmode`. So do the spikes in this order:

1. S2, S4 and S5. They run no application command. S2 needs one short script that signs a token with the same claims as `mint_realtime_token` (`app/systems/platform/realtime/tokens.py:45`), and one test policy on `realtime.messages` that you make in the SQL editor. S5 uses two test buckets that you make in the dashboard.
2. C1 and C2 on a branch. They are small, and every cloud outcome except D3 option B needs them. Add the C3 user-name change if the spike machine has no IPv6 and must use the pooler.
3. S1 on that branch.

**Who runs the spikes (SEC-R8).** Rule SEC-R8 in `SECURITY.md` lets a tool test only a local stack that the user runs. A scratch Supabase Cloud project is not a local stack. So today an agent cannot run S1, S2, S4 or S5. See decision D5.

| ID | When | Test | Pass condition | If it fails |
|---|---|---|---|---|
| S1 | Phase −1, after C1 and C2 | Run `provision_database_role.py`, `alembic upgrade head`, `alembic check` and `provision_storage.py` as `postgres`. Then upload and download one file through FastAPI's Storage client. | All four finish, the Realtime policies and the `auth.sessions` grant exist, and Storage accepts the `sb_secret_` key as a Bearer token (`supabase_storage.py:66-67`). | Size C4 as L and plan the Auth admin API read. For Storage, use the legacy `service_role` JWT. |
| S2 | Phase −1 | Import FastAPI's ES256 key and **leave it in standby**. Join one private channel with a token that the spike script signs with that key. Only if that fails, rotate the key to current and repeat. | The join succeeds on a topic that the test policy allows, and the same token is refused on a topic that it does not allow. | Decision D3. |
| S4 | Phase −1 | Read the pooler pool size in Database settings. The pooler shares one server-side pool between ports 5432 and 6543, so the size applies to all clients. | The API pool, the `LISTEN` connection, migrations, the backup and one operator command fit with headroom. | Lower the API pool, and run backups only when no migration runs. |
| S5 | Phase −1 | Copy both test buckets with S3 access keys. | The object lists and sizes match on both sides. (`check_file_storage.py` cannot run on Cloud before C2.) | Copy through the Storage API with the secret key. |
| S3 | After Phase 1 | Launch a `t4g.micro` in a dual-stack subnet for one hour, and connect to the direct connection. | `LISTEN` works over IPv6, and the 60-connection limit applies. | Use the session pooler, and do C3 in full. |
| S6 | End of Phase 3 | Send one invitation through SES SMTP with the pushed template. | The link opens `app.slate-operations.com`, and the invitation completes. | Fix the Site URL or the template variables. |

Go: S1 and S2 pass. No-go on S2: decision D3.

**Why standby comes first (security).** Self-hosted Realtime trusts FastAPI's key through its own JWKS, apart from Auth's key. Supabase Cloud has one key set for the project. If FastAPI's key becomes the **current** key, Supabase Auth signs every user access token with a private key that FastAPI holds, and Storage and the Data API accept tokens that FastAPI signs. This removes the token boundary in [`infra/supabase/PLAN.md`](../../infra/supabase/PLAN.md) (Realtime boundary). Under SEC-R6, that change must be stated and reviewed. A standby key is published in the JWKS but does not sign Auth tokens, so it keeps the boundary if Realtime accepts it.

## Dependencies on Parts 1 to 3

These parts are not finished. Each one must stay compatible with external-provider mode, or record why not.

| Part | Item | Cloud effect |
|---|---|---|
| 1 | Step 4.1 server settings (`shared_buffers` and others), pull request 4 | Not settable on Supabase Free. Keep them in `infra/supabase/compose.production.yaml` only. |
| 1 | Steps 1.5 (schedule), 2.6 and 2.7 run from the backup runner with the owner role, pull request 2d (deferred, D18) | The cloud topology has no backup runner. Run them from `cloud_backup.py` or a systemd timer with the migration role. |
| 1 | Step 2.6 archive needs a verified Restic snapshot before a drop, pull request 2d (deferred, D18) | Use the verified R2 upload as the equivalent proof. |
| 1 | Steps 4.5 and 4.6 Auth settings in `compose.yaml`, pull request 4 | Push them with the C7 command. The Auth audit table is in the `auth` schema; check in S1 that `postgres` can delete old rows. |
| 1 | Audit growth with 13 months online, plus seals | Counts against the 500 MB read-only limit (see risk R1). |
| 3 | Backup freshness for admins (spec slice S3) | The slice reads `BackupRun` rows (`app/systems/manage/backups/models.py`). `installation_id()` (`service.py:46-56`) fences that data with `cluster_name`, which Cloud does not have. So `cloud_backup.py` must write `BackupRun` rows, and the C1 project-reference check must also replace the check in `installation_id()`. If not, the health page shows no backups on Cloud, and C8 hides the backup controls. |
| 3 | Installation section (spec slice S5) | Its database size figure is the signal for D4 on Cloud. Keep it readable without `cluster_name`. |
| 3 | Diagnostics export (spec slice S6) | On-premise only. No change. |
| 2 | Sandbox publish | No infrastructure effect. |

## Decisions

| ID | Decision | Recommendation | What it removes |
|---|---|---|---|
| D1 | AWS plan | Upgrade to the Paid plan before launch. Keep Budgets alarms at $10 and $20. | The 6-month account closure and the SES question. After the credits, AWS bills the card. |
| D2 | Database connection | IPv6 direct connection, if S3 passes. The session pooler otherwise. | With IPv6: the C3 changes. With the pooler: nothing, but C3 is needed. |
| D3 | Realtime if the standby key fails in S2 | Owner decision. If only the current key works, record which claims (`purpose`, `aud`, `role`, the 5-minute expiry) make a FastAPI-signed token useless against Storage and the Data API, and get a security review before you choose it. Option A: Pilots use Comms without live delivery; SSE invalidations refetch messages. Option B: self-host Supabase on EC2, which needs 8 GB (`t4g.large`, $67.47 each month, about 3 months of $200). | A: live typing, presence and instant messages. B: most of the credit runway. |
| D4 | Database size | Move to Supabase Pro ($25 each month, cash) when the database passes 350 MB. | The read-only stop at 500 MB, for a cash cost. |
| D5 | Who runs the spikes on Supabase Cloud (SEC-R8) | Owner decision. Option A: you run S2, S4, S5 and S1 yourself, with the steps in this plan, and an agent records the results. Option B: you write a narrow exception to SEC-R8: one scratch project that you own, no real data, keys in an owner-only file outside the repository, and the project deleted after the spikes. Then an agent runs them. Recommendation: B, with the Security Engineer reviewing the exception text. | A: the agent's speed. B: one strict line of SEC-R8, for one project and a limited time. |

## Runbook

Do the phases in order. Tick each step when it is done.

### Phase −1: Supabase spikes

- [ ] Choose D5.
- [ ] Create a scratch Supabase Free project. Only you can create the account and the project.
- [ ] Run S2, S4 and S5, and record the results above.
- [ ] If S2 fails, choose D3.
- [ ] Implement C1 and C2 on a branch, with focused tests.
- [ ] Run S1 on that branch, and record the result.

Caution: do not start Phase 1 until Parts 1 to 3 are done. Creating the AWS account starts the 6-month Free plan clock and the credit expiry.

### Phase 0: code (C1 to C12)

Do this after S3 (run right after Phase 1), because S3 decides D2 and the size of C3.

- [ ] Implement C3 to C12 behind external-provider mode, with focused tests for each. C1 and C2 are done in Phase −1.
- [ ] Before each push, run the fast checks and the focused tests. CI on the pull request runs the full gate (owner decision, 2026-11-02).
- [ ] Release one tagged multi-architecture image to GHCR.

### Phase 1: accounts and domain

- [ ] Buy `slate-operations.com` in the business Cloudflare account.
- [ ] Turn on MFA for the AWS root user, Supabase, Cloudflare and GitHub.
- [ ] Do the five AWS credit activities.
- [ ] Upgrade AWS to the Paid plan (D1).
- [ ] Create AWS Budgets alarms at $10 and $20.
- [ ] Run S3 on a temporary `t4g.micro`, then terminate it. Choose D2.

### Phase 2: Supabase project

- [ ] Create one Free project in Singapore.
- [ ] Import the Realtime signing key, and set its state from the S2 result (standby if possible).
- [ ] Run role provisioning, `alembic upgrade head`, `alembic check` and Storage provisioning.
- [ ] Push the Auth settings and templates with the C7 command. Public sign-up stays off.

### Phase 3: email

- [ ] Verify the domain in SES and add the DKIM records in Cloudflare DNS.
- [ ] Request SES production access. Allow up to 96 hours.
- [ ] Create SES SMTP credentials for Singapore.
- [ ] Set SES as the custom SMTP server in Supabase Auth and in the API environment file.
- [ ] Run S6.

### Phase 4: server

- [ ] Launch a `t4g.small` with Ubuntu arm64 and 20 GB gp3 in a dual-stack subnet.
- [ ] Attach an IAM role for SSM Session Manager.
- [ ] Allow inbound 80 and 443 only. Keep port 22 closed.
- [ ] Attach an Elastic IP.
- [ ] Install Docker and the Compose plugin, and add 2 GB of swap.
- [ ] Copy the environment file to the instance and set it to mode 600.
- [ ] Log in to GHCR with a read-only token.
- [ ] Start the API and Caddy with the cloud Compose file.

### Phase 5: DNS and TLS

- [ ] Add an A record (and an AAAA record if dual-stack) for `app`, as "DNS only".
- [ ] Let Caddy get the Let's Encrypt certificate.
- [ ] Check that `https://app.slate-operations.com/api/ready` returns 200.

### Phase 6: operations

- [ ] Run `cloud_backup.py` each day with a systemd timer.
- [ ] Restore one backup into a scratch project and check it with `check_file_storage.py`.
- [ ] Add the external uptime check on `/api/ready`.
- [ ] Add a weekly database size check against D4.

### Phase 7: pilot onboarding

- [ ] Get a signed pilot agreement from each pilot before access.
- [ ] Run `bootstrap_admin.py --confirm` once for the operator account.
- [ ] Create one organization for each pilot with `create_organization.py`.
- [ ] Invite each pilot administrator from the application.
- [ ] For each new organization, sign in as a testing account and check that no data from another organization is visible.

## Risks

| ID | Risk | Solution |
|---|---|---|
| R1 | The database passes 500 MB and every pilot becomes read-only. | Weekly size check; move to Pro at 350 MB (D4). Keep sample packs out of the pilot project. |
| R2 | One cross-organization leak ends the pilots. | The isolation check in Phase 7 for each organization, before real data goes in. |
| R3 | 2 GB is too small. | Swap, the C12 limits, and a measurement before launch. Resize to `t4g.medium` ($36.52 each month) if memory stays above 80%. |
| R4 | The project pauses after 7 quiet days. | Pilot traffic counts. During quiet weeks, open the dashboard. |
| R5 | A paused or failed Supabase project has no managed backup. | The daily R2 backup, and one restore test before launch. |
| R6 | The pilot runs past the credits. | Budgets alarms. Decide before month 8 whether to pay or to move. |

## Sources

- AWS Free Tier plans and activities: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html
- EC2 free-tier instance types: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html
- T4g trial: https://aws.amazon.com/ec2/instance-types/t4/
- SES pricing and production access: https://aws.amazon.com/ses/pricing/ , https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
- EC2 automatic recovery: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-configuration-recovery.html
- Supabase pricing, pausing and database size: https://supabase.com/pricing , https://supabase.com/docs/guides/platform/free-project-pausing , https://supabase.com/docs/guides/platform/database-size
- Supabase connections: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase signing keys: https://supabase.com/docs/guides/auth/signing-keys
- Supabase Realtime authorization and limits: https://supabase.com/docs/guides/realtime/authorization , https://supabase.com/docs/guides/realtime/limits
- Supabase SMTP and templates: https://supabase.com/docs/guides/auth/auth-smtp , https://supabase.com/docs/guides/auth/auth-email-templates
- Supabase roles: https://supabase.com/docs/guides/database/postgres/roles-superuser
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- GitHub Packages billing: https://docs.github.com/en/billing/concepts/product-billing/github-packages
- EC2 prices: the AWS price feed for ap-southeast-1, published 2026-10-29
