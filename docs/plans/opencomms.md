# OpenComms plan

OpenComms is Phase 2 of the four-phase Supabase split: 1 Foundation ([plan](supabase-foundation.md)), 2 OpenComms, 3 Cloud launch, 4 Installer hardening. This document keeps the plan's intent, architecture, decisions and quality targets. Execution records, run logs and per-slice evidence are not part of it.

Status: the code slices are implemented on the `codex/opencomms` branch. Integrated browser/provider acceptance with performance proof (S32), the full-branch review and pre-push gate (S35) and the sample Small profiles (S34) are pending. The quality targets in section 6 are targets, not results; the capacity burst and fan-out measurement, the 10,000-message purge timing and the timeline opening measurement have not run.

Decision IDs: `D<n>` is an OpenComms decision (section 7). `F-D<n>` is a decision in the [Supabase foundation plan](supabase-foundation.md).

The current architecture is described in the numbered documents, which take precedence over this plan where they differ: [API boundaries](../architecture/07-api-architecture.md#opencomms-http-boundary), [backend](../architecture/04-backend-architecture.md), [frontend](../architecture/05-frontend-architecture.md), [lifecycle and durable work](../architecture/09-lifecycle-and-state-management.md#comms-retention-and-durable-work), [recovery](../architecture/15-error-handling-and-recovery.md#opencomms-refusals-and-command-recovery), [security](../architecture/14-security-architecture.md) and the [operator boundary](../../infra/supabase/README.md#opencomms-ingress-and-private-publication). Sample coverage is in the [sample-pack contract](sample-pack-contract.md#opencomms-controls).

## 1. Intent

OpenComms is the real-time conversation layer of each organization: channels, categories, direct and group messages, and threads. It must stay correct on a slow LAN, run on one modest Windows host, keep every organization's data apart, and be usable by people with little technical confidence.

The owner set the order:

1. Inventory the existing page: every control, page, setting and configuration.
2. Improve what exists, frontend first.
3. Then make it work, with a backend and real-time delivery.

**The existing controls stay and become real (D2), including the admin tools.** Every settings surface shows the common settings first and keeps the rest under a collapsible "Advanced settings" section. Automation alone waits until after OpenComms (D29).

**Two transports (F-D23 and the 2026-10-15 owner decision):**
- **Supabase Realtime** carries OpenComms live events, typing and presence.
- **SSE** stays for the cache invalidations of the other pages. OpenComms tables publish no SSE invalidations; only the in-app notification that a send creates refreshes the recipient's bell over SSE.
- **FastAPI stays the only way into data.** The browser joins Realtime with a short-lived token that FastAPI issues, and Realtime payloads carry ids only. Message content always loads through FastAPI, which applies the one access function.

**Counterargument to frontend-first.** The original page ran on a browser sample model that the server could not use: a hard-coded viewer, people keyed by display name, a 24-permission matrix that contradicted the single access function, two sources of truth for a thread, and sample state that did not carry the organization.

**Solution.** S01 froze the v1 API and event contract first. Phase A ran the improved UI on an in-memory client that implements that contract. Phase C swapped in the HTTP and Realtime adapters behind the same interface, and S31 moved the in-memory engine out of production into a test-only fake.

**Counterargument to making every admin tool real.** The work roughly doubles, to about 150–190 engineering days.

**Solution:**
- Phase A delivers the improved UI first, so design problems surface before the backend exists.
- Tools share engines: settings resolution, the job worker, the audit log, group grants and the purge path.
- Progressive disclosure keeps the visible surface small.

**Counterargument to Realtime for chat.** The foundation shipped the Realtime service with one proven private channel, but chat needs more than that before any event can move.

**Solution.** S20A adds, with S02 proving each premise first:
- topic kinds whose conversation joins require expiring grant rows that FastAPI writes from its current access projection;
- read-only browsers on Comms topics;
- a same-origin browser route;
- a server publication path that sends opaque, ids-only events after commit.

What "done" means for the owner:

- Two people on two computers in one organization exchange messages, replies, reactions and files in real time.
- They see who is online and who is typing.
- Unread and mention counts agree with the server.
- A dropped connection recovers without lost or doubled messages.
- Only people with access see a conversation or its content.
- Nothing crosses organizations.
- Every setting and admin tool on the page does what it says.
- The page meets the quality targets in section 6.

## 2. Starting point

- **Frontend:** about 16,300 lines under `frontend/src/components/systems/comms/`, all on browser session storage through a sample provider in `comms/layout.tsx`. The page never wrote the URL, many controls were inert previews, and it held 38 settings in three scopes with workspace locks, 24 permissions and 10 tool views. The shell already had a per-tab organization (`frontend/src/lib/organization-context.ts`), `apiFetch` sent `X-Org`, and the shell remounted per user and organization.
- **Backend:** `backend/app/systems/comms/` was an empty reserved package. Tenancy (`org_id`, composite keys, `organization_rows` RLS, per-transaction organization binding), membership-based access (`scope.py`), per-organization workers and Storage (`openslate-ready`, 10 MiB, file-type allowlist, pending-upload quota) already existed.
- **Realtime:** `supabase/realtime` ran in every stack. `POST /api/realtime/token` issued a five-minute ES256 token with `purpose=realtime` and an `org_id` claim. There was no browser route to the service, no Realtime client in the frontend and no publish path in the backend.
- **SSE:** four streams per user, 128 per process, `SERVER_MAX_CONCURRENCY=64`, a 32-event queue; each stream is pinned to one organization and re-authorizes on heartbeat and on each dequeued event.
- **Entitlements:** none. Plans and limits are Phase 3; on-premises installations have no limits.

The Tier 2.5 test rules apply: HTTP specs run against the static export, retries stay at 0, the assertion ledger stays green and the forbidden-pattern guard passes. This plan replaced the earlier Comms tests, with a [test ledger](test-ledger.md) row for each removed assertion; it supersedes F9 and I4 in the [Tier 2.5 plan](test-suite-tier-2-5.md).

## 3. Workstreams and order

| ID | Workstream | Phase | Slices |
|---|---|---|---|
| W0 | Contract v1, measurements and Realtime proofs, direction contract | 0 | S00–S03 |
| W1 | Model, in-memory client keyed by user and organization, settings engine and capabilities | A | S04 |
| W2 | Page structure, URL state, sidebar and navigation | A | S05–S06 |
| W3 | Timeline and composer | A | S07–S08 |
| W4 | Right pane, settings dialog with progressive disclosure, admin tools UI, notification preferences UI | A | S09–S12 |
| W5 | States, accessibility, mobile; Phase A finish | A | S13–S14 |
| W6 | Schema with tenancy and ordering; access, capabilities, settings engine on the server | B | S15–S16 |
| W7 | REST API: conversations, categories, messages, threads, reactions, files, records, search | B | S17–S19 |
| W8 | Realtime foundation closure, then events, typing and presence | B | S20A, S20 |
| W9 | Notifications, moderation, report queue, lifecycle | B | S21–S22 |
| W10 | Scheduled messages, retention, export, templates, settings history, join requests, link previews | B | S23–S25 |
| W11 | HTTP and Realtime adapters, cache, outbox; one connection set per browser and organization | C | S26–S27 |
| W12 | Typing and presence UI, notifications and desktop alerts, search UI, admin tools wiring | C | S28–S31 |
| W13 | Fullstack acceptance, performance proof, documentation | C | S32–S33 |

The final steps are S35 (full-branch review and the serial pre-push gate) and S34 (sample Small profiles, with the guarded local reset between them, D42). The branch has no mid-run merge (D28); the owner pushes and opens one pull request.

Order rationale:
- Phase 0 removes the risks that are expensive to retrofit: the contract shape, message ordering and the Realtime premises.
- Inside Phase A, S06–S12 run one at a time because they compose into one layout.
- Phase B writes only under `backend/` and `infra/`. Backend and frontend heavy test lanes never run at the same time (root `AGENTS.md`, rule zero).

## 4. What OpenComms reuses

OpenComms builds on these foundation pieces and never adds a parallel one:

| Foundation piece | Where | How OpenComms uses it |
|---|---|---|
| Multi-organization tenancy: `org_id`, composite keys, `organization_rows` RLS, organization binding | `backend/migrations/AGENTS.md`, `core/database/organization_scope.py` | Every Comms table follows it; there is no Comms-specific tenancy code. |
| Membership-based access | `access/policy/scope.py`, `access/users/membership.py` | Conversation access composes it; there is no second rule set. |
| Realtime service and gateway route `/realtime/v1/websocket` | `infra/supabase/compose.yaml`, `upstream/envoy/lds.template.yaml` | Used as is; S20A adds the same-origin browser route and the separate private publisher listener. |
| Realtime token `POST /api/realtime/token` (F-D23) | `platform/realtime/` | Extended, not replaced: it reconciles grants and returns the conversation topic list. |
| Topic naming `org:<org_id>:<kind>:<id>` (F-D24) | [Supabase foundation plan](supabase-foundation.md) | Adds the kinds `conversation` and `user`, and uses `org:<id>:presence`. |
| Join function `can_join_realtime_topic` and the `realtime.messages` policies | `operations/provision_database_role.py` | Its body is replaced by a forward revision with the same signature; provisioning still refuses any other policy. |
| Storage bucket `openslate-ready`, file validation and quota | `platform/files/` | Chat attachments are a new file purpose in the same bucket. |
| Avatars and person card | `person-avatar.tsx`, `/api/users/{id}/card` | Message authors and members. |
| Per-organization workers, audit, notifications, SSE | `platform/scheduling/`, `manage/audit/`, `platform/events/` | Comms jobs, audit rows and notifications reuse them; SSE stays for the other pages. |
| Frontend organization context | `frontend/src/lib/organization-context.ts`, `app-page.tsx` | The Comms client, drafts, outbox and Realtime connection are keyed by user and organization. |

Backend patterns that every slice reuses:

| Pattern | Use |
|---|---|
| Re-check a fresh exact administrator after the password and hold the lock until commit | Conversation purge, private export, settings restore, retention |
| Captured-source read rule: re-check current read access beside the stored parent check before showing derived results | Search hits, notification visibility, export download, record references (D23), settings history |
| Capacity checked on create **and** restore through one helper under the lock | Conversation unarchive and member re-add, moderator restore, scheduled-message cap |
| Admission bounds separate from reading stored rows | Settings values, D19 limits, mention limit, template JSON |
| Page-bounded batching into a dict, refusing on a miss | Bootstrap and message pages, replies, search hits |
| Projections that never load bodies or blobs to list names | Conversation summaries, job lists |
| Locks scoped to the bound organization, never one global key | Presence sweeper, retention, export |
| Per-organization workers | Presence sweeper, scheduled messages, retention |
| Query-count tests with equal SELECT counts across page sizes | Section 6 efficiency targets |
| Organization isolation tests | Every backend slice |

## 5. Slices

| Slice | Content |
|---|---|
| S00 | Setup: base and Alembic head recorded |
| S01 | Contract v1: API and event shapes, complete capability contract, legacy permission mapping |
| S02 | Measurements and Realtime proofs |
| S03 | Direction contract for the design |
| S04 | Model, in-memory client, settings engine, capabilities |
| S05 | Page split and URL state |
| S06 | Sidebar, categories, navigation |
| S07 | Timeline |
| S08 | Composer |
| S09 | Right pane, threads, people, presence display |
| S10 | Settings dialog with progressive disclosure, access check |
| S11 | Admin tools UI |
| S12 | Notification preferences UI and desktop alert permission |
| S13 | States, accessibility, mobile |
| S14 | Phase A visual finish and behavior map |
| S15 | Schema with tenancy and ordering |
| S16 | Access, capabilities, settings engine, visibility |
| S17 | Conversations, categories, messages, preferences, settings API |
| S18 | Threads, reactions, pins, quotes, files, record references |
| S19 | Search API |
| S20A | Realtime foundation closure: topic kinds and grants, read-only browsers, same-origin route, private publication |
| S20 | Comms events, typing and presence on Realtime |
| S21 | Notifications |
| S22 | Moderation, report queue, lifecycle |
| S23 | Scheduled messages, retention, export |
| S24 | Templates and bulk apply, settings history, join requests |
| S25 | Link previews, SSRF-guarded |
| S26 | HTTP and Realtime adapters, cache, outbox |
| S27 | One connection set per browser and organization, reconnect |
| S28 | Typing and presence UI |
| S29 | Notifications, desktop alerts, badges |
| S30 | Search UI |
| S31 | Admin tools and settings wiring; in-memory engine moved to tests |
| S32 | Fullstack acceptance and performance proof (pending) |
| S33 | Documentation |

S32 covers, with two real accounts on the production-level Realtime path: send, reply, react and attach; edit and delete; moderator remove and restore; a connection drop during sends that recovers in order with no duplicates; a removed member who stops seeing content at once and stops receiving ids within the token lifetime (D34); and a second organization in another tab that never sees the first organization's events.

## 6. Quality targets

Each target has a method. A miss is fixed within the slice. If it cannot be fixed after three different attempts and an analysis pass, the measured number becomes an owner-visible known issue; a miss never stops the run.

| Quality | Target | Method | Slice |
|---|---|---|---|
| Performance: JS | A cold `/comms` load transfers at most 365 KiB of compressed JS. Because the Phase A starting point was above that, each frontend slice grows it by at most 5% over the previous slice, and once the in-memory tools leave production the total ends below the Phase A starting point. Admin tools, the settings dialog and the Realtime client load on demand. | Production static build; Playwright records gzipped JS sizes | S04, S07, S10, S11, S26, S31 |
| Performance: timeline | With 5,000 messages, the newest 50 show within 200 ms of data arriving. A 3,000 px scroll produces at most 2 long tasks over 50 ms (Chromium, 4× CPU throttling). | Playwright + CDP + `PerformanceObserver('longtask')` | S07, S32 |
| Performance: server | Bootstrap for 50 conversations: p95 at most 150 ms. A history page of 50 in a 100,000-message conversation: at most 100 ms. Send: at most 150 ms. Search over 100,000 messages: at most 300 ms. The per-request organization baseline is reported separately from handler time. | pytest on isolated PostgreSQL with synthetic seeded rows; 30 serial samples | S17, S19, S32 |
| Effectiveness | Send-to-visible on the other screen: at most 1,000 ms p95 over 50 sends. Typing shows within 1,000 ms. Offline shows within 150 seconds of the last heartbeat. | S32 timing | S32 |
| Reliability | No lost or duplicated message across a reconnect or token refresh. Idempotent replay. Outbox retry. A scheduled message survives an API restart. A rollback publishes nothing. | Tests in S15, S20A, S20, S23, S26, S27 | listed |
| Isolation | A non-member, a person without a grant, or another organization's member never receives a Comms event, a presence update, a search hit, a file or a notification. After removal, content is refused at once (404); id-only events can continue for at most the token lifetime (5 minutes, D34). | Tests in S15–S21, S20A, S32 | listed |
| Efficiency | Bootstrap and message pages run the same number of SELECTs at every page size. A grant reconcile in the steady state writes nothing. One send writes at most one message, one counter, its mention rows, notification rows only for the S21 recipients, one audit row per audited table, and one publish per topic. | Query counter; reconcile test | S17, S20A, S20 |
| Purge | Purging a 10,000-message conversation completes within the database statement timeout, with a 15-second timing target, without weakening audited individual deletes or confirmation guards. | Measured once on a freed machine | S22, S32 |
| UX | Every scout finding is fixed or recorded as deferred. Each settings tab shows at most six common items. The finish reviewer returns `ship`. Plain copy for any organization in any country. | S14, S10 test, S31 | S10, S14, S31 |
| Host budget (provisional) | At the D20 target, the Realtime container stays at or below 1 GiB resident memory, and the API process grows by at most 512 MiB over its idle baseline. This stands in for the Windows host specification until Phase 4 sets one. | S02, S32 measurements | S02, S32 |

## 7. Decisions

Owner answers: 2026-10-11 and 2026-10-19. Foundation decisions (`F-D<n>`) stay binding where cited. Rows marked "Default" were the plan's proposal and stood because the owner did not change them.

| ID | Decision | Accepted value | Source | Slices |
|---|---|---|---|---|
| D1 | Looks | Use tokens and skin hooks, so the page works with every look. Keep the Look-Only rule, and add `/comms` to the theme parity test. | Owner | S03, S13, S14 |
| D2 | Existing controls | Keep them and make them real, with common settings first and the rest under a collapsible "Advanced settings". Automation is the one exception (D29). | Owner | Phase A, S16–S25, S31 |
| D3 | Guests | Read only: no posting, reacting, or starting or joining direct messages. The read-only Realtime policy enforces the same on topics. | Owner | S04, S16, S20A |
| D4 | Message pagination | Keyset by `seq` for message and reply history; other lists stay offset-paged. This is the explicit decision that `backend/AGENTS.md` requires. | Owner | S17, S18 |
| D5 | Unaudited tables | Read states, counters, member preferences, personal preferences, thread follows, Realtime grants and presence. All still carry `org_id` and RLS. Messages stay audited, with the body redacted. | Owner (extension: Default) | S15, S20A, S20 |
| D6 | Event payloads | Ids only, never content, on private Realtime topics. OpenComms tables publish no SSE invalidations; the in-app notification a send creates still refreshes the recipient's bell over SSE. | Owner (updated for F-D23) | S15, S20, S26 |
| D7 | Typing and presence | Both, on Realtime. Typing goes to grant holders of the conversation. Presence is online, away or offline, server-originated from heartbeats, and per organization. | Owner | S20, S28 |
| D8 | Conversation model | Categories; organization-wide channels and department channels (D44 replaced the group-granted and private channels); direct and group messages (3–50 people); one-level threads with follow, state and "Also send to channel"; quote replies. No topics or forums. | Default | S01 onward |
| D9 | Department channels | Admins create channels. A category or channel may be linked to a department, whose access then carries over. Nothing is created automatically. | Owner | S15, S16 |
| D10 | Who creates channels | Org admins, department managers, and groups granted `createChannel`. Any member starts direct and group messages, unless `dmRule` limits it. | Owner (2026-10-19) | S10, S16 |
| D11 | Notifications | In-app bell, plus desktop alerts and sound while a tab is open. Per-conversation levels, keywords, quiet hours, preview text and badges. No email, Web Push or digest. Everything is per organization: an unread in organization A does not show in organization B. | Owner | S12, S21, S29 |
| D12 | Read receipts | None. Must-read stays on Boards. | Default | – |
| D13 | Edit and delete | The window settings are real. Defaults: no edit limit and no delete limit (a window value of 0 means no limit); every edit shows an "edited" marker and keeps its history. Admins can set a window in settings. Moderator removal is audited and restorable. | Owner (2026-10-19) | S17, S22 |
| D14 | Virtualization | Measure first. Add `@tanstack/react-virtual` (approved) only on a target miss. | Owner (2026-10-19) | S07 |
| D15 | Message formatting | A small safe renderer with no new dependency and no raw HTML. | Default | S08 |
| D16 | Search | OpenComms only: who, what, when, where, `has` and `is`. | Owner | S19, S30 |
| D17 | Retention | Per organization, keep forever by default, with channel overrides and file retention. Only org admins set retention, with a fresh password and the impact preview first. Batched individual ORM deletes through `AuditSession`. No legal hold. Plan ceilings come in Phase 3. | Owner (mechanism: Default) | S23 |
| D18 | Admin tools placement | One surface. Each tool opens on its common task. | Default | S03, S11 |
| D19 | Limits | 20 sends per 10 seconds per user per organization. Body at most 4,000 characters. At most 10 attachments per message, 10 MiB each. Group messages of 3–50 people. | Default | S17 |
| D20 | Capacity | Target 300 concurrent users per installation, with one SSE stream and one Realtime socket per browser and organization (leader tab, S27). Floor 200: below 200 with correct delivery is a defect to fix; between 200 and 300 is a recorded known issue. The approved levers, each changed only with measurements and a SEC-R6 note where a control is touched, are the Realtime tenant limits (`max_concurrent_users` up to 500; channels per client stays 100), the SSE hub caps, `SERVER_MAX_CONCURRENCY` and the database pool size. | Owner (2026-10-19 amendment) | S02, S20, S27, S32 |
| D21 | Sample executors | In the same commit as each frontend-called route, including `POST /api/realtime/token`. | Default | every route slice |
| D22 | Supervised student messages | Deferred. | Default | – |
| D23 | Record references | A card only for readers of the module, re-checked on every read. Others see "Record unavailable". | Default | S07, S18 |
| D24 | Branch and base | `codex/opencomms` from `main` at `6816f2b8` or later. | Default | S00 |
| D25 | Mentions | @person among the conversation's readers: every reader of a channel (D44), and the members of a direct or group message. @channel and @here with `mentionChannel`; @here reaches online readers only. | Default | S08, S21 |
| D26 | Unread counts | By query, capped at "99+". Switch to stored counters only on a target miss. | Default | S17 |
| D27 | Permissions | The channel scope and department roles decide read and post (D44); direct and group messages use membership. Capabilities follow the complete matrix in section 7.2, granted by group under Advanced, never per person, with no deny rules. "Check one person" explains each result. | Owner (matrix: 2026-10-19) | S04, S10, S16 |
| D28 | Merge strategy | No mid-run merge. One branch from S00 to S34; the owner pushes and opens one pull request at the end. If `origin/main` moves, record it and ask the owner before rebasing. | Owner (2026-10-19) | – |
| D29 | Automation | After OpenComms. | Owner | – |
| D30 | Link previews | Real, SSRF-guarded, off by default. | Owner (2026-10-19) | S25 |
| D31 | Export | Admins export. Direct and group messages are private sources (D44: every channel is organization-wide or a department's) and need a fresh admin password plus a reason. Audited per organization. | Owner (detail: Default) | S23 |
| D32 | Scheduled messages and report queue | Both real. | Owner | S22, S23 |
| D33 | Templates, history, join requests | Templates also do bulk apply. History comes from the audit log, with restore. Join requests applied to private channels whose join rule was `request`; D44 removed them with private channels (2026-10-22). | Owner | S24 |
| D34 | Revocation lag | After removal, content is refused at once. Id-only events can continue for at most the 5-minute token lifetime. The grant row is deleted at once, so a re-join is refused. | Owner (2026-10-19) | S20A, §6 |
| D35 | Presence scope | Everyone in the organization, guests included, through one presence topic per organization. Presence shows on person cards too. | Owner (2026-10-19) | S20, S28 |
| D36 | Visibility | Sharing a readable conversation makes people visible to each other (card, mention, direct message). A branch in `person_visibility.py`, signed off under SEC-R6. D44 superseded the 2026-10-21 amendment for people with a pending join request, because join requests no longer exist. | Owner (2026-10-19) | S16 |
| D37 | Realtime topic model | Conversation, own-user and organization presence topics, named under F-D24 (`org:<org_id>:<kind>:<id>` and `org:<id>:presence`). Conversation topics are gated by FastAPI-written grant rows (a projection, not a rule), reconciled at token issue. Browsers are read-only on Comms topics. | Default (follows F-D23, SEC-R6) | S01, S20A |
| D38 | Browser path | A same-origin `/realtime/v1/websocket` route to the provider gateway with the gateway key injected as a header: Caddy in production, the frontend launcher's upgrade proxy in development. | Default (proof-gated, S02) | S20A |
| D39 | Publish path | The plan's first choice, a SQL wrapper around `realtime.send` inside the writing transaction, failed its S02 proof. The pre-authorized fallback was selected: FastAPI validates private, ids-only envelopes, discards them on rollback, and submits them after commit through a bounded HTTP publisher to a separate private provider listener with the server key. Request-buffered events wait for the response; durable jobs submit after their own commit and session close. Delivery is best effort, not database-atomic; clients repair gaps through current-authorized reads. The publisher listener is unpublished in production; development maps it to loopback only (owner decision). | Default (proof-gated fallback, S02) | S20A, S20 |
| D40 | Realtime client | `@supabase/realtime-js`, approved, measured against the JS budget. | Owner (2026-10-19) | S26 |
| D41 | Entitlements | No gate in this phase. On-premises installations have no limits. Phase 3 adds the cloud free-tier rule (no OpenComms on the free tier). No stub table. | Default (follows the 2026-10-15 split) | – |
| D42 | Sample profiles and reset | S34 runs the sample Small profiles, including the guarded reset of local development application data between them. Authorized for this run only; never provider volumes. | Owner (2026-10-19) | S34 |
| D43 | Admin reads of private conversations | Org admins do not read direct or group messages they are not part of: these are absent from the admin's sidebar, bootstrap, search and history (404). Since D44 these are the only private conversations. Admins still manage every organization and department channel, act on reported messages through the moderation queue, and export private conversations only through D31. | Owner (2026-10-19) | S16, S17, S19, S22, S23 |
| D44 | Channel access | OpenComms is available to every organization member. A channel is organization-wide or belongs to one department, and department roles decide read, post and manage. No channel invitations, join requests, group-shared channels or private channels; hand-picked conversations are direct or group messages. Supersedes D33 (join requests), the 2026-10-21 D36 amendment, and the membership sources of `manageChannel` other than creator and manager role. Spec: `docs/specs/opencomms-department-access.md`. | Owner (2026-10-22) | Follow-up slices |
| D45 | Channel access grants | A channel keeps one owner (organization or one department). Channel managers can give read, or read and post, to Access groups and individual people outside the department; grants add to department roles and never give manage. Spec: `docs/specs/opencomms-department-access.md` (addendum). | Owner (2026-10-22) | Follow-up slices |

### 7.2 D27 capability matrix

Terms:
- A **conversation manager** is an org admin (for conversations the admin can read under D43), the department manager of a channel in that department, the conversation creator while the creator's member row exists, or a person with a `manager` member row (`ManagerSource` in `comms/access.py`). On a channel, member rows are only this manager roster (D44).
- A **poster** has `post` level.
- A **reader** has `read` level.
- Guests are readers only (D3).

| Capability | Allows | Held by default | Grantable to groups at | Default can be turned off for Everyone at | Lockable at workspace |
|---|---|---|---|---|---|
| `react` | Add and remove your own reactions | Every poster | – (on by default) | workspace, category, channel | yes |
| `reply` | Reply in a thread (also when `mode` limits root posts to managers) | Every poster | workspace, category, channel (to give readers in an announcements channel a reply right) | workspace, category, channel | yes |
| `createThread` | Start a thread from a message | Every poster | – | workspace, category, channel | yes |
| `attachFiles` | Attach files (within the file settings, the platform allowlist and the 10 MiB limit) | Every poster | – | workspace, category, channel | yes |
| `linkRecords` | Attach record links (cards still follow D23) | Every poster | – | workspace, category, channel | yes |
| `mentionChannel` | Use @channel and @here | Conversation managers | workspace, category, channel | – (off by default) | yes |
| `pin` | Pin and unpin any message | Conversation managers | workspace, category, channel | – | yes |
| `manageThreads` | Rename, resolve, lock, archive any thread (a thread starter can always resolve and reopen their own thread) | Conversation managers | workspace, category, channel | – | yes |
| `deleteOthersMessages` | Remove anyone's message (tombstone) and restore it | Conversation managers | workspace, category, channel | – | yes |
| `moderate` | Report queue, restrict a person, slow mode, lock or unlock the channel | Conversation managers | workspace, category, channel | – | yes |
| `manageChannel` | Edit settings and the manager roster of a channel, or the members of a direct or group message; archive, restore and duplicate | Conversation managers | category, channel | – | yes |
| `createChannel` | Create channels: a workspace grant means any category; a category grant means that category only. Since D44 a grant creates only department channels, in a department where the holder has a department role (owner, 2026-10-22). Source: `CapabilityInputs.grant_department` in `comms/capabilities.py` | Org admins; department managers for channels of their department, uncategorized or in a category bound to it | workspace, category | – | yes |
| `manageWorkspace` | Workspace settings and locks, retention, export, templates, settings history, capability grants at workspace scope | Org admins only | never | – | – |

Resolution rules:
1. Start with the defaults in the table.
2. Apply scopes in the order workspace, category, channel.
   - A group grant at any scope adds the capability for that group at that scope and below.
   - A lower scope can add grants, but it can never remove a grant made at a higher scope (there are no deny rules).
3. For the five capabilities that are on by default, each scope has an "Everyone" switch.
   - The most specific scope's switch wins.
   - A workspace lock on that capability fixes the workspace value for every lower scope.
   - Group grants still add the capability back for their groups unless the workspace locks the capability.
4. Conversation managers always hold every conversation capability in their conversations. Org admins hold everything in their organization. Neither can be turned off.
5. Guests never hold a capability that writes, even through a group grant. The grant is ignored for guests, and "Check one person" says why.
6. Mentions: any poster may @mention a reader of the conversation: every reader of a channel (D44), and the members of a direct or group message. @channel and @here need `mentionChannel`, and the mention limit setting applies.
7. "Check one person" lists every capability with its result and the deciding source: the default, a group grant (which group, which scope), the Everyone switch (which scope), the workspace lock, the manager or admin role, or the guest cap.

The old 24 permissions map like this:
- `viewChannel` and `post` become access levels.
- `invite`, `managePermissions` and `manageMembers` become `manageChannel`.
- `exportHistory` becomes `manageWorkspace`.
- `pinMessages` becomes `pin`.
- Each remaining one maps to the capability with the same meaning above.
- A permission with no equivalent is dropped, with a test-ledger row.

## 8. Migrations

One Alembic revision per slice that changes the schema, in this order after `226847298ae4`. Every new organization table includes its `organization_rows` RLS policy in the same revision. Applied revisions are immutable.

| Revision | Slice | Change |
|---|---|---|
| `b8d3c8dd62b7` | S15 | Comms tables with `org_id`, composite foreign keys, constraints, indexes, conversation-local ordering and the generated search vector |
| `8464b72e2cd5` | S18 | Conversation file parent for the `comms_attachment` purpose |
| `8410bb7874ff` | S20A | `comms_realtime_grants`, Realtime token admission state, and the Comms topic checks in `can_join_realtime_topic` |
| `7742d43bd994` | S20 | Typing and presence |
| `7270134f320d` | S21 | Comms notification kinds and references |
| `58464a7e16e7` | S22 | Reports and moderation state |
| `f7bf3e971f8c` | S23 | Scheduled messages, retention policy and sweeps, export jobs |
| `e17b63a36a2f` | S24 | Templates and admissions |
| `e03383c56cde` | S25 | Bounded link previews |
| `168d66144b73` | D44 | Drops `comms_admissions` and `comms_conversation_groups`; allows only `organization` and `department` scopes on live channels; removes the `join_rule` and `default_member_ids` settings and locks; keeps only creator and `manager` member rows on channels. Downgrade restores the schema only, not the data. |

## 9. After OpenComms

- Automation rules and Sandbox triggers that post to channels; handoff rows; record conversations.
- Email notifications, Web Push, mobile notifications and digests.
- The cloud free-tier gate and plan ceilings for OpenComms (Phase 3).
- Legal hold.
- Custom emoji, GIFs, voice and video, and images in previews.
- Read receipts, topics, forums, and shared channels between organizations.
- Supervised student messages (D22).
- Platform global search for messages.
- A persisted offline outbox.
- Cross-organization unread counts in the switcher.
- The window-focus session curtain that briefly blocks clicks after a tab regains focus.
