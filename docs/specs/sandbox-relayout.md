# Sandbox relayout: the Access grammar

> **Status: approved (2026-10-23).** The owner approved the spec with both recommendations (S4: hide the Sandbox from non-administrators; S9: fold automatic saves by their system labels) and delegated later in-scope design decisions to the implementer, who records each one in the Decisions table. Phase 0 is done. The comps for Triggers and History are in `.impeccable/mocks/sandbox/` (renders in `.playwright-mcp/sandbox-relayout/comp/`).

## Outcome

The Sandbox uses the same layout grammar as Access. The parts of that grammar are:

- slim controls
- 40px rows
- label-left rows
- quick filters
- Advanced last
- summary first, then detail

A person scans a list, opens one item, and edits it in one place. Each section has one main action, and every button says what it does.

**In scope:** the Sandbox page (`/sandbox`). This covers:

- the header
- Build (Properties, Structure, and nothing selected)
- Triggers, Test, and History
- the Sandbox dialogs and menus
- their 390px layouts
- the way a non-administrator reaches the Sandbox

**Out of scope:**

- The canvas itself. The "Sandbox canvas (signature)" section in DESIGN.md stays as it is: frames, table cards, lines, labels, Key, and minimap.
- Other pages.
- Backend contracts, schema, and wire formats.
- New capabilities such as bulk trigger actions.
- Autosave for triggers.

**Preserved behavior:**

- Every capability stays reachable.
- URLs and section names stay the same (`?section=build|triggers|test|history`).
- The draft, autosave, conflict, and publish behavior stay the same.
- Triggers keep the explicit **Save triggers** (October D1).
- Restore keeps its confirmation: "Your current draft is saved as a checkpoint first."
- The two compare selects keep their paging and missing-version behavior. Their tests protect it (October Phase 6 decision).

## How the issues were found

1. **Baseline sweep.** 17 states at 1440×900 and 390×844, in the four looks, light and dark, on the production export with Harbor Operations Group data, signed in as an administrator. The files are in `.playwright-mcp/sandbox-relayout/baseline/`. There are 16 desktop contact sheets (`1440/desk-*`) and 8 phone sheets (`390/sheet-*`). The sweep changed no Sandbox data.
2. **Baseline numbers.** Helper words and default-visible controls per state, control sizes, field edges, targets, and still page. See `.agent-runtime/sandbox-relayout/metrics.md`.
3. **Hands-on pass.** Done as `ho-admin` and `ho-manager`. The screenshots are in `.playwright-mcp/sandbox-relayout/handson/`.
4. **Design critique (`impeccable critique`).** Two isolated assessments, a design review and the detector, scored the Sandbox 25/40 with one P1. The detector found nothing. Archive: `.impeccable/critique/2026-10-23T14-54-15Z__frontend-src-components-systems-sandbox-page-tsx.md`.
5. **Comps.** Triggers and History, built on the app's current tokens and the Access comp base.

## Baseline (Phase 0)

| Measure (1440, Slate dark)                        | Baseline                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger list rows                                 | 64px (Access rows: 40px)                                                                                                                                                        |
| History rows                                      | 66–86px                                                                                                                                                                         |
| Fields, median                                    | 40px (Access slim: 32px)                                                                                                                                                        |
| Text buttons, median                              | 36px                                                                                                                                                                            |
| Helper words: Test                                | 66 (10 lines)                                                                                                                                                                   |
| Helper words: History compare                     | 46 (7 lines)                                                                                                                                                                    |
| Controls: Triggers                                | 34                                                                                                                                                                              |
| Controls: Build, module selected / field expanded | 25 / 31                                                                                                                                                                         |
| Still page at 1280×720, 1440×900, 1920×1080       | No document scroll                                                                                                                                                              |
| Horizontal overflow at 390                        | None                                                                                                                                                                            |
| Critique                                          | 25/40. Heuristic 4 (Consistency) scores 2 and heuristic 8 (Minimalism) scores 2. The 10-18 run scored 27; this run judges against the Access grammar and adds the manager role. |
| Field edges below 3:1                             | Test "Name" in the four dark looks: 2.58–2.83 (an unearned error edge)                                                                                                          |
| Targets below 44px at 390                         | Required checkbox 16×16, trigger switch 32×18, "Delete trigger" menu item 150×32, canvas field rows (canvas content)                                                            |

## Findings

