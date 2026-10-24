# Profile, Account settings, and sidebar relayout: the slim identity

> **Status: approved (2026-10-25).** The owner approved the spec and the comps, and delegated the in-scope design decisions made during the work; each one is recorded in the Decisions table. Phase 0 is done (results below). The owner approved the sidebar direction and changed Profile: Profile becomes a profile people can view, and editing moves to a new Account settings page. Comps are in `.impeccable/mocks/profile/`: `sidebar.html`, `settings.html` (the editing page), and `profile.html` (the profile view). Renders are in `.playwright-mcp/profile-sidebar-relayout/comp/`. The comps use example data: a job title, a phone, three different sessions, and a "Last changed" password date. The build shows the password date only if the server sends it.

## Outcome

On 2026-10-25 the owner made the slim grammar the product identity. The grammar is the one that Access, the Sandbox, and Manage use:

- slim 32px controls from 1280px
- 40px one-line rows
- label-left rows
- summary first, then detail, in two panes
- still pages from 1280px
- quiet actions, with one primary action
- framed dialogs
- 44px targets on phones

This pass applies the grammar to the app shell (the sidebar and the header), to a new Profile view, and to a new Account settings page.

- **Profile** (`/profile`) becomes a profile that people in the same organization can view. It shows a person's photo, name, job title, phone, bio, role, and groups. A person opens their own profile at `/profile` and another person's at `/profile?person=<id>`.
- **Account settings** (`/settings`) holds everything that today's Profile page edits: identity, sign-in, appearance, and regional settings.

The shell is on every page, so after this pass every page reads as the same product. Pages that have no relayout yet keep their old layout inside the slim shell; their passes follow.

**In scope.**

- The sidebar: the rows, the organization switcher, the collapse control, the footer, the rail, and the phone drawer.
- The controls in the header. The header height stays 56px.
- The Profile view, its server read, and its visibility rule.
- The Account settings page, in the shell and in the no-organization frame, with its dialogs: email, password, two-step, sessions, and unsaved changes.
- Entry points: the sidebar account row, the header account menu, and "View profile" on the person card.

**Out of scope.**

- The content of other pages.
- The header height. A later shell pass can change it, together with every still-page height.
- New profile fields (for example an ID number, a department, or a cover photo).
- Profile links from other lists, such as Access People rows or Comms author names. They can follow later.
- New capabilities, such as session names or a password age that the server does not send.

**Preserved behavior.**

- Every capability of today's Profile page stays reachable in Account settings.
- The sidebar width and the collapsed state persist as they do now.
- Instant preference saves keep their failure and retry behavior.
- The dirty-leave guard stays.
- Server refusals stay the source of truth.
- Organization isolation stays: no account sees a profile from another organization.
- The person rule that Comms uses (`visible_person_ids`, for direct messages and presence) does not change.
- The navigation model, with its ids and descriptions, does not change. Only where the descriptions render changes.

## How the issues were found

- A code trace of Profile, the shell, the tests, and DESIGN.md.
- A baseline capture in Slate, light and dark, at 1440, 1280, and 390, with measurements (`.agent-runtime/profile-sidebar-relayout/metrics.md`, 42 screenshots in `.playwright-mcp/profile-sidebar-relayout/baseline/`).
- A hands-on pass as `ho-admin` and `ho-reader`.
- A baseline `impeccable critique` (`.impeccable/critique/2026-10-24T18-24-33Z__frontend-src-components-profile-page-tsx.md`).
- An advisor review of the layout direction.
- The owner's reference for the profile view: a public profile with the photo and name on the left and grouped facts beside it.

## Baseline (Phase 0)

| Measure                    | Baseline                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critique, Profile          | 19/40; heuristic 4 (consistency) = 1, heuristic 8 (minimalism) = 1                                                                                               |
| Critique, shell            | 28/40; heuristic 4 = 2, heuristic 8 = 3                                                                                                                          |
| Profile height at 1440×900 | 3,623px, 4.0 screens; at 1280×720, 5.1 screens; at 390, 5.8 screens                                                                                              |
| Profile controls           | 44px; every one of the 14 field labels sits above its field                                                                                                      |
| Profile words              | 15 helper sentences, 233 words                                                                                                                                   |
| Profile controls in view   | 35 by default; 2 primary buttons; 3 save models                                                                                                                  |
| Sidebar                    | 271px wide; rows 44–48px with two lines; the organization name truncates; 64px rail                                                                              |
| Header                     | 56px; search 208×44 (a link styled as a field); icon buttons 44×44                                                                                               |
| Phone                      | 2 switches at 32×18; in the drawer, 2 targets at 32px                                                                                                            |
| Requests                   | 15 reads on a cold `/profile`; no 4xx or 5xx; no console errors                                                                                                  |
| Person visibility today    | Admins see every member; members and guests see only people they share work with (`visible_person_ids`); the person card hides email, phone, and bio from guests |

