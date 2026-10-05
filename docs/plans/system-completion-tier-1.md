# System completion: Tier 1 plan

Base revision: `main` at `d34360aa`. OpenComms is out of scope.

Status: approved for delegation. The decisions in section 7 are accepted. Section 11 is the execution order.

This plan covers the work that makes OpenSlate complete before OpenComms starts. The evidence comes from static reads of the source. Nothing was executed. Section 9 lists the claims that are not tested yet.

## 1. Intent

OpenSlate is a self-hosted workspace. One organization owns one installation. The organization can be any type, in any country.

Before OpenComms starts, the system must meet these five rules:

1. Every visible control does real work. The work is durable, shared between users, and authorized by the server. A control that cannot do real work is not shown.
2. An administrator runs the installation without a command line. The administrator recovers locked-out people, protects and restores data, sets the security policy, and monitors activity.
3. The organization's identity belongs to the organization. The name, logo, look, and regional formats are the same for every person and every device.
4. Personal comfort belongs to the person. Color mode, text size, density, motion, and shortcuts follow the person.
5. Every request tells the person what happened. The feedback is consistent across pages.

## 2. Baseline

- No control is broken. Every frontend request maps to a registered backend route.
- Access, Boards, OpenView, Sandbox, and most of Manage use only the API.
- The gaps are of three kinds:
  - Fake or browser-only controls.
  - Backend features without a UI.
  - Features that do not exist yet.
- About 28,000 lines of frontend source are dead sample code. OpenComms still needs the sample runtime.

## 3. Workstreams

| ID | Workstream | Owner's item | Size |
|---|---|---|---|
| W1 | Remove placeholders and dead sample code | 1, 2 | 3–4 days |
| W2 | Organization look on the server, and personal Appearance settings | 3 | 9–12 days |
| W3 | Access page: security policy, admin recovery, monitoring | 4 | 15–20 days |
| W4 | Record attachments and per-department file library | 5 | 7–9 days |
| W5 | Backup download, then in-app restore | 6 | 6–9 days (download) |
| W6 | Notifications and request feedback | 7 | 12–15 days |
| W7 | Organization profile in workspace settings | 8 | 8–11 days |

The sizes are engineering-day estimates, not measurements. The total is about 60–80 days. In-place restore adds 17–22 days (see W5).

## 4. Order of work

```
Phase A  W1 removal (4 PRs, in order)
            │
Phase B  Shared foundations (parallel, disjoint files)
            ├─ B1 Generic /files adapter (from board-files-api.ts)
            ├─ B2 Feedback rule in DESIGN.md, shared error mapper, root Toaster
            ├─ B3 Shell event subscriber and shared notification adapter
            └─ B4 Move SecurityPolicyForm from Manage into Access
            │
Phase C  Features
            ├─ W6 Notifications            (needs B3)
            ├─ W4 Record attachments → library   (needs B1)
            ├─ W2 Organization look → Appearance
            ├─ W7 Profile fields → logo (needs B1) → regional lists
            ├─ W3 Access slices            (needs B4)
            └─ W5 Backup download
            │
Phase D  W5 in-place restore (after the host runner and installer exist)
```

Phase A comes first for three reasons:

- It removes the controls that do nothing.
- It removes Platform's dependency on Comms types.
- It takes the sample runtime off pages that save nothing in the browser.

In Phase C, workstreams with disjoint files can run in parallel.

## 5. Workstream details

### W1. Remove placeholders and dead sample code

**Goal.** No visible control fakes work. OpenComms keeps working without change.

**Procedure.** Do the PRs in this order.

1. **PR 1, Boards and Sandbox** (about 11,500 lines):
   - Delete `sample-boards.tsx` and its chain: the four sample components, the domain files, `state/controller.tsx`, and two adapters.
   - Delete the six Boards isolated specs that test only the sample chain. The `boards-live-*` and `board-*-api` specs keep the live coverage.
   - Delete the dead Designer props (`createRequest`, `onCreateRequestHandled`, `onViewPreferenceChange`) and `sandbox-controls.tsx`.
   - Delete the hidden `sandbox-inspector-properties.tsx`. It contains a Direction select that is always disabled.
   - Delete the unused `getSandboxTest`, and edit `frontend/api-route-manifest.json` by hand.
   - Rename the route wrappers `SampleBoards` and `SampleSandbox`.