| ID  | Pri | Area     | Finding                                                                                                                                                                                                                                           | Evidence                                          |
| --- | --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| F1  | P1  | Access   | A department manager sees Sandbox and its four sections in the sidebar. Each section shows only "You do not have permission to perform this action." and a primary Retry. Retry sends the same refused requests again, and the page has no title. | `handson/manager-build-1440.png`                  |
| F2  | P1  | Triggers | The switch label always reads "On", even when the trigger is off (October D4). Only Off triggers show a state in the list.                                                                                                                        | `handson/admin-triggers-1440.png`                 |
| F3  | P1  | Test     | Test opens on an old result for a different module than the setup shows. The Name field shows an error before anyone types, so in the dark looks its edge reads 2.6–2.8:1. Run test on an empty setup stores a failed run.                        | `handson/admin-test-1440.png`, `-after-run.png`   |
| F4  | P2  | History  | Compare puts the newest version first as "Before" and the oldest as "After", so additions read as losses. There are two compare entry points with different defaults.                                                                             | `handson/admin-history-1440-compare.png`          |
| F5  | P2  | History  | Automatic saves ("Before restore", "Before discard") carry the same "Checkpoint" word as a person's own checkpoints. 10 of 17 rows share two names, and rows are 66–86px.                                                                         | `handson/admin-history-1440.png`                  |
| F6  | P2  | History  | "Restore version" is a full-width button with the same weight as Compare.                                                                                                                                                                         | `handson/admin-history-1440.png`                  |
| F7  | P2  | Build    | The module Properties panel is 1256px tall. The relationships list shows twice. The Advanced label "Advanced · 1 set" does not say what is set.                                                                                                   | `handson/admin-build-1440-advanced-open.png`      |
| F8  | P2  | Build    | After a deselect, "Nothing selected" shows two lines and an empty column. Build opens on Products at 100% on one department, and Structure opens on a different department than the canvas.                                                       | `handson/admin-build-1440-nothing-selected.png`   |
| F9  | P3  | Header   | Undo and Redo are greyed outline buttons with no reason. The ⋯ menu has the same weight as Review & Publish.                                                                                                                                      | `handson/admin-header-menu.png`                   |
| F10 | P3  | Triggers | The flow preview column repeats the settings column. The settings column keeps its scroll position on a trigger change, so a new trigger can open in the middle of its form.                                                                      | `handson/admin-triggers-1440-settings-bottom.png` |
| F11 | P3  | Dialogs  | Review & Publish says "7 changes, all changed: 7 triggers". Its title ("Review and publish") does not match its button. The password field and both buttons share one tight row.                                                                  | `handson/admin-review-publish-1440.png`           |
| F12 | P3  | Phone    | The header, chip, and buttons take about 230px before content. The sticky Run test covers the Test Advanced block.                                                                                                                                | `handson/admin-test-390.png`                      |
| F13 | P3  | Build    | Icon-only buttons in the Structure search row. Commands are hidden in the View menu.                                                                                                                                                              | Critique, heuristic 6                             |
| F14 | P3  | Build    | The minimap covers a module card (Stock Counts) at the default zoom.                                                                                                                                                                              | `baseline/1440/*/02-build-module.png`             |
| F15 | P3  | Test     | The same facts repeat three times: setup, result, and field comparison.                                                                                                                                                                           | Critique, heuristic 8                             |
| F16 | P3  | Words    | Help exists only in Build. The Connect modules dialog still says "One-to-many" (`designer.tsx:1646`).                                                                                                                                             | Critique, heuristics 2 and 10                     |

## Layout direction

The comps show Triggers and History. The other sections follow the same rules.

1. **Every section.**
   - Slim controls from 1280px: 32px fields and buttons, sunken Slate wells with a 3:1 bottom rule, and other looks at the slim sizes. Below 1280px the 44px floor stays.
   - The page title names the section ("Build", "Triggers", "Test", "History"), as Access does, and the save-state chip sits under it.
   - Review & Publish stays the one primary action. The ⋯ menu becomes a quiet icon button.
2. **Build.**
   - Undo and Redo become quiet icon buttons with tooltips. When disabled they give a reason.
   - Properties uses label-left rows and quiet actions.
   - With nothing selected, Properties shows a summary: counts, then "needs attention" rows (unpublished changes, triggers that are off, modules with no fields, overlaps), each with one action.
   - The canvas opens fitted.
   - Structure follows the canvas selection.
3. **Triggers.** Two panes: list and detail.
   - **List:** 40px rows with a state dot and word (On, Off), the name, and the event word. Above the list sit a search and All / On / Off quick filters with counts. There is no Filters popover, because one status is the only filter the data needs.
   - **Detail:** Name and Status as label-left rows. Status is a switch with the word "On" or "Off".
   - **Flow:** When, If, and Then sit on one rail with label-left rows inside each step. The rail is the flow preview, so the separate preview column goes away.
   - **Recent activity:** closed, last in the detail.
   - **Save bar:** the D1 Save bar stays.
   - **Scroll:** opening another trigger starts at the top.