## Findings

The Profile findings describe today's Profile page. Its editing moves to Account settings, so they apply there.

**Profile (today) → Account settings**

| ID    | Finding                                                                                                                                   | Source             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| P-F1  | P1. Timezone is a free-text field with its own Save, beside selects that save at once. Manage uses a searchable select.                   | critique           |
| P-F2  | The page scrolls 4–6 screens, and the section links scroll away with it.                                                                  | metrics, critique  |
| P-F3  | Three save models. "Reload profile" keeps a typed edit, and Save stays enabled.                                                           | hands-on, critique |
| P-F4  | The two-step status shows only inside its dialog. All four sessions read "Safari on macOS, 127.0.0.1", and "End session" names no device. | hands-on, critique |
| P-F5  | The password form does not say, before the change, that other devices sign out.                                                           | critique           |
| P-F6  | The preference status is mounted twice, so screen readers hear one error twice.                                                           | critique           |
| P-F7  | 233 helper words.                                                                                                                         | metrics            |
| P-F8  | The photo control is a native file input, 886px wide.                                                                                     | hands-on           |
| P-F9  | Labels sit above 44px fields. Cards sit inside cards. Card widths of 1,024, 896, and 500px leave ragged right edges.                      | metrics            |
| P-F10 | The heading is 30/700. Manage uses 30/600.                                                                                                | metrics            |
| P-F11 | At 390 the two switches are 32×18.                                                                                                        | metrics            |

**Profile view (new)**

| ID    | Finding                                                                                                                     | Source |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| P-F12 | No page shows another person's profile. The person card is the only view, and members see only people they share work with. | owner  |
| P-F13 | Role and groups are visible only to administrators, in Access.                                                              | owner  |

**Shell**

| ID   | Finding                                                                                                | Source            |
| ---- | ------------------------------------------------------------------------------------------------------ | ----------------- |
| S-F1 | The phone drawer renders in a portal, so the sidebar's 44px rule and active ink do not reach it.       | critique, metrics |
| S-F2 | "Your profile" is a button with the Manage gear icon. It has no link and no active state.              | critique          |
| S-F3 | "Search workspace…" looks like a field but is a link to Platform.                                      | critique          |
| S-F4 | Rows are 44–48px with two lines, and the organization name truncates at 271px.                         | metrics           |
| S-F5 | In the footer, "Collapse sidebar" has weight 600 and "Your profile" has weight 400.                    | hands-on          |
| S-F6 | The 0px-wide "Resize sidebar" separator is a tab stop with no visible focus.                           | hands-on          |
| S-F7 | `.impeccable/design.json` says the active item has no fill. The code and DESIGN.md use a gliding fill. | trace             |

## Breakpoints

| Width       | Shell                                                                       | Profile and Account settings                               |
| ----------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Below 768px | Two-row phone header; the drawer has 44px rows with the description visible | One column; the Account settings footer sits at the bottom |
| 768–1023px  | The drawer, as below 768px; one-row header                                  | One column; the frame scrolls                              |
| 1024–1279px | Sidebar visible; one-line rows at the 44px floor                            | One column; the frame scrolls                              |
| From 1280px | Slim: 32px rows and 32px header controls                                    | Still pages with two panes; only the panels scroll         |

## Layout direction

1. **Sidebar from 1280px** (comp `sidebar.html`, approved).
   - Workspace rows and sub-items are 32px and one line, with a 16px icon and a text-sm label.
   - The description stays in the navigation model and shows as a `title` and `aria-description` on desktop. The drawer shows it as a visible second line.
   - The default width is 240px. The resize range is 220–360px. The width persists as it does now.
   - The sidebar header has a 40px organization switcher with a 24px mark. The full organization name shows, or wraps to two lines, before it truncates. A quiet 32px "Collapse sidebar" icon button sits at the right.
   - The footer holds the OpenComms row with its unread count, then an account row: a 24px avatar, the name, and one muted line with the role. The account row is a link to the person's own profile (`/profile`), with an active state there.
   - The rail is 56px.
   - The active state stays the `--sidebar-accent` fill with `--action-text` at weight 600.