2. **PR 2, OpenView** (about 14,400 lines):
   - Delete the sample workspace, analytics, Gantt, widgets, audience confirmation, controller, and filter helpers.
   - Shrink `openview/domain/model.ts` from 1,734 lines to about 150. Delete `seeds.ts`.
   - Remove the unreachable "layout not available" branches.
   - Change the badge text "Department default" to "Module default".
   - Replace the `record=sample-*` branch with a short notice: "This example record is not in OpenView." Do not delete the branch. Comms links to it.
3. **PR 3, Platform and Manage** (about 2,200 lines):
   - Platform: remove the notification preview panel, its three preference toggles, the fake File library, the Display language and Presence stubs, and the "Conversations" and "Files" search panels.
   - Manage: remove "Reset Manage", the dead sample layer (`commands.ts`, `decode.ts`, `sessions.ts`, `state.ts`), and the gate on `manage.resource.status`.
   - Manage: change "Check for updates" to "Refresh release status". It is a real refetch, so keep it.
   - Manage: rename `onPreviewMfa` to `onManageMfa`.
4. **PR 4, Shell** (about 100 lines):
   - Move `SampleProvider` from the workspace layout to a new `comms/layout.tsx`.
   - Delete the orphan `/access-restricted` route and the five unused starter SVGs.
   - Rename `SampleAccess`, `SampleManage`, `SamplePlatform`, and `SampleOpenView`.
   - Update the stale docs: `frontend/AGENTS.md`, `frontend/README.md`, and architecture docs 05, 20, and 21.

**Caution:** do PR 4 last. Platform, Manage, and OpenView call `useSampleRuntime()`, which throws outside the provider.

**Keep** these files, because Comms needs them: the shared sample runtime, `sample-people.ts`, `sample-data.ts`, `SampleDataNote`, and the Comms draft cleanup in `workspace-identity.tsx`.

**Optional backend change.** Remove the `/sandbox/versions/{id}/rollbacks` tombstone. It always returns 410. Refresh `contracts/openapi.json` after you remove it.

**Acceptance.**

- No page shows a sample-only control outside Comms.
- `/comms` works as before.
- A Comms example-record link shows the notice.
- The frontend static checks pass.

### W2. Organization look and personal Appearance

#### W2a. Organization look on the server

**Today.** The look is stored in `localStorage` (`openslate-org-theme`). Each browser picks its own look.

**Backend:**

1. Add `workspace_profiles.theme`. It is a `String(16)` with default `'slate'` and a CHECK for the values `slate`, `whiteboard`, `triplicate`, and `stockroom`.
2. Add `theme` to `WorkspaceUpdate` and `WorkspaceResponse`, and add one migration.
3. Add `theme = 'slate'` to the application-data reset (`operations/reset/execution.py`). The reset also omits `currency`, `week_start`, `business_hours`, and `mark`. Fix those in the same change.
4. Add an anonymous `GET /api/workspace/appearance` that returns `{theme}` only, with `no-store`. The login page uses it.

**Frontend:**

1. Make the look a field of the Organization form draft. A selection previews the look at once. Save sends the revision. Discard restores the saved look.
2. Add an `OrganizationThemeProvider`. It reads the public endpoint and writes the result to the existing `localStorage` key. `theme-init.js` then paints the look before the first frame, with no other change.
3. Show the picker as read-only to non-admins.

Pain point: a clean browser shows Slate for one load before the endpoint answers. Solution: accept it. The cached value removes the flash on every later visit.

#### W2b. Personal Appearance settings

**Today.** The page has color mode (Light or Dark, saved to the account) and Reduce motion (saved in the browser).

**Settings to add now:**

| Setting | Choices | Storage | WCAG basis | Size |
|---|---|---|---|---|
| Color mode | Light, Dark, System | Account | – | S–M |
| Text size | Default (100%), Large (112.5%), Larger (125%) | Device (see decision D6) | 1.4.4 | M |
| Density | Compact, Default, Spacious | Device (see decision D6) | 2.5.8 | M |
| Motion | Follow device, Reduce | Account (moved from the browser) | 2.3.3 | S |
| Keyboard shortcuts | On, Off | Account | 2.1.4 (A) | S |

**Hardening, not settings:**

- Add `forced-colors` and `prefers-contrast` rules. Focus rings drawn only with `box-shadow` disappear in Windows high-contrast mode, and the Windows installer is the main target.
- Add scroll padding so the 56 px sticky header does not hide the focused element (WCAG 2.4.11).

**Later:**

- High contrast (7:1). This needs a contrast overlay for 4 looks × 2 modes.
- Underline links.
- A readable-font override.
- A 12-hour or 24-hour clock. This needs one central date formatter first.

**Do not add:**

