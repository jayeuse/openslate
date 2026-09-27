> Remediation closeout: F1–F6 have focused passing evidence. F7's source-backup restart instructions now preserve prior service state, require scanner inspection, and gate Caddy on readiness; no further review tier or backup rehearsal was run after the user's closeout instruction. The final gate remains incomplete: three invitation-duration contract tests fail, the last measured changed-line coverage is 84.22% (90% required), and the final auth-browser retry stopped at a disposable Storage health-check failure before running tests. Windows and native Linux host acceptance remain pending. The existing production backup/restore rehearsal and unaffected passing checks are retained as scoped evidence, not general production approval.

# Supabase stack implementation review

## 1. Outcome and scope

**Overall: supported BLOCKING FAIL.** The migration has substantial working provider, Storage, scanner, session, reset, and recovery behavior. The current change nevertheless introduces an administrative database bypass, a publication authorization race, and an outage-dependent logout failure. Operator and mandatory static-check failures also remain. Missing acceptance evidence is listed separately from defects.

This was a review-only assignment: no application repairs, migration changes, test authoring, commits, integration, environment provisioning, or deployment were performed. The parent writes this report under the user's explicit requested report path; that instruction overrides the documentation guide's general prohibition on task reports. Only existing installed tools were used. Public-page browser inspection did not submit forms or access email/credentials.

### Reviewed state

- Repository/worktree: `/Users/ceejayferuelo/Programming/Projects/Web-Development/openslate`; shared primary checkout, no new worktree.
- Branch: `codex/supabase-stack`.
- HEAD: `6038fdaed6eed71d244fc709c43089decfddae03`.
- Approved implementation baseline: `26413df79efc8f223415c9c23305d1a0afb4a7e3`, recorded in the plan and run record; confirmed ancestor/merge base. The previous commit was not substituted.
- Included: committed, staged, unstaged, deleted, and relevant untracked paths. The initial manifest contains 361 paths, including 125 untracked files. Unrelated committed `.gitignore` and `CLAUDE.md` changes were excluded from findings.
- Review packet: `.agent-runtime/reviews/supabase-stack-review-20260927/`. `state.json` records every path/hash and Git status; `complete.patch`, `staged.patch`, and `unstaged.patch` identify tracked changes. Initial state SHA-256: `cf3c860547ab27774bca1c097935a57dcbea32f5b6cb6406efdea33dbdd10ad6`.
- Final identity check: same HEAD; all 361 reviewed path identities unchanged. The new report is the sole added tracked-scope deliverable from this review.

### Contract and attempt history

Authority: [approved plan](../../infra/supabase/PLAN.md), its source-grounded audit in section 2, agreed decisions in section 1, contracts in sections 3/5, and acceptance scenarios in section 6. No separate numbered Supabase audit/control document was located. C1–C10 below are review indexing labels for those existing requirements, not new product requirements.

The reviewed slice is Database/Auth/Storage/Studio, backend authorization and sessions, preserved SSE, and Compose/operator/test integration. Fresh-start installation is intentional. Legacy data migration, Supabase Realtime, native installers, and macOS server support are excluded. Windows acceptance is explicitly deferred by the user; native Linux host boot/reboot also lacks evidence. The implementation itself is marked in progress, not production-approved.

`attempt_kind: other`: this is an aggregate review after multiple separately reviewed implementation units. It is neither a single first submission nor a blanket second Sol retry. The actual history is retained in `.agent-runtime/supabase-implementation.md` and prior `.agent-runtime/reviews/` packets. Restore-target ownership, backup containment, and optional-scanner readiness corrections previously passed scoped review. The ignored production rehearsal harness previously reached R5, was adjudicated, corrected, and then passed an actual 32-check rehearsal. That completed history was not reset or treated as a new gate. The newly supported findings below do not establish an R1–R5 gate. No advanced review was started.

Four normal `review` assignments covered coherent units: identity and affected frontend workflows; infrastructure/database foundation; file/event/readiness integration; and operations/delivery. A `browser` assignment inspected public pages read-only. Workers returned results without editing files or delegating. Assigned skills were read and reported: `review-agent`, applicable `impeccable`/`frontend-design-review`, `fastapi-backend-patterns`, `fastapi-api-design`, `webapp-security-review`, `postgres-patterns`, `project-tooling`, and `verification-loop`. Current approved Supabase contracts superseded stale vanilla-PostgreSQL examples in skills. No requested skill was missing.