2. **Header.** The height stays 56px. From 1280px its controls are 32px. Search becomes a quiet 32px button with an icon and the word "Search". It opens Platform search, as now. The account menu holds Your profile, Account settings, and Sign out.
3. **Drawer.** The row component carries its own size and active classes, so the 44px floor and the active ink apply inside the portal. The sidebar and the drawer use one navigation hook.
4. **Profile view** (comp `profile.html`). It is a read-only page that follows the owner's reference.
   - A quiet band across the top in a surface token. It has no photo and no generated image.
   - The left column holds a 96px photo that overlaps the band, then the name and the job title. On the person's own profile, one button follows: "Account settings". Other people's profiles have no button.
   - The right column holds two label-left panels:
     - **About:** Phone, Role ("Administrator", "Member", or "Guest"), and Groups (one chip for each group the person belongs to in this organization).
     - **Bio:** the short bio, as text.
   - An empty field shows no row. A profile with no bio shows no Bio panel.
   - From 1280px the page is still. The content fits one screen.
   - A profile that is not available (another organization, an unknown person, or a person a guest cannot see) shows the notice "This profile is not available." with "Go to your profile". It has no Retry.
   - A guest sees only the photo, the name, and the job title.
5. **Account settings layout** (comp `settings.html`). It follows the pattern of Manage › Organization.
   - The header is the title "Account settings" and one meta line, with the Manage type sizes.
   - From 1280px the page is still and has two panes: the settings panel on the left and Preview on the right.
   - The settings panel uses `slim-ui` and label-left rows in four groups: Identity, Sign-in, Appearance, and Regional.
   - The route declares its layout mode. The shell gets no new pathname branch.
6. **Saving in Account settings.**
   - Identity (photo, name, job title, phone, short bio) saves through one pinned footer: the save-state chip, Discard changes when dirty, and "Save profile", which says "No changes to save." at rest. This is the page's one primary action.
   - Appearance and Regional save at once, as now, with one shared status line.
   - Timezone becomes the Manage searchable select. It saves at once, and its first option is "Organization timezone (<zone>)".
7. **Sign-in group.**
   - Email: plain text with a quiet "Change…".
   - Password: a quiet "Change…".
   - Two-step: a status word (On or Off) with a quiet "Manage…". The status comes from one extra read on page load.
   - Sessions: 40px rows with the device and browser, the IP, "This device" on the current session, the sign-in time, and a row ⋯ menu with "End session". The menu item names the device. Below the rows is a quiet "Sign out other sessions".
8. **Preview pane.** It shows only what the left pane cannot:
   - "How others see you": the person card, with a quiet "View your profile" link.
   - "Your formats": the date, the time, and an amount, rendered in the chosen formats.
   - A small appearance sample.
9. **Dialogs.**
   - Change email, Change password, and Two-step use `ui/dialog-frame.tsx`: a named close, a pinned footer, and Cancel beside the action.
   - The password dialog says "Other devices sign out after the change." before the action.
   - The alert dialogs (end session, unsaved changes) keep the plain layout.
10. **Phones.**
    - The two-row phone header.
    - Profile: the photo, name, and job title, then About, then Bio, in one column.
    - Account settings: one column, with the footer pinned at the bottom.
    - Every target is 44px, including the switch rows and the drawer.
11. **No-organization frame.** An account with no organization has no other members, so `/profile` shows only its own profile. Account settings renders without the shell, uses the same two panes from 1280px, and its container widens to fit them.

## Decisions

Each decision names what it removes.