4. **Test.**
   - Setup uses label-left rows.
   - A result shows only when it matches the current setup. Otherwise the result column says "Run a test to see the result".
   - Setup fields show an error only after a run fails, beside the field that caused it. Run test first checks the required values; a missing value shows beside its field and stores no run.
   - The phone Run test bar never covers content.
5. **History.** Two panes: list and detail.
   - **List:** 40px rows grouped by day, each with a kind icon and word, the label, the time, and the version number. Above the list sit a search and quick filters (All, Checkpoints, Published, Imported). Automatic saves fold into one row ("6 automatic saves hidden · Show").
   - **Detail:** the version header carries the label, kind, version number, and a quiet Restore button. Restore keeps its confirmation.
   - **Facts:** label-left rows (Saved, Contains, Note).
   - **Compare:** inside the detail. The Older and Newer selects are ordered from older to newer, and the version before this one is preselected. Changes show as rows with an added, removed, or changed tag.
   - **Advanced:** Edit label and note, and Delete version.
6. **Dialogs.**
   - A pinned header and footer and a named close button.
   - Review & Publish uses one name on the button and the title, and a plain summary ("7 trigger changes"). The password field gets its own row.
7. **Phone.**
   - The header is the title row with Review & Publish as a 44px button and the ⋯ menu, then the chip.
   - A list opens its detail on its own screen with a back link, as in the comps.
8. **Who reaches the Sandbox.**
   - The Sandbox is for administrators (`docs/architecture/21-glossary.md`). The sidebar hides it for other accounts.
   - A direct link shows the Access notice pattern: "Sandbox is not available to your account."

## Decisions

Each decision names what it removes and, where it changes an October decision, which one.

| ID  | Decision                                                                                                                                                                                                                                                                                               | Removes                                                                                     | Amends                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| S1  | One shared slim control set. The control skin moves from `.access-ui` to a new `.slim-ui` class; `.access-ui` keeps only the Access page layout rules. Access roots carry both classes, and the Sandbox root, dialogs, and menus carry `.slim-ui`. No alias: one rename, guarded by the Access suites. | Sandbox 40–44px fields and 36px buttons from 1280px                                         | DESIGN "Access slim controls" becomes "Slim controls" |
| S2  | The section title names the section, and the chip sits under it.                                                                                                                                                                                                                                       | "Sandbox" as the title on every section                                                     | —                                                     |
| S3  | Undo, Redo, and ⋯ become quiet icon buttons. Disabled ones give a reason.                                                                                                                                                                                                                              | Outline Undo and Redo; the boxed ⋯                                                          | —                                                     |
| S4  | The Sandbox nav is hidden for non-administrators, and a direct link shows "Sandbox is not available to your account."                                                                                                                                                                                  | The 403 page with Retry                                                                     | —                                                     |
| S5  | Triggers use two panes. The When/If/Then rail is the editor, and the step-click focus survives as direct editing.                                                                                                                                                                                      | The flow preview column                                                                     | October Triggers "Flow preview: E (desktop column)"   |
| S6  | Trigger Status is a label-left row whose word reads On or Off. Every list row shows a dot and a word.                                                                                                                                                                                                  | The switch labelled "On" in both states                                                     | October D4                                            |
| S7  | Trigger list quick filters: All, On, Off.                                                                                                                                                                                                                                                              | — (adds no popover)                                                                         | —                                                     |
| S8  | History uses two panes, with Compare inside the version detail. The selects are Older and Newer, ordered from older to newer.                                                                                                                                                                          | The middle "Compare versions" column; the second "Compare with" entry; "Before" and "After" | October History "Compare with…"                       |
| S9  | Automatic saves fold into one row. The page infers them from the two labels the system writes ("Before restore" from the server, "Before discard" from the page).                                                                                                                                      | Automatic saves mixed with a person's own checkpoints                                       | —                                                     |
| S10 | Restore is a quiet button in the version header and keeps its confirmation. Delete stays in Advanced.                                                                                                                                                                                                  | The full-width Restore button                                                               | —                                                     |
| S11 | Test shows a result only for the current setup. The setup shows no error before a run. Run test checks the required values first.                                                                                                                                                                      | The stale result on load, unearned error edges, and empty failed runs                       | —                                                     |
| S12 | Build "nothing selected" becomes a summary with "needs attention" rows. Properties uses label-left rows. Advanced names its contents. The duplicated relationships list goes away.                                                                                                                     | The empty column; the second relationships list                                             | —                                                     |
| S13 | Phone header: one title row and the chip.                                                                                                                                                                                                                                                              | About half of the 230px the phone header takes today                                        | —                                                     |

## Open questions for the owner