- Personal timezone. It breaks the workspace-day rules.
- Personal first day of the week.
- Interface language. The UI is English only.
- A focus-ring setting. The current ring meets 2.4.7.

**About "Small" text.** You asked for small, medium, and large. Pain point: "Small" puts `text-xs` at about 10.5 px, below the 12 px label floor in `DESIGN.md`. Solution: ship Default, Large, and Larger. Compact density gives more content on the screen without smaller text.

**Mechanism:**

- Text size sets `html { font-size }` through a `data-text-size` attribute. The app is rem-based (`--spacing: 0.25rem`), so almost everything scales.
- Fix the fixed-px outliers before release:
  - The sidebar width, stored in px.
  - `page-header.tsx` `text-[30px]`.
  - About 10 px-based grid and height values.
- Exclude the Sandbox canvas. It has its own zoom.
- Density overrides `--spacing` under `data-density`, scoped to page content. The shell header and sidebar do not change.
- Compact applies only at `(min-width: 1280px) and (pointer: fine)`. Touch targets then never shrink below the 44 px design target.
- Prototype density on `/manage` and `/openview` before you apply it everywhere.

**Backend:**

- Widen the `users.theme_preference` CHECK to add `system`.
- Add one JSONB `appearance` column with a strict Pydantic model: `extra="forbid"`, defaults, and a partial merge.
- Change `PATCH /users/{id}/preferences` to accept any subset of the fields.
- Rewrite the strict-shape test in `backend/tests/auth/test_provider_auth_integration.py`.

**Frontend:**

- Generalize `UserThemeProvider` into one preferences provider.
- Mirror every setting that must apply before the first paint to `localStorage`.
- Extend `theme-init.js` for `system` and the new attributes.
- Group the page as Color, Text and display, Motion, and Keyboard. Add a live preview card.

**Acceptance.**

- Each setting persists across reload. The account settings follow the person to a new device.
- The screenshots at 1440 and 390 px are correct at 125% text in both densities.
- `check-theme-contrast.mjs` passes.

### W3. Access page: security policy, admin recovery, monitoring

**Decision D1 (recommended).** Move the security policy from Manage to Access. Access already edits workspace policy (invitation settings), owns people and sessions, and has admin gating. Replace the Manage Security tab with a link. `/manage?view=security` redirects to `/access?view=security`.

**Prerequisite B4.** Extract `SecurityPolicyForm`, the security query, and the draft state from the 1,200-line `manage/page.tsx`. Do this before you add any field.

**Prerequisite checks.** Test these before you build on them:

- The 15-minute timeout probably acts as a hard 15-minute limit (see section 8).
- Confirm that `request.client.host` is the real client address behind Caddy. Several features below use the IP address.

#### W3a. Policies (new admin-only Security tab)

| # | Feature | Backend need | Size |
|---|---|---|---|
| P1 | Show the existing policy in Access | None | S–M |
| P2 | Custom password rule: minimum length 12–128, mixed case, number. This replaces the three presets. | Remove the preset check in `security_router.py`. The schema already allows it. | S |
| P3 | Common-password block list | A static list in `validate_password` | S–M |
| P4 | Idle timeout. Fix the 15-minute behavior. | Proactive refresh or a minimum value | S–M |
| P5 | Absolute session lifetime | A new column, checked against `IdentitySession.created_at` | M |
| P6 | Concurrent session limit, off by default | A new column; revoke the oldest session at sign-in | M |
| P7 | MFA requirement per role (admin, member, guest), with a grace period | New columns and a "required since" time | M |
| P8 | IP allow list editor with chips and "your address" | One endpoint that returns the caller's IP address | S |
| P9 | Sign-in lockout limits | Move the constants in `rate_limits.py` to columns | M |

Rules for the policy editor:

- The editor says "applies at the next password change". The policy never checks existing passwords.
- Saving "MFA required for everyone" is blocked unless the person who saves has MFA enrolled.

#### W3b. Admin actions on a person (new Security section in the person panel)

| # | Feature | Backend need | Size |
|---|---|---|---|
| A1 | Send a password reset email | `POST /users/{id}/recovery`. Reuse `request_recovery`. Add a security event. | S–M |
| A2 | Show the person's MFA status | `GET /users/{id}/security`. Reuse `get_admin_user`. | S |
| A3 | Reset MFA | `POST /users/{id}/mfa/reset`. Reuse `admin_delete_factor`, then revoke the person's sessions. | S–M |
| A4 | Reset and sign out everywhere | Combine A1 with session revocation: revoke first, then send. | S |
| A5 | Clear a sign-in block | Delete the rate-limit bucket. Do this after P9. | M |