| ID   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Removes                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| PD1  | The shell is slim from 1280px and keeps the 44px floor below. It applies the owner's identity decision.                                                                                                                                                                                                                                                                                                                                                                | 44–48px desktop rows; 44px header controls from 1280px                                                       |
| PD2  | The header stays 56px. Only its controls get the slim size.                                                                                                                                                                                                                                                                                                                                                                                                            | A height change that would touch every still page                                                            |
| PD3  | Rows are one line. The descriptions stay in the model and show as a `title` and `aria-description`, and in the drawer.                                                                                                                                                                                                                                                                                                                                                 | Two-line rows; truncated descriptions                                                                        |
| PD4  | The default width is 240px (range 220–360px), and the organization name is not truncated at the default width.                                                                                                                                                                                                                                                                                                                                                         | The 271px minimum; "Harbor Operations ..."                                                                   |
| PD5  | The footer account row links to the person's own profile, with an active state. Collapse moves to a 32px icon in the sidebar header.                                                                                                                                                                                                                                                                                                                                   | The gear-icon "Your profile" button; mixed footer weights                                                    |
| PD6  | Search is a quiet 32px button that says "Search".                                                                                                                                                                                                                                                                                                                                                                                                                      | A link that looks like a field                                                                               |
| PD7  | The drawer rows carry their own classes, through one navigation hook shared with the sidebar.                                                                                                                                                                                                                                                                                                                                                                          | 32px drawer targets; missing active ink in the drawer                                                        |
| PD8  | The resize separator keeps its keyboard control, with a visible 4px handle and a focus ring.                                                                                                                                                                                                                                                                                                                                                                           | An invisible tab stop                                                                                        |
| PD9  | Account settings (`/settings`) is a still page with two panes from 1280px, and the route declares its layout mode. `/settings/appearance` opens `/settings#appearance`.                                                                                                                                                                                                                                                                                                | 4–6 screens of page scroll; another pathname branch in the shell; editing on the Profile page                |
| PD10 | Identity saves through one pinned footer. Appearance and Regional save at once, with one status line. Timezone uses the searchable select.                                                                                                                                                                                                                                                                                                                             | "Save identity", "Reload profile", "Save timezone", the free-text timezone, the double status                |
| PD11 | Sign-in is label-left rows with status words. Sessions are 40px rows with a named "End session".                                                                                                                                                                                                                                                                                                                                                                       | The two-step status hidden in its dialog; four identical sessions; unnamed buttons                           |
| PD12 | Email, password, and two-step use the shared dialog frame. The password dialog states the sign-out before the action.                                                                                                                                                                                                                                                                                                                                                  | Plain dialogs; the inline password form                                                                      |
| PD13 | Preview shows how others see you (with "View your profile"), your formats, and an appearance sample. It repeats no fact.                                                                                                                                                                                                                                                                                                                                               | "Live preview" as a separate card; repeated facts                                                            |
| PD14 | Color is a three-option segmented control. Motion and Keyboard are switch rows with 44px targets on phones.                                                                                                                                                                                                                                                                                                                                                            | 97×127 radio tiles; 32×18 phone switches                                                                     |
| PD15 | The Account settings header uses the Manage sizes: the title and one meta line.                                                                                                                                                                                                                                                                                                                                                                                        | The 30/700 heading; the section link bar                                                                     |
| PD16 | Profile (`/profile`, `/profile?person=<id>`) is read-only: photo, name, job title, phone, bio, role, and groups. Only the person's own profile has a button, "Account settings". The URL uses a query value because the app is a static export.                                                                                                                                                                                                                        | Editing on the Profile page; the only view of another person being the small person card                     |
| PD17 | Who can view a profile (owner decision, 2026-10-25): administrators and members see every active member of the bound organization; guests keep the current rule (`visible_person`) and see only the photo, name, and job title; no account sees another organization. A new read, `GET /api/users/{id}/profile`, carries this rule. `visible_person_ids` (Comms) does not change. The avatar read follows the profile rule, so a photo shows wherever its profile can. | Member profiles limited to shared work; a photo that the profile shows but the avatar read refuses           |
| PD18 | The profile layout follows the reference: a quiet band, the photo and name on the left, About and Bio on the right as label-left panels, empty fields hidden.                                                                                                                                                                                                                                                                                                          | A cover photo; the 9 cards of today's Profile                                                                |
| PD19 | Entry points: the sidebar account row and the header account menu open your profile; the account menu also opens Account settings; the person card gets "View profile".                                                                                                                                                                                                                                                                                                | Profile reachable only through a gear-icon button                                                            |
| PD20 | A profile that is not available shows "This profile is not available." with "Go to your profile", and no Retry, as in the Manage notice pattern.                                                                                                                                                                                                                                                                                                                       | A raw 404 page; a Retry that cannot succeed                                                                  |
| PD21 | Phase 1: Search stays a link (it opens Platform search) with the name "Search workspace" and the visible word "Search": a quiet sunken 32px control from 1280px, 44px below, icon only on phones.                                                                                                                                                                                                                                                                      | The field-shaped "Search workspace…" link; a change of role that would break every journey that opens search |
| PD22 | Phase 1: every browser stored the old 271px default on load, so a stored 271 opens at the new 240px default. Double-click on the separator resets to 240px; Home and End go to 220 and 360px.                                                                                                                                                                                                                                                                          | Existing browsers keeping 271px; a reset that went to the minimum                                            |
| PD23 | Phase 1: the sidebar header keeps two controls, the 24px mark as its own link to the workspace home and the organization menu with the name, then the collapse button. The rail stacks the three. Below 1280px the 44px targets leave less room, so a long name wraps to two lines and then truncates; the full name stays in the tooltip and the accessible name.                                                                                                     | Merging the home link into the switcher, which would remove the workspace home link                          |
| PD24 | Phase 1: the rail is 3.5rem (56px at 100% text), so it scales with the text size like the sidebar width. Rail targets are 44px below 1280px and 32px from 1280px.                                                                                                                                                                                                                                                                                                      | The fixed 64px rail; 32px rail targets below 1280px                                                          |
| PD25 | Phase 1: the account row is named "Your profile, <name>", with the role as a muted second line. Before the identity loads it reads "Your profile" with a generic person icon.                                                                                                                                                                                                                                                                                          | The gear-icon "Your profile" button with no link                                                             |
| PD26 | Phase 1 review: in the rail the organization mark is the organization menu trigger, named "Organization: <name>". The menu's first item is "Workspace home", so the home link of PD23 stays reachable. The expanded sidebar keeps the separate mark link.                                                                                                                                                                                                              | The rail's separate home link and its lone up-down chevron button                                            |

