# Sandbox follow-up pass

> **Status: approved (2026-10-18), P5–P11 included; implementation in progress.** It continues `docs/specs/sandbox-ui-ux-pass.md` (approved and complete through Phase 9).

## Outcome

The Sandbox keeps unsaved trigger edits safe in every exit path. It warns when departments or modules overlap on the canvas, and Auto-arrange never makes an overlap. Desktop controls render at their designed size. The Structure outline works fully from the keyboard. Customer copy uses plain words. All open review items are closed.

**In scope:** the Sandbox page (`/sandbox`) and the shared parts it uses. The size fix in `globals.css` is shell-wide, but today every affected control is in the Sandbox.

**Out of scope:** other pages, backend contracts, schema and wire formats, and trigger autosave (decision F1 keeps explicit Save).

**Preserved behavior:** every capability stays reachable. Stored values do not change; for example, the field type `Integer` stays `Integer` in the document even if its label changes.

## Decisions (2026-10-18)

| ID  | Decision                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Triggers keep the explicit **Save triggers** (D1 stands). Strengthen the guardrails around it.                                                     |
| F2  | Overlap on the canvas covers departments **and** modules. Show a canvas notice with **Auto-arrange** (option B); do not move frames by force.      |
| F3  | The selected trigger step uses the grey ink tint on its flow card and a thin grey rule on its settings section (option C). No blue edges or rings. |
| F4  | Resolve every open item from the exit reviews, small ones included.                                                                                |
| F5  | Do the three follow-up cards in this pass: desktop sizes, the outline tree, and the plain-language pass.                                           |

## Findings (evidence)

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                | Evidence                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| R1  | **Likely data loss:** the browser Back button can drop unsaved trigger edits with no question. Sections are URL parameters (`?section=triggers`); the guards cover app links, section buttons and tab close, but nothing listens to `popstate`.                                                                                                                                                                                                        | `page.tsx` guards (~585–660); no `popstate` handler in `src/`                   |
| R2  | **Likely data loss:** when the page loads a fresh draft (for example after a save conflict is reloaded), the studio replaces its draft with the new triggers, and unsaved edits go with it.                                                                                                                                                                                                                                                            | `trigger-studio.tsx` `useEffect(() => setDraft(triggers), [triggers])`          |
| R3  | Unsaved trigger edits live only in memory. A crash, a forced reload, or "Leave" on the browser prompt loses them.                                                                                                                                                                                                                                                                                                                                      | No draft storage in the studio                                                  |
| R4  | Save is the first moment a person learns that a trigger is incomplete, and the list does not show which triggers have unsaved changes.                                                                                                                                                                                                                                                                                                                 | Validation runs on save (`trigger-studio.tsx` save path)                        |
| R5  | Nothing detects overlapping frames or modules. **Likely:** Auto-arrange can itself make module overlaps. It spaces rows by the stored height (176 px when none is stored), but a table is drawn at its real height (34 px header + 26 px per field). The canvas stores the drawn height only after a drag, so a module that was never dragged, or that got fields after its last drag, can reach into the next row. Confirm with a failing test first. | `designer-layout.ts` `arrangedLayout`; `canvas-geometry.ts` `moduleTableHeight` |
| R6  | A shell rule keeps `min-h-11`, `min-w-11` and `size-11` at 44 px with `#main-content` specificity, so desktop overrides such as `xl:min-h-9` never apply. About 33 Sandbox controls render 44 px on desktop.                                                                                                                                                                                                                                           | `globals.css` ~831 (from `e9f38992`, the compact-density floor)                 |
| R7  | The Structure outline has no tree semantics: every row and "Add field" is a Tab stop (60 or more on a template), and screen readers hear "Select module …, button" with no level or open state.                                                                                                                                                                                                                                                        | `sandbox-inspector-outline.tsx`; 11 test selectors use these names              |
| R8  | Customer copy uses technical words: One-to-many, Integer, Date/Time, UUID, JSON, "proposed document is still local", "Live state", "Event module", and "module" itself (about 63 UI strings).                                                                                                                                                                                                                                                          | Exit critique P2; PRODUCT.md word list                                          |

`ui-ux-pro-max` returned no verified match for tree keyboard patterns or draft recovery; the plan uses the WAI-ARIA tree pattern and the existing Build "Unsaved" badge as references.

## Phases (in priority order)

Each phase ends with its focused tests, the Sandbox batch (lint, build, isolated, the seven Sandbox HTTP specs), its behavior-map rows, a DESIGN.md entry for any new pattern, and one commit. UI phases also take screenshots at 1440 and 390, light and dark. Phases run one after another in this checkout: they share files, and the HTTP runner refuses a build that is older than the sources.