Pain points and solutions for these actions:

- Pain point: a reset can be abused for account takeover. Solution: A3 requires the acting admin to have a current MFA verification (AAL2), a confirmation dialog, and a recorded event.
- Pain point: a copyable reset link creates the same takeover risk. Solution: send the reset by email only and show no link.
- Pain point: OpenSlate has no mailer of its own. Solution: A1 uses the Supabase mailer, and the UI shows a clear state when SMTP is not configured.

#### W3c. Monitoring

| # | Feature | Backend need | Size |
|---|---|---|---|
| M1 | Security events feed with filters: type, outcome, person, date | The route exists. Add the filters. | M |
| M2 | Record the missing events: sign-in success, repeated sign-in failure, lockout, IP blocked, password change, recovery, policy change | Instrument `auth/router.py` and `provider_actions.py`. Put the IP address in `metadata`. | M–L |
| M3 | People columns: last sign-in, last active, active sessions, MFA enrolled | Subqueries on `IdentitySession`, plus a local MFA projection | M |
| M4 | IP address on each session | A new `identity_sessions.ip_address` column | S–M |
| M5 | Overview cards: admins without MFA, people who never signed in, people inactive for N days | A summary counts endpoint | M |
| M6 | Organization-wide sessions table, moved from Manage | None | S |
| M7 | Retention for security events and old sessions | A purge job. Start with a fixed 365-day default. | M–L |
| M8 | Server-side paging for People. Today the page loads every user. | The list API already pages | M |

Pain point for M2: an attacker can flood the event table with failed sign-ins. Solution: record each lockout and each success. Combine repeated failures into one event per source and hour.

**Do not add now:** password expiry, password history, location-based rules, alert emails, or automatic disabling of inactive accounts.

**Order of slices:**

1. B4.
2. P1 and M6.
3. A1–A4.
4. P2, P3, P8.
5. M1 and M2.
6. M3, M4, M5, M8.
7. P4–P7, P9.
8. M7.

### W4. Record attachments and per-department file library

**Prerequisite B1.** Move the generic parts of `boards/adapters/board-files-api.ts` to a shared `/files` adapter. The generic parts are:

- The wire schema without the board fields.
- The reserve and upload steps.
- The streaming download.
- The size format and the error messages.

Make one file-list component driven by an adapter.

**W4a. Record attachments (do first; the backend is ready).**

- Add a `RecordFilesPanel` to the OpenView record inspector, next to Links and History.
- Use `purpose=record_attachment`. Access follows the record's module: read can download, write can upload and archive.
- Size: 1.5–2 days.
- Choose an attachments panel, not a `file` field type. A field type needs changes to field lifecycle, import, export, search, and the Sandbox publish flow.

**W4b. Department library:**

1. Add a migration:
   - Add `files.department_id` (FK, RESTRICT, indexed).
   - Replace `ck_files_purpose_parent`, so that `library_document` requires a department and the other purposes forbid one.
   - Edit the CHECK by hand. Alembic does not compare CHECK constraints.
2. Add a `department_id` branch to `files/access.py`:
   - read = view and download
   - write = upload
   - manage = archive and reopen
   - Guests are limited to read. Require a real department access row, not module access only.
3. Add filename search and sort by name and size to `GET /files`.
4. Add library files to the department purge plan and to `department_ancestry.py`. Department audit then shows library activity.
5. Replace the Platform File library tab with the real list. Add a department picker that shows only departments the person can read, and keep the choice in the URL (`?department=`).

Size: backend 3–4 days, UI 2–3 days.

**Defaults for decisions:**

- Allow duplicate names, and show the date and the uploader.
- No folders in version 1.
- Keep the seven file types: PDF, PNG, JPEG, DOCX, XLSX, PPTX.
- No storage cap in version 1. Add a per-department cap later.
- Only an admin purges. A department manager archives.
- Add file search to global search later.

Pain point: today only pending uploads are capped (1 GiB), so a library can fill the disk. Solution: show storage use per department in the library header now, and add a cap in a later slice.

### W5. Backup download, then in-app restore

**How backup works today.**

- A backup is a cold physical copy. The host runner stops the whole installation and copies the five volumes into an encrypted Restic repository on the host.
- The API cannot read that repository.
- A snapshot contains installation secrets in plain text, such as database passwords, signing keys, and TLS keys.

**W5a. Download (Tier 1, 6–9 days):**