## Server read (Phase 2)

The backend work follows `.agents/skills/fastapi-backend-patterns/SKILL.md` and `fastapi-api-design/SKILL.md`.

- `GET /api/users/{user_id}/profile`, in `backend/app/systems/access/users/router.py`.
  - Response for administrators and members: `display_name`, `job_title`, `phone`, `bio`, `avatar_url`, `role` (the membership role in the bound organization), and `groups`, a list of `{id, name}` for the person's groups in the bound organization, sorted by name.
  - Response for guests: `display_name`, `job_title`, and `avatar_url`, through the current `visible_person` rule.
  - The target must hold an active membership in the bound organization. Otherwise the response is 404 `person_not_found`, the same code as the person card.
  - `Cache-Control: private, no-store`, as the person card.
- `GET /api/users/{user_id}/avatar` accepts the same rule, so a member can see the photo of any member of their organization.
- The rule lives in `person_visibility.py` as a separate function. `visible_person_ids` keeps its callers and its behavior.
- Tests: PostgreSQL integration tests for a member viewing a member they share no work with (allowed), a guest (limited fields), another organization (404), a removed member (404), and the avatar read.

## Shared files outside Profile

- `frontend/src/components/app-shell.tsx`, `app-navigation.tsx`, and the sidebar rules in `frontend/src/app/globals.css`: the slim rows, the header controls, the drawer classes, the footer, and the account menu.
- `frontend/src/components/app-page.tsx`: the no-organization frame width.
- `frontend/src/components/workspace-navigation.ts`: no change to the model. The hook may move here.
- The person card component: one "View profile" link.
- `backend/app/systems/access/users/`: the profile read and its visibility rule.

## Phases

Each phase ends with:

- tests that fail first
- one code review
- targeted screenshots: no sweep, because the owner checks the live app
- the budget spec (`comms-js-budget`), because every phase touches shell or shared code

| Phase | Content                                                                                                                                                | Proof                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Discovery (done)                                                                                                                                       | This spec, the baseline, the comps                                                                                                      |
| 1     | The shell alone: PD1–PD8, plus the account menu items of PD19                                                                                          | The still-page tests of Access, the Sandbox, and Manage; `workspace-orientation`; the 21 files that name the sidebar; `comms-js-budget` |
| 2     | The profile read and the Profile view: PD16–PD20, and the server read                                                                                  | Backend integration tests; new HTTP tests for own, other, guest, and unavailable profiles                                               |
| 3     | The Account settings layout: PD9, PD13, PD15, and label-left rows                                                                                      | `profile`, `profile-context`, `profile-regional` (moved to Account settings); still at 1280×720                                         |
| 4     | Saving and Sign-in: PD10–PD12, PD14                                                                                                                    | `profile`, `platform-account-controls`, `auth-email-change`, `user-theme-preferences`                                                   |
| 5     | Phones and the no-organization frame                                                                                                                   | 44px sweeps at 390 (Profile, Account settings, the drawer); a no-organization frame check                                               |
| 6     | Plain words: a glossary table                                                                                                                          | The glossary; a guard for internal words, as in Manage                                                                                  |
| 7     | Review: critique, `ui-reviewer`, and a hands-on pass as `ho-admin`, `ho-reader` viewing `ho-admin`, `ho-guest`, and an account in another organization | Exit criteria                                                                                                                           |