| Phase                  | Size | Why this place in the order                                                  |
| ---------------------- | ---- | ---------------------------------------------------------------------------- |
| 1. Trigger guardrails  | L    | Data safety comes first.                                                     |
| 2. Desktop sizes       | S    | It changes control heights, so it goes before the visual phases are checked. |
| 3. Canvas overlap      | M    | A real defect on the signature surface.                                      |
| 4. Outline tree        | M    | Accessibility; it builds on the phase 2 sizes.                               |
| 5. Polish              | M    | Eleven small items.                                                          |
| 6. Plain-language pass | M    | It touches strings everywhere, so it goes last, after an approval gate.      |

### Phase 1: trigger guardrails (data safety)

| ID  | Change                                                                                                                                                                                                                                                                                                        | Proof                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| G1  | Back and Forward never lose unsaved triggers. Write the failing test first to confirm R1. First try: Back opens **Save · Discard · Stay**, and Stay restores the URL. Fallback, if the router fights the guard: the page holds the trigger draft, so leaving Triggers keeps it, and returning shows it again. | HTTP: edit, press Back, then either the dialog shows or the edit is still there on return |
| G2  | A fresh draft never replaces unsaved trigger edits silently. Reproduce it first through a trigger-save conflict. If **Reapply** already keeps the edits, fix only the gap, for example Reload's text saying trigger edits are dropped.                                                                        | HTTP conflict journey                                                                     |
| G3  | Unsaved trigger edits survive a reload or crash. Keep them in local storage, keyed by user, organization and draft; on return show "Restore unsaved trigger changes?" with **Restore** and **Discard**. Clear them after Save, Discard or organization switch.                                                | HTTP: edit, reload, Restore brings the edit back; other organization sees nothing         |
| G4  | Each trigger with unsaved changes shows an **Unsaved** badge in the list (the Build field-row pattern). An incomplete step shows its missing part in warning ink in the flow ("Add a value") before Save.                                                                                                     | HTTP: badge appears and clears; incomplete step marked                                    |
| G5  | Ctrl+S (Cmd+S on Mac) saves triggers while the Triggers section is open.                                                                                                                                                                                                                                      | HTTP: shortcut saves; the browser save dialog does not open                               |

**Phase 1 decisions (during the work).**

- G1 uses the fallback: the page owns the trigger draft (`useTriggerDraft`), so Back and Forward keep the edits; there is no Back dialog. Unsaved edits hold a move only when it leaves Triggers or the Sandbox; moving into Triggers never waits.
- G2 was a real loss path: a failed save leaves the refused draft on the page, which made the edits look saved, and **Reload shared draft** then dropped them. Edits now clear only after a confirmed save.
- G3 uses session storage (per tab, cleared on sign-out), the same as the Access and Comms drafts, not local storage.

### Phase 2: desktop sizes (card 1)

| ID  | Change                                                                                                                                                                                                                                                                                                                                                               | Proof                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S1  | Keep the rule's purpose: under the compact density setting (desktop, fine pointer), a plain `min-h-11` still gives 44 px. Redefine `min-h-11`, `min-w-11` and `size-11` as Tailwind v4 utilities with that floor built in, then delete the `#main-content` rules. First prove that variants such as `xl:min-h-9` still generate and win against a redefined utility. | Computed sizes at 1440 match the classes in default and compact density; 390 keeps 44 px; Still Page holds at 1440×900 |

**Phase 2 decision (during the work).** A redefined `@utility min-h-11` does not work: Tailwind merges it with the built-in utility and the built-in declaration wins, which drops the floor. The fix keeps the `#main-content` floor and skips an element that sets its own desktop size (`xl:min-h-*`, `xl:min-w-*`, `xl:size-*`). Touch tablets below 1280 px keep 44 px, so `md:min-h-9` on the file picker stays at 44 px as before.

### Phase 3: canvas overlap (decision F2)

| ID  | Change                                                                                                                                                                                                                                                                                         | Proof                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| O1  | One overlap check on the drawn boxes: department frame against frame, and module against module in any department.                                                                                                                                                                             | Isolated tests: touching edges pass, real overlap is found                                                                     |
| O2  | The canvas notice bar shows "Some departments or modules overlap." with **Auto-arrange** and **Dismiss**. Dismiss holds until the layout changes. The default test draft overlaps today; give it a layout that does not overlap in the same commit, and add a separate overlap fixture for O2. | HTTP: overlap fixture shows the notice; Auto-arrange clears it; Undo restores; the full batch catches position-dependent tests |
| O3  | Auto-arrange spaces rows by the real table height, so it never makes an overlap.                                                                                                                                                                                                               | Isolated test with a 12-field module                                                                                           |

**Phase 3 findings (during the work).** R5 was real: with a 12-field table, Auto-arrange put the next row inside it. The default test draft overlapped only because its old-format module positions put Equipment outside its frame; it now has a clean layout, and `overlappingSandboxDesign` keeps the old spot for the notice test. No position-dependent test broke.