1. An admin requests an export of one backup and types a passphrase.
2. The host runner copies that snapshot into a new Restic repository protected by the passphrase. The runner writes the result to an export directory, which is mounted read-only into the API.
3. The API streams the file to the admin after a password check. The API records the download.
4. The runner deletes the file after 24 hours.

Each step uses existing parts:

- The export is a new runner job type, reached through the existing bridge commands.
- The passphrase is stored encrypted with the existing Fernet key until the runner takes it.
- The export route needs its own transfer and Caddy timeout policy. The normal file limit is 25 MiB and 120 s.

**Caution:** never serve the raw snapshot. It contains the installation's private keys and passwords.

Also change the "Back up now" text: it must say that the installation goes offline during the backup.

**W5b. In-place restore (Phase D, 17–22 days).** Do this after the host runner and the Windows installer exist as code. Today the runner tick exists only as a Task Scheduler instruction.

Pain point: without a running host runner, a Restore button only queues a request and nothing happens. A failed restore also leaves the installation stopped, and a non-technical owner cannot recover it. Solution: build restore together with the installer and its tray app. The tray app owns recovery.

The design for later:

1. Take a verified backup before the restore.
2. Check that the snapshot matches the current release.
3. Stop all services, then replace the volumes.
4. Sign out every person.
5. Use a host journal as the source of truth, because the database itself is replaced.

**W5c. Import from another machine.** Defer it (14–20 days). Secret and role-password reconciliation across machines is the largest unknown.

### W6. Notifications and request feedback

#### W6a. Notifications

**Today:**

- Three producers exist: scheduled report run, post published, and event reminder.
- The bell is a link only.
- The inbox reloads by hand and marks one item at a time.
- The links do not open the exact post or event.

**Backend:**

1. Generalize `InAppNotification`:
   - Add `kind`, `subject_type`, and `subject_id`.
   - Make `work_id` nullable, with a CHECK on the allowed combinations.
   - The rows still store references only, with no private content.
2. Add `GET /notifications/unread-count`. Use a read path that does not lock the user row, and add a partial index on unread rows.
3. Add `POST /notifications/read-all`. The client refetches after it, because the event stream drops private events above 64 per commit.
4. Add `?status=unread` to the list.
5. Add new kinds, in this order:
   1. Report run failed.
   2. Backup failed.
   3. Record assigned to you (through a user field).
   4. Invitation accepted.
   5. Sandbox published.
   6. Your access changed.

**Frontend:**

1. B3: move the notification adapter and the event stream out of the OpenView folder into a shared location.
2. Mount one subscriber in the shell. Today the rule in `frontend/AGENTS.md` says that only OpenView subscribes. Change that rule (decision D8).
3. Change the bell:
   - Show an unread count, capped at 99+.
   - Use the accessible name "Notifications, N unread".
   - Open a popover with the latest 10 items, "Mark all as read", and "View all".
4. Make the titles specific. Show the report name, board name, or event title, read under the person's current access.
5. Add deep links:
   - Boards: `&post=` or `&event=`.
   - Reports: add URL state `?report=&run=`.
   - Backup: link to Manage, Backup.
   - Record: link to OpenView with `&record=`.
6. Change the inbox to use TanStack Query.

Pain point: the hub allows 4 streams per person, so a fifth tab gets no live updates. Solution: in that tab, refetch the count when the window gets focus.

#### W6b. Request feedback

**Today.** 74 of 79 request actions already give success and failure feedback. Most of it is inline; only Access uses toasts. The design system has no rule for toasts, and that is the cause of the inconsistency.

**Your request** was a toast on every success and failure.

Pain points with toasts everywhere:

- Toasts duplicate the inline notices, so screen readers announce each result twice.
- At most 3 toasts show at once, and error toasts never close. Three errors then hide every later toast.
- The change breaks 21 test files.

Solution: make the feedback consistent with one rule, and add toasts only where no inline place exists.

**The rule (add it to `DESIGN.md` first):**

| Situation | Feedback |
|---|---|
| The action runs in an open dialog, sheet, or form | Inline. The success closes the dialog **and** shows a toast. The failure stays inline. |
| The action closes or leaves the surface (create, delete, purge, navigate away) | Toast |
| A background action or one-click action in a list | Toast |
| Autosave (Sandbox) | Header status only. A failure shows a destructive inline alert. |
| Auth pages (sign in, set password, recovery) | Inline alert on the destination page |
| Any failure | `role="alert"` and the destructive variant. Never a neutral `role="status"`. |

**Work:**