**Phase 1 results (2026-10-25).** The slim shell shipped in `app-shell.tsx`, `app-navigation.tsx`, `organization-menu.tsx`, the bell and Help triggers, and `globals.css` (the `.app-shell` row rules moved onto the rows). New owner: `tests/http/app-shell.spec.ts`, 6 journeys, red before the change and green after. Decisions PD21–PD25. Screenshots: `.playwright-mcp/profile-sidebar-relayout/phase-1/`. Access and the Sandbox stay still at 1280×720 (document 720 of 720), and Manage at 1440×900. The account row is current on any `/profile` path; Phase 2 limits it to the person's own profile, without `?person=`.

## Exit criteria

| ID      | Criterion                                                                                                                                                                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXIT-1  | A new critique finds no P1. Account settings heuristics 4 and 8 score 3 or more. The shell's heuristic 4 scores 3 or more.                                                               |
| EXIT-2  | Every Account settings action that changes data gives feedback before, during, and after it runs.                                                                                        |
| EXIT-3  | Account settings helper words fall to 60 or fewer. Default-visible controls do not rise above 35 unless the spec records the addition. Every capability stays reachable.                 |
| EXIT-4  | Every finding P-F1 to P-F13 and S-F1 to S-F7 has a test that failed first, or a recorded reason.                                                                                         |
| EXIT-5  | The Profile, Account settings, and shell tests, the backend tests, the still-page tests of Access, the Sandbox, and Manage, the budget spec, and the static checks pass.                 |
| EXIT-6  | `ui-reviewer` returns "ship".                                                                                                                                                            |
| EXIT-7  | A hands-on pass finds no open defect. A member sees another member's full profile, a guest sees the limited profile, and an account in another organization sees the notice.             |
| EXIT-8  | From 1280px, Profile and Account settings do not scroll the page at 1280×720, 1440×900, or 1920×1080. Access, the Sandbox, and Manage stay still. Nothing scrolls sideways below 1280px. |
| EXIT-9  | Every target is at least 44px at 390, the drawer included. Every field edge is at least 3:1 in the four looks.                                                                           |
| EXIT-10 | The owner approves the result in the live app.                                                                                                                                           |

## Risks

| Risk                                                                                                               | Solution                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The shell is on every page, so Phase 1 can break the three relayout pages.                                         | Phase 1 ships alone. It runs their still-page tests and the 21 files that name the sidebar.                                                                                                |
| Members now see the phone, bio, and groups of every member, not only of people they share work with.               | This is the owner's decision (PD17). Guests stay limited, the organization boundary stays, and an empty phone shows no row. A per-person "hide my phone" setting can follow if people ask. |
| Group names can tell members how the organization is set up (for example a private review group).                  | The owner chose to show groups. Administrators can rename a group that should not read as sensitive. A later "hidden group" flag is possible.                                              |
| Moving editing from `/profile` to `/settings` breaks bookmarks and links to `/profile#look` and the other anchors. | `/settings/appearance` and the old anchors open the matching Account settings group. In-app links move to `/settings` in Phase 3.                                                          |
| The pages without a relayout look heavier beside a slim shell.                                                     | Their passes follow, page by page. Their content does not change in this pass.                                                                                                             |
| One-line rows hide the descriptions that help people who are new to the product.                                   | The descriptions stay in the model, the `aria-description`, the drawer, and each page's meta line.                                                                                         |
| `workspace-orientation.spec.ts` couples the sidebar resize to Profile controls.                                    | It runs in Phase 1 and again in Phase 3, so each change meets it alone.                                                                                                                    |
| The two-step status costs one more read on every Account settings load.                                            | One bounded read, recorded here, as the Backup last-good read was.                                                                                                                         |
| Development data makes every session look the same.                                                                | Rows also show the sign-in time and "This device". Better device names need server data and are out of scope.                                                                              |