## 2. Supported findings

### F1 — BLOCKING · P1: isolate postgres-meta from application processes

**C1/C2: operator administration and constrained application database authority.** Locations: [meta service/network](../../infra/supabase/compose.yaml), lines 224–246; [API network membership](../../infra/supabase/compose.production.yaml), lines 60–63; [gateway metadata route](../../infra/supabase/upstream/envoy/lds.template.yaml), lines 188–204 and 493–506.

The API and scanner worker share the `provider` network with postgres-meta. Meta uses the privileged `postgres` connection and exposes a SQL endpoint without request authentication. A compromised application process can call `http://meta:8080/query` without obtaining the operator's database password, bypassing `openslate_runtime` restrictions. There is also a gateway route: `/pg/` accepts the application-held service key after opaque-key translation, with Studio Basic Auth disabled for that route. Restricting the runtime SQL connection alone therefore does not enforce the intended administrative boundary. This is an internal trust-boundary defect, not a claim that anonymous Internet users can reach the database.

This conclusion combines checked-in network/routing configuration with the pinned upstream [request connection hook](https://github.com/supabase/postgres-meta/blob/v0.99.0/src/server/routes/index.ts), which selects the configured connection when the encrypted header is absent, and [SQL handler](https://github.com/supabase/postgres-meta/blob/v0.99.0/src/server/routes/query.ts), which executes the supplied query. The encryption key does not authenticate callers. No live SQL request or exploitation was attempted.

**Smallest complete correction:** put meta and its Studio access on an operator network inaccessible to API/worker containers, retain only their necessary database connectivity, and deny/remove the gateway `/pg/` application-key path. Removing that route alone leaves direct network access open. Preserve Studio's operator authentication, direct Studio-to-meta integration, runtime SQLAlchemy access, and required Auth/Storage APIs.

**Verification:** on an explicitly admitted disposable target, demonstrate denial from the API/worker network and through the gateway using the application service key; demonstrate authenticated Studio still works. Use harmless read-only probes and retain independent runtime-role DDL-denial checks.

### F2 — BLOCKING · P1: reauthorize publication after provider step-up

**C3/C6: authoritative backend permissions and privileged-operation checks.** Location: [publication route](../../backend/app/systems/sandbox/publications/router.py), lines 116–140; new transaction boundary in [password verification](../../backend/app/systems/sandbox/lifecycle/password.py), line 96.

The publication route acquires fresh actor/session/policy authorization locks, then calls the provider password helper. Successful verification commits that same transaction and releases those locks. The route subsequently replays or applies publication without another authorization check; the publication executor assumes the route already authorized it. A concurrent session revocation or permission removal after the helper's commit can therefore be followed by a successful publication. The previous successful local password helper did not commit at this point. Source tracing establishes the race; it was not reproduced against a live database in this review.

**Smallest complete correction:** recheck current actor/session/capabilities after provider verification, before both replay and publication, and retain the resulting locks through the publication transaction. Preserve provider password verification, its rate-limit accounting, preview-token binding, idempotency, audit, and existing page structure.

**Verification:** a disposable concurrency journey must revoke the session or remove publication permission between completed password verification and publication. Expect denial and no publication/schema changes. Existing successful step-up tests do not exercise that interleaving. A superficially similar lifecycle close/purge race was checked against the baseline and excluded as pre-existing; file purge already performs a fresh administrator check.

### F3 — BLOCKING · P2: allow local browser logout during an Auth outage

**C4: immediate application-session revocation before provider sign-out.** Location: [logout route](../../backend/app/systems/access/auth/router.py), lines 229–239.

With a valid access cookie, logout calls `get_current_identity`, which performs a live Auth account lookup. An Auth outage produces 503. Logout only enters its opaque-refresh-handle fallback for 401, so 503 exits before local revocation, commit, or cookie clearing. After Auth recovers, that still-active session can work again. This contradicts the plan's local-first logout and durable provider-sign-out retry contract.

**Smallest complete correction:** use the existing opaque handle with origin and CSRF validation to revoke the browser's local session without requiring provider availability. Commit local denial before attempting provider sign-out; preserve the durable retry path, mixed-credential rejection, and strict authentication for ordinary protected routes.

**Verification:** existing logout tests cover successful identity lookup and 401 fallback, not provider-unavailable lookup. Exercise a signed-in browser's logout during an Auth outage; verify local revocation/cookie clearing, queued provider cleanup, and continued denial after Auth recovery.

### F4 — BLOCKING · P2: resolve installation environment paths before changing directory

**C9: usable instance-specific operator/development commands.** Location: [developer wrapper](../../scripts/dev.py), line 48; [environment file opening](../../scripts/environment.py), line 883.

The new `--env-file` option forwards relative paths unchanged, while `uv --directory backend` changes the helper's working directory. A valid relative path supplied from the repository root is consequently resolved under `backend/` and fails. This exact failure was recorded during the prior local cutover; the absolute-path retry succeeded. No service command was rerun here.

**Smallest complete correction:** resolve the supplied path against the caller's directory before launching the child. Preserve owner-only file checks and instance admission; do not weaken guards or rewrite configuration.

**Verification:** extend the existing wrapper contract check to assert the forwarded absolute path from a different caller directory. An authorized isolated smoke check can then verify selection of the intended file without falling back to the default instance.

### F5 — BLOCKING · P2: resolve the observed mandatory Ruff failures

**C10: required static gate.** Locations: [new application baseline](../../backend/migrations/versions/c4ec36fc30cc_self_hosted_supabase_application_.py), lines 4973–4974; [new sign-out test](../../backend/tests/auth/test_provider_signout.py), import block at lines 3–14.

The current backend Ruff check exits 1 with two E501 errors in the new baseline and I001 in the new test. The canonical gate includes these files, so it cannot pass unchanged.

**Smallest complete correction:** sort the test imports and resolve the already-recorded applied-baseline formatting exception before touching that immutable revision. Preserve SQL/AST behavior and historical revisions. Do not exclude the file, relax lint, or invent a no-op migration to hide a formatting failure. This review does not grant the exception or perform the repair.

**Verification:** the exact Ruff check must pass after an authorized correction; confirm any permitted baseline formatting is semantically unchanged. The unrelated broad formatter output is not a demand for repository-wide cleanup.

### F6 — BLOCKING · P2: import the database image constant from an exported location

**C10: required tooling type check.** Location: [environment helper](../../scripts/environment.py), line 31.

The new import of `SUPABASE_DB_IMAGE` through `app.core.config.instance` fails strict mypy: that module imports the constant but does not explicitly export it. The canonical mypy command includes this helper. App-only type checking passes and does not cover this failure.

**Smallest complete correction:** import from the defining module, or deliberately re-export the constant. Preserve the pinned image value and admission checks. Rerun the affected tooling mypy command; no runtime/database change is needed for this correction.

### F7 — BLOCKING · P2: complete the source-backup operator procedure

**C9: supported coherent backup and published operating runbook.** Location: [restore guide](../../infra/supabase/RESTORE.md), line 5; related [backup implementation](../../packaging/backup/backup_installation.py), stopped-source admission around line 554 and Restic invocation around line 606.

The implemented backup requires stopped source services, an initialized Restic repository, protected input paths, and a suitable completion-marker path. Current checked-in operator documentation explains restore but does not give the source backup invocation or repository-initialization/marker sequence. An operator cannot follow the documented recovery workflow from a new installation without reconstructing these prerequisites from code or the ignored rehearsal harness. The successful rehearsal proves the implementation, not completeness of its supported operator procedure.

**Smallest complete correction:** add the missing backup section to the existing runbook: private inputs, ownership/target checks, source quiescence, repository initialization, exact backup invocation, completed snapshot/marker handling, source restart, and operator responsibilities for retention/off-host copies. Preserve the tested physical backup/restore implementation and isolated-target requirements.

**Verification:** walk the documented sequence on an authorized owned installation, checking the produced marker/snapshot and subsequent restore. Do not rerun destructive recovery against the ordinary development instance.

### Optional observations — NON-BLOCKING

- **N1 · P3:** [testing architecture](../architecture/16-testing-architecture.md), lines 66–69, still says real physical restore remains unaccepted. Distinguish the passed Docker Desktop Linux-container rehearsal from pending native Linux host reboot and Windows acceptance. This does not establish a runtime defect.
- **N2 · P2, source-based availability risk:** provider step-up holds a per-identity database rate-limit transaction lock across Auth HTTP requests. A slow provider can serialize concurrent checks for that identity and occupy database resources. No load measurement or demonstrated acceptance failure was obtained. Any future change must preserve the attempt budget; this observation does not trigger a repair/review cycle.

## 3. Acceptance and evidence

| Criterion, mapped to approved plan | Verdict | Evidence and limitation |
| --- | --- | --- |
| C1 — pinned/private Compose and operator administration | **supported BLOCKING FAIL** | Pinned stack and production rehearsal are evidenced; F1 leaves metadata administration reachable from application processes. |
| C2 — database authority, app-only migrations, instance isolation | **supported BLOCKING FAIL** | Fresh migration/provider preservation and owned-instance checks have retained evidence; F1 bypasses the constrained runtime role. |
| C3 — provider authentication, binding, current backend permissions | **supported BLOCKING FAIL** | Core provider login/binding has retained source/runtime evidence; publication's current-permission boundary fails F2. |
| C4 — refresh/replay/session revocation | **supported BLOCKING FAIL** | Two real refresh/replay checks recorded passing; F3 breaks local logout during provider outage. |
| C5 — invitation/recovery and preserved frontend flow | **UNRESOLVED** | Real provider/Mailpit HTTP checks passed; rendered public pages inspected. Newly authored real email-link browser journey has not run. |
| C6 — current-actor privileged step-up | **supported BLOCKING FAIL** | Real lifecycle step-up check passed, but publication caller fails F2. |
| C7 — private scanned files and safe failure handling | **UNRESOLVED** | Real scanner and two Storage partial-failure checks passed. Full final acceptance/gate evidence is absent; no new file defect established. Timeout followed by absent quarantine remains intentionally fail-closed in `uploading`, as retained behavior requires; absence is not proof that a late external write is impossible. This review does not invent automatic deletion/terminal cleanup as a new requirement. |
| C8 — opaque authenticated cross-process SSE | **PASS** for migration transport scope | Recorded two-API-process invalidation/refetch/reconnect/revocation acceptance and current source comparison. Realtime remains deferred. |
| C9 — reset, coherent backup/restore, readiness, operating procedure | **supported BLOCKING FAIL** | Real guarded reset, five-volume restore and bounded readiness failure/recovery passed. F4/F7 leave operator workflows incomplete. Host acceptance remains separate. |
| C10 — meaningful tests, CI/gates, honest release evidence | **supported BLOCKING FAIL** | F5/F6 fail mandatory static checks. Final canonical gate and 90% overall/changed-line coverage have not run; no release approval. |

### Reused execution evidence

Evidence remains under `.agent-runtime/supabase-implementation-dev/`; it is local, ignored evidence, not hosted CI or deployed-customer proof.

- `production-restore-execution.json` and `production-restore-a5cf301af832407690605ebbb25916cd/report.json`: 32 checks PASS, exit 0, exact cleanup PASS. Covers actual encrypted five-volume restore, DB-only session finalization, trusted TLS/Caddy CA, restored file authorization/bytes, new writes, readiness outages/recovery, and full container stop/start on macOS Docker Desktop with Linux containers.
- `provider-recovery-acceptance-evidence.json`: Storage partial failures 2 PASS; lifecycle step-up 1 PASS after correcting an empty-module fixture; two-process SSE 1 PASS. The failed fixture attempt remains in history; post-format SSE hash is explicitly recorded.
- `provider-reset-final-evidence.json`: real reset 1 PASS, direct known-key absence and old-session denial; all recorded reset source/test hashes match.
- `provider-refresh-v2-evidence.json`: 2 PASS for expiry/concurrent refresh and provider ancestor replay. Compose/test hashes match; `supabase_runtime.py` differs from that older record. Treat this as historical behavior evidence, not a fresh execution of the final runner.
- `scanner-final-evidence.json` and `scanner-final-acceptance.json`: actual clean/infected/unscanned/unauthorized denial, real engine/crash recovery and browser subprocess PASS. Current product inputs match, but the runner and newly expanded auth browser test postdate this run. The line reporter does not supply a browser test count; none is invented.

Comparison against the production rehearsal's 1,410-file source inventory found 1,399 exact matches. The 11 differences are documentation plus `backend/tests/fullstack_runner.py` and `frontend/tests/fullstack/auth-session.spec.ts`; no product/Compose/migration source drift was found. Exact comparisons are retained in the review packet's `reused-production-source-comparison.json` and `reused-focused-source-comparison.json`. Passing scenarios do not refute unexercised races/outages found by source review.

## 4. Verification performed and limits

New checks used existing binaries, without package installation, services, or database writes. Commands and exit codes are recorded in `verification.json` and individual `.log`/`.json` files in the review packet.

| Working directory / command | Result |
| --- | --- |
| Root: `git diff --check` | PASS |
| Backend: `.venv/bin/ruff check .` | FAIL, exit 1: two E501 and one I001 (F5) |
| Backend: `.venv/bin/mypy app operations` | PASS |
| Backend: `.venv/bin/ruff check ../scripts ../tests/tooling ../packaging/backup` | PASS |
| Backend: `.venv/bin/mypy ../scripts/ci_scope.py ../scripts/prepush.py ../scripts/environment.py ../scripts/dev.py ../scripts/run_tests.py ../packaging/backup/backup_installation.py ../packaging/backup/restore_installation.py` | FAIL, exit 1: one export error (F6) |
| Frontend: `node_modules/.bin/prettier --check .` | PASS |
| Frontend: `node_modules/.bin/eslint . --max-warnings=0` | PASS |
| Frontend: `node_modules/.bin/tsc --noEmit --incremental false` | PASS; uses existing generated type inputs, not a new Next type-generation/build run |
| Root: `python3 scripts/prepush.py --base 26413df79efc8f223415c9c23305d1a0afb4a7e3 --list` | PASS, plan only; all relevant gates including reset selected. Unclassified packaging paths fail closed to all gates. |
| Backend: `.venv/bin/ruff format --check .` | Supplementary FAIL: 169 files, including unchanged pre-existing files. Not classified wholesale as introduced defects; no formatting was applied. |

Read-only rendered procedure: open existing `http://127.0.0.1:3000/login`, `/auth/recovery`, and tokenless `/auth/setup`; inspect at 1280×720 and 375×812; tab through available controls and inspect visible focus, labels, missing-link guidance, and horizontal overflow. All three rendered; mobile document width was 375 without horizontal overflow; no console errors were observed. Setup without a link explains the problem and disables its password/action controls. No forms were submitted, field values inspected, mail read, or accounts changed. This public-page inspection is not a successful authenticated/email-action E2E journey.

**Not executed in this review:** canonical pre-push, backend regression/coverage, production rebuild, dependency/security scanners, migration writes, real email-action browser acceptance, fresh backup/restore, or native host tests. The request prohibits provisioning environments; normal feature-development databases are not disposable review targets. No currently verified disposable environment was admitted for write-capable verification, so no existing developer/customer stack was repurposed. Previous passing evidence is reused only within its stated source/environment limits.

Windows remains explicitly pending because no test host exists. Native Linux Docker Engine host boot/reboot remains unverified; a Linux container on macOS cannot supply that proof. Existing local dev services and data were left untouched.

## 5. Next action and review closure

No R1–R5 gate is supported, so no adjudication packet or advanced review is required for these findings. The completed historical R5 harness packet remains intact and is not reopened.

A later, separately authorized correction should preserve the existing implementation and address: (1) metadata network/gateway isolation; (2) publication reauthorization and outage-safe local logout; (3) relative environment path handling; (4) the exact static failures, respecting the applied-migration exception; and (5) the missing backup procedure. Under the existing policy, supported review rejection routes the scoped correction to `implement_complex`; this report does not dispatch it or grant implementation permission. Verify each corrected behavior narrowly, then run the required integration gate on the final state when an explicitly authorized isolated environment is available. Complete the new real email-link journey and retain honest native-host deferrals.

Reviewer closing fields are preserved in the parent consolidation: identity **Confidence: low; Escalate: no**, because supported failures coexist with missing email/gate evidence; file/event/readiness **Confidence: low; Escalate: no**, because no blocker was found in its slice but final acceptance is incomplete; operations **Confidence: high; Escalate: no**, for its source-supported criterion failures; foundation **Confidence: high; Escalate: no**, because each assigned failed criterion has a supported blocker. Browser inspection **Confidence: high; Escalate: no** for its limited rendered-state assignment. Agreement between reviewers was not treated as independent proof: the parent checked the concrete source paths, baseline causality, pinned upstream behavior, and recorded check results.

**Parent next action: stop after delivering this report.** No repair, commit, merge, deployment, or further review tier is started.

**Confidence: low** for complete acceptance: the defects are supported, while material final runtime/gate evidence is missing. **Escalate: no**: no R1–R5 condition warrants advanced adjudication.