1. Mount `Toaster` in the root layout, so auth pages can use it.
2. Add `lib/feedback.ts`. Base it on `comms/state/comms-feedback.ts`, with error de-duplication.
3. Add `lib/api-errors.ts`. It maps each status and error code to safe text, and maps network and contract errors to generic text. Replace the 7 local copies that show raw `error.message`.
4. Fix the 5 actions with no feedback:
   - Create board.
   - Permanently delete board.
   - Sandbox save failure, which is announced as a neutral status.
   - Invitation complete. Show "Password set. Sign in." on `/login`.
   - Recovery complete. Use the same message.
5. Separate the success and failure channels in the Boards calendar actions and the Sandbox version actions.
6. Move `MfaCleanupNotice` out of the toast corner.

Size: 3–4 days.

### W7. Organization profile in workspace settings

**Today.** The backend accepts `legal_name`, `description`, `contact_email`, `contact_phone`, `postal_address`, and `logo_file_id`, but the UI does not use them. Each regional list has 3 hard-coded items. The shell shows "OpenSlate" and "OS", not the organization.

**Work:**

1. **Profile fields (1–2 days).** Add the fields to the zod schemas, the form draft, and a new "Organization profile" section.
2. **Logo (3–4 days, needs B1):**
   - Upload PNG or JPEG of 2 MiB or less with `purpose=workspace_logo`, then send `PATCH /workspace {logo_file_id}`. SVG is rejected.
   - Show the logo in the sidebar header. If no logo exists, show the `mark` initials.
   - Change `mark` from the sample select to a free-text field.
   - Purge the old logo after a replacement.
3. **Regional lists (4–5 days):**
   - Replace the native selects with `SearchSelect`.
   - Timezones: use `Intl.supportedValuesOf('timeZone')`, with the UTC offset in each label.
   - Currencies: use a curated list of active ISO 4217 codes.
   - Locales: use a curated list with search. Label it "Regional format", because it changes formats only.
   - Before you call these settings organization-wide, connect `formatWorkspaceDate` in Boards and OpenView. Boards hard-codes `en-US` and `en-PH` today.
   - Make `week_start` drive the calendars (see section 8).

**Decision D2.** The UI says "Organization", the API says "workspace", and Comms has its own "Workspace settings" dialog. Choose one name for the Manage tab.

**Decision D9.** `GET /workspace` returns the contact email, phone, and address to every signed-in person, including guests. Confirm that this is the intent.

## 6. Migrations

Tier 1 adds these Alembic revisions on the head `3a869b1c1e34`. Add one revision per slice, in the slice's own PR.

| Slice | Change |
|---|---|
| W2a | `workspace_profiles.theme` |
| W2b | Widen `users.theme_preference` (`system`); add `users.appearance` JSONB |
| W3 | Policy columns (absolute lifetime, concurrent limit, MFA per role and grace, lockout limits); `identity_sessions.ip_address`; local MFA projection |
| W4b | `files.department_id` and the new purpose CHECK |
| W5a | Backup export operation table |
| W6a | Generalized notification columns; partial unread index |

Each route change also needs these updates:

- Regenerate `contracts/openapi.json`.
- Update `frontend/api-route-manifest.json`.
- Update the contract fixtures.

## 7. Decisions

The owner accepted these decisions on 2026-10-05. To change one, edit this table before the affected slice starts.

| ID | Decision | Accepted value | Slice |
|---|---|---|---|
| D1 | Move the security policy from Manage to Access | Yes, with a redirect | S22 |
| D2 | Name of the Manage tab: "Organization" or "Workspace settings" | Keep "Organization". "Workspace settings" is already the Comms dialog name. | S19 |
| D3 | Comms links to example records | Show "This example record is not in OpenView" | S02 |
| D4 | Permanent delete (purge) is off by default in Boards, OpenView, Sandbox, and files | Keep it off. Add a read-only `purge_enabled` field to `GET /workspace`, and hide the purge controls while it is false. | S07 |
| D5 | Personal preferences: one JSONB column or one column per setting | JSONB | S17 |
| D6 | Text size and density: per account or per device | Per device. They depend on the screen. | S18 |
| D7 | Color mode for new people | System. Existing people keep their value. | S17 |
| D8 | A shell event subscriber (changes the `frontend/AGENTS.md` rule) | Allow it, and update the rule | S14 |
| D9 | Guests see the organization contact details | No. Return contact fields to members and admins only. | S19 |
| D10 | Remove the 410 rollback route | Yes | S01 |
| D11 | Admin MFA reset requires the acting admin's MFA (AAL2) | Yes | S23 |
| D12 | Retention for security events | 365 days | S28 |

## 8. Possible bugs found during the audit