1. **Automatic saves (S9).** No version field marks a save as automatic, so the page infers it from two labels. A person who names a checkpoint "Before restore" would see it folded away. Option: a server field. That is a backend change and outside this pass, so it goes to the follow-ups list. Recommendation: accept the label rule for now and list the field as a follow-up.
2. **Managers (S4).** Recommendation: hide the Sandbox, as the glossary says it belongs to administrators. If managers should later design their own departments, that is a new capability with its own spec.

## Shared files outside the Sandbox

Each change stays small and only adds behavior:

- `frontend/src/app/globals.css`: the slim class rename with an alias (S1).
- `frontend/src/components/workspace-navigation.ts`: hide the Sandbox for non-administrators (S4).
- Possibly `frontend/src/components/ui/*`, for a primitive the Sandbox needs that Access already added. Each such change is listed in its phase.

## Phases

Each phase ends with:

- tests that fail first
- one review
- screenshots at 1440 and 390
- the budget specs (`comms-js-budget` and any other budget spec) when the phase touches shared shell or `ui/` code

| Phase | Content                                                                                                                                           | Proof                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0     | Discovery (done)                                                                                                                                  | This spec, baseline, comps                                                     |
| 1     | S1 slim controls rollout; S2 titles; S3 header; S4 nav and notice                                                                                 | Access and Sandbox suites; Access screenshots unchanged except the class name  |
| 2     | Triggers: S5, S6, S7; the scroll reset                                                                                                            | `sandbox-triggers` and the related specs; the 390 list and detail              |
| 3     | History: S8, S9, S10                                                                                                                              | `sandbox-history`; the paging and missing-version tests keep passing unchanged |
| 4     | Test: S11; the 390 Run test bar; each fact said once (F15)                                                                                        | `sandbox-test`                                                                 |
| 5     | Build: S12, fitted first load, Structure follows the selection, named Structure buttons (F13), the minimap clear of content (F14)                 | `sandbox-inspector`, `sandbox-sweep`                                           |
| 6     | Dialogs and phone: Review & Publish, S13                                                                                                          | `sandbox-header`                                                               |
| 7     | Plain-words glossary for owner approval (for example "Automatic save", "Older" and "Newer", "One-to-many"); one short help line per section (F16) | Glossary table in this spec                                                    |
| 8     | 390 sweep in the four looks, light and dark; still page; critique; `ui-reviewer`; hands-on as `ho-admin` and `ho-manager`                         | Exit criteria                                                                  |

## Exit criteria

| ID      | Criterion                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EXIT-1  | A new `impeccable critique` run has no P1. Heuristics 4 and 8 score 3 or more (baseline: 2 and 2).                                                                                      |
| EXIT-2  | Each Sandbox action that changes data gives feedback before, during, and after (the R2 ladder from October).                                                                            |
| EXIT-3  | Helper words and default-visible controls are not higher than the baseline in any measured state, unless the spec records an owner-approved addition. Every capability stays reachable. |
| EXIT-4  | Every finding F1–F16 has a test that failed first, or a recorded reason why none applies.                                                                                               |
| EXIT-5  | All Sandbox isolated and HTTP tests pass, the budget specs pass, and the frontend static checks are clean.                                                                              |
| EXIT-6  | `ui-reviewer` returns "ship" on the final screenshots: 1440 and 390, light and dark, the four looks.                                                                                    |
| EXIT-7  | A hands-on pass as `ho-admin` finds no open defect. `ho-manager` sees the "not available" notice and no Sandbox nav.                                                                    |
| EXIT-8  | From 1280px, no Sandbox state scrolls the page at 1280×720, 1440×900, or 1920×1080. Below 1280px nothing scrolls sideways.                                                              |
| EXIT-9  | Every field edge is at least 3:1 in the four looks, light and dark. Targets are at least 44px at 390. Canvas content is excluded; the Structure tree is its keyboard route.             |
| EXIT-10 | The owner approves the 390px sweep.                                                                                                                                                     |

## Risks

| Risk                                                                    | Solution                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The class rename shifts Access.                                         | Keep the old class as an alias while it moves. The Access suites and a screenshot diff of the Access states are the guard. |
| 7 Sandbox HTTP specs and 29 isolated specs pin selectors and words.     | Keep the accessible names unless the name is the fix. Every changed assertion gets a ledger row.                           |
| The rail editor and the D1 Save bar can disagree about what is unsaved. | One owner for the trigger draft (`use-trigger-draft.ts`). The rail only renders it.                                        |
| The comps use short names, but real trigger names are long.             | Rows truncate with the full name in the detail. Phase 8 checks long names in the hands-on pass.                            |
| Inferring automatic saves from their labels is fragile (S9).            | The label rule lives in one function with a test, and the follow-up proposes a server field.                               |