### Phase 4: Structure outline as a tree (card 2)

| ID  | Change                                                                                                                                                                                                                                                     | Proof                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| T1  | `tree` and `treeitem` roles with `aria-level`, `aria-expanded` and one `aria-selected`; one Tab stop (roving tabindex).                                                                                                                                    | HTTP keyboard journey                                     |
| T2  | Keys: Up and Down move; Right opens or moves to the first child; Left closes or moves to the parent; Home and End; typing a letter jumps to the next name. Enter selects; F2 renames. "Add field" and "Add module" stay reachable without being Tab stops. | Same journey; the 11 selectors updated in the same commit |
| T3  | Canvas help text matches the new keys.                                                                                                                                                                                                                     | Copy check                                                |

### Phase 5: polish (decision F3 and the open review items)

| ID  | Change                                                                                                                                                                                                   | Source   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| P1  | Selected trigger step: grey ink tint on the flow card; thin grey rule on the settings section, condition and action blocks. No blue border or ring.                                                      | F3       |
| P2  | Template cards become a radio group: the name is the title; the description and counts describe it; arrow keys move.                                                                                     | Reviews  |
| P3  | Version rows use `aria-current`, and the row name includes its compare role ("…, compared as A").                                                                                                        | Reviews  |
| P4  | The detail "Compare with" select drops the `v3 ·` prefix, so long names fit at 1440.                                                                                                                     | Review   |
| P5  | History hides paging when every version fits on one page. The paging test near `sandbox-relationship-mappings.spec.ts:5580` gets more versions, so it still checks paging.                               | Critique |
| P6  | "Remove condition" becomes a small quiet button beside its condition.                                                                                                                                    | Critique |
| P7  | Test hides Field comparison until the first run.                                                                                                                                                         | Critique |
| P8  | The import button reads as an import, not like "Export" (final words come from Phase 6).                                                                                                                 | Critique |
| P9  | Dialog headings carry `data-slot="section-title"`, but only where the Triplicate and Stockroom heading style fits the container; card-level headings stay as they are if the style makes them too large. | Review   |
| P10 | The trigger "On" switch lines up with the name field.                                                                                                                                                    | Review   |
| P11 | In Stockroom, the Sandbox save chip (`[data-sandbox-save-state]`) is lighter than the page title. Other Stockroom badges do not change.                                                                  | Critique |

### Phase 6: plain-language pass (card 3)

1. Write a glossary table: term, plain word, where it appears, and how many tests change.
2. Show where "module" appears across the app, not only in the Sandbox. Today the rough count of UI strings is Sandbox 117, canvas parts 30, Access 19, OpenView 15, Platform 10, Manage 1. A Sandbox-only rename leaves the other pages using the old word.
3. Check fit: field type labels show in the 232 px canvas card in the code font, so a new label must fit where "Integer" fits.
4. **Gate:** the owner approves the words and the scope. The word for "module" is a product decision.
5. Change display labels only. Stored values and wire formats stay.
6. Update tests and the behavior map in the same commit.

It runs last because it touches strings in every section, including the strings that phases 1 to 5 add.

## Exit

1. The Sandbox batch passes, and the frontend static checks are clean.
2. Screenshots at 1440 and 390, light and dark, in the four looks.
3. `ui-reviewer` returns "ship".
4. The owner approves the 390 px screens.

The pre-push gate runs only when the owner asks to push.

## Risks

| Risk                                                                                                                                                  | Solution                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Guarding Back can trap the user or fight the Next router.                                                                                             | Guard only while triggers are unsaved; Stay restores the URL; test Back and Forward both ways.                  |
| Stored drafts leak across accounts or organizations.                                                                                                  | Key by user, organization and draft; clear on Save, Discard, sign-out and organization switch; test the switch. |
| The size fix shortens controls and changes page height.                                                                                               | Check Still Page at 1440×900 and 44 px targets at 390 before the commit.                                        |
| The overlap notice nags on purpose-built layouts.                                                                                                     | Dismiss holds until the layout changes; Auto-arrange is undoable.                                               |
| The tree changes roles that 11 tests select by.                                                                                                       | Keep the names; update the selectors in the same commit.                                                        |
| The template radio group changes the "Select …" button selectors (about 2 in the mappings spec), and version rows lose `aria-pressed` (3 assertions). | Update them in the same commit as the change.                                                                   |
| The open follow-up cards start a second session in this checkout and break the HTTP runs.                                                             | Withdraw the three cards when this plan is approved; the work happens here.                                     |
| Renaming "module" touches about 63 strings and many tests.                                                                                            | The gate decides the scope first; display labels only.                                                          |