The audit found these from source reads. Test each one first, then fix it as a separate small change.

1. **The 15-minute session timeout acts as a hard limit.**
   - The JWT lives 900 s.
   - The client refreshes only after a 401.
   - The server refuses a refresh once `expires_at` has passed.
   - So an active person is probably signed out after 15 minutes.
2. **The organization's first day of the week has no effect.** The calendars compute from `getUTCDay()` and always start on Sunday (`boards/components/calendar.tsx`, `openview/components/live-calendar.tsx`).
3. **The reset does not restore four settings.** The application-data reset does not restore `currency`, `week_start`, `business_hours`, or `mark`.
4. **`/auth/token` returns 401 for a rate-limited sign-in.** `/auth/login` returns 429 for the same condition.

## 9. Not verified

- All six reports come from static reads. No test, build, or browser run was done.
- Not tested: the items in section 8, rendering at 125% text, the density mechanism, forced-colors rendering, client IP resolution behind Caddy, Restic `copy` behavior, and whether the server image has timezone data.
- The sizes are estimates.

## 10. After Tier 1

The items in Tier 2, OpenComms, and the work after OpenComms stay in that order. Tier 4 includes:

- Trigger actions beyond "Set field".
- Triggers that follow relationship links.
- Notification preferences and digests.
- Presence.
- Conversation search.
- Email delivery of reports.
- In-place backup restore, if the installer is not ready earlier.

## 11. Execution

### 11.1 Rules for the whole run

- Work in the main checkout on one branch, `codex/system-completion-tier-1`, made from `main`. Do not use a worktree.
- Make one commit for each slice. Use a Conventional Commit message, for example `feat(files): add record attachments panel`.
- Do not push, open a pull request, or rewrite history. The owner approves the push. The pre-push gate runs only then.
- Keep the scope to this plan. The plan approves the listed migrations, endpoints, and schema changes. Anything else needs the owner's approval.
- Keep Comms working. Do not edit `frontend/src/components/systems/comms/**`, except where a slice names a Comms file.
- Keep the designed UI. Extend the current components and tokens. Do not replace a designed page with a plain form.
- Write one migration for each slice that changes the schema. Run `uv run alembic upgrade head` and `uv run alembic check`.
- After a route change, regenerate `contracts/openapi.json` and update `frontend/api-route-manifest.json`.
- Record the run in `.agent-runtime/system-completion-tier-1.md` (template: `.agents/orchestration/RUN.md`). Update it after each slice.

### 11.2 Definition of done for one slice

A slice is done when all of these are true:

1. The behavior in the slice's row and in its workstream section exists.
2. New behavior has tests: pytest for the backend, and a Playwright `isolated` or `http` test for the frontend.
3. The focused tests for the changed files and their direct callers pass.
4. The backend changes pass `uv run ruff check .` and `uv run mypy app operations`. The frontend changes pass `npm run check`.
5. A slice that changes UI has screenshots at 1440×900 and 390×844, in light and dark mode, and the screenshots match the request and `DESIGN.md`.
6. A `review` worker found no unresolved defect in the diff.
7. The slice is committed, and the run record shows the evidence.

### 11.3 Slices

Do the slices in this order. A slice starts only when the slices it depends on are done.

| Slice | Content | Section | Depends on |
|---|---|---|---|
| S01 | Remove the Boards and Sandbox sample code. Remove the rollback route (D10). | W1 PR 1 | – |
| S02 | Remove the OpenView sample code. Add the example-record notice (D3). Change "Module default". | W1 PR 2 | S01 |
| S03 | Remove the Platform and Manage placeholders and sample layer. Relabel "Refresh release status". | W1 PR 3 | S02 |
| S04 | Move `SampleProvider` to the Comms layout. Remove the orphan route and SVGs. Rename the route wrappers. Update the stale docs. | W1 PR 4 | S03 |
| S05 | Test the 15-minute timeout. Fix it if the test fails. | §8 item 1 | S04 |
| S06 | Make `week_start` drive the calendars. Make the reset restore the four settings. Return 429 from `/auth/token` for a blocked sign-in. | §8 items 2–4 | S04 |
| S07 | Add `purge_enabled` to `GET /workspace`. Hide the purge controls while it is false (D4). | §7 D4 | S04 |
| S08 | Request feedback: the rule in `DESIGN.md`, root `Toaster`, `lib/feedback.ts`, `lib/api-errors.ts`, the 5 gaps, error channels. | W6b | S04 |
| S09 | Generic `/files` adapter. Move Board attachments onto it. | B1 | S04 |
| S10 | Record attachments panel. | W4a | S08, S09 |
| S11 | Department library backend and migration. | W4b 1–4 | S09 |
| S12 | Department library UI on Platform. | W4b 5 | S10, S11 |
| S13 | Notification backend: generalized model, unread count, read all, unread filter. | W6a backend 1–4 | S04 |
| S14 | Notification frontend: shared adapter and stream, shell subscriber (D8), bell and popover, titles, deep links, report URL state. | W6a frontend | S08, S13 |
| S15 | New notification kinds, in the listed order. | W6a backend 5 | S14 |
| S16 | Organization look on the server, and the anonymous appearance endpoint. | W2a | S08 |
| S17 | Personal preferences backend: `system` mode, `appearance` JSONB (D5, D7). | W2b backend | S04 |
| S18 | Appearance page, init script, text size, density, motion, shortcuts, forced-colors and focus hardening (D6). | W2b | S16, S17 |
| S19 | Organization profile fields. Hide contact fields from guests (D9). | W7 1 | S08 |
| S20 | Organization logo. | W7 2 | S09, S19 |
| S21 | Regional lists and workspace formatting in Boards and OpenView. | W7 3 | S06, S19 |
| S22 | Move the security policy into Access with a redirect (D1). | B4, W3 P1, M6 | S08 |
| S23 | Admin actions A1–A4 (D11). | W3b | S22 |
| S24 | Password rule, common-password list, IP allow list editor (P2, P3, P8). | W3a | S22 |
| S25 | Security events feed and the missing events (M1, M2). | W3c | S22 |
| S26 | People columns, session IP, Overview cards, server paging (M3, M4, M5, M8). | W3c | S25 |
| S27 | Idle, absolute, and concurrent session rules; MFA per role and grace; lockout limits (P4–P7, P9). | W3a | S05, S24 |
| S28 | Retention for security events and old sessions (D12). | W3c M7 | S25 |
| S29 | Backup export and download. | W5a | S08 |
| S30 | Update the architecture docs. Review the full branch diff. Write the final report. | §9 | all |

Out of scope for this run: in-place restore (W5b), import from another machine (W5c), OpenComms, and everything in section 10.

### 11.4 When to stop

Keep working until every slice is committed or blocked. Do not stop to report progress, and do not ask for confirmation between slices.

**Fix these yourself. They are never a reason to stop:**

- A process that you started holds a port or a lock.
- A dev server, the API, or a test server does not start.
- A dependency is missing from `node_modules` or the uv environment.
- A test is flaky, or a check fails.

Diagnose the cause, then fix it. Try at least three different fixes. Record each attempt in the run record.

**Block one slice.** A slice is blocked when one of these occurs:

- The slice needs a decision that section 7 does not cover.
- The slice needs a change outside this plan.
- The same check still fails after three different fixes.

Record the blocked slice, with its evidence, in the run record. Then continue with the next slice that does not depend on it.

**Stop the whole run only when one of these occurs:**

- No ready slice remains: every remaining slice is blocked or depends on a blocked slice.
- The Docker daemon or the Supabase stack is down, and `./scripts/dev.py db` does not recover it.
- Required credentials or secrets are missing.
- The next step needs an action that root `AGENTS.md` reserves for the owner: data deletion, volume reset, discarding user edits, rewriting history, or a push.

Before you stop, record a checkpoint in the run record: the branch, HEAD, changed files, the finished slices, the blocked slices with evidence, and the next action.

### 11.5 Servers

`next dev` allows only one dev server in each checkout, because the server holds a lock in `frontend/.next/`. The Playwright `http` project starts its own `next dev` on port 3104 through `npm run dev` with the synthetic environment.

Follow these rules:

1. Do not keep the real frontend (`npm run dev`, port 3000) running while Playwright tests run.
2. Before you start any Next server, check for one with `pgrep -fl "next dev"` and `lsof -nP -iTCP:3000,3104 -sTCP:LISTEN`. Stop each Next server that this run started.
3. For tests, start no frontend server. The Playwright configuration starts one.
4. For screenshots, start the real frontend with `npm run dev`, take the screenshots, then stop the server before the next test run.
5. Keep the Supabase stack and the API (`uv run python -m app --reload`, port 8000) running for the whole run. They do not conflict with the tests.
6. Never stop a process that this run did not start, unless it holds the Next lock in this checkout and no other session uses it.

Correct: `Screenshots done; stopped next dev on 3000; ran tests/http/record-files.spec.ts.`
Wrong: `next dev on 3000 still running; started Playwright; lock error; stopped the run.`
