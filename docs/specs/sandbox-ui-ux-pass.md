# Sandbox UI and UX pass

> **Status: approved (2026-10-18); implementation in progress.** Everything below that is not marked **Current** is proposed behavior.

## Outcome

The Sandbox shows the controls that people use most, and folds the rest into one **Advanced** block. Every action tells the user what would happen, that it is happening, and what happened. The screens use few words: the interface itself carries the meaning.

The Sandbox is the reference. If the exit criteria pass, the same pattern goes to other pages, one page at a time.

**In scope:** the Sandbox page (`/sandbox`): Build (canvas toolbar, Structure, Properties, create and edit forms), Triggers, Test, History, the page header and its menu, every Sandbox dialog, and the 390 px layouts of all of these.

**Out of scope:** other pages; the canvas drawing itself (it was rebuilt on React Flow in `8da5df9f`); backend contracts, schema, and wire formats; new features. The 6,177-line `tests/http/sandbox-relationship-mappings.spec.ts` is a review signal, but splitting it is out of scope.

**Preserved behavior:** every capability that exists today stays reachable. Accessible names stay the same unless the name itself is the fix. Undo and redo, the shared draft, Review and Publish, and the live-state lifecycle keep their contracts.

## Current state

These problems were found on the production build with real data (Harbor sample, Slate look) at 1440×900 and 390×844. The source inventories cite `frontend/src/components/systems/sandbox/` unless a path says otherwise.

### Usability findings (`ui-ux-pro-max`)

| Pri | Finding                                                                                                                                                                        | Where                                                                                                                     | Rule                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| P1  | Trigger summaries and the trigger value editor show a select option's raw ID ("Status equals 0460bb8e-…"); the owner must type the ID                                          | `components/trigger-flow.tsx:53-64`, `components/trigger-studio.tsx:569-652`                                              | Plain words (no database match)          |
| P1  | Two save models: Build saves each edit; Triggers needs **Save triggers**. The header chip ignores trigger changes, and leaving with unsaved changes is blocked silently        | `page.tsx:172-190`, `:554-605`                                                                                            | `form-autosave`, `sheet-dismiss-confirm` |
| P1  | Missing exits: Save checkpoint has no Cancel; Escape does not close the History label editor                                                                                   | `components/sandbox-header-actions.tsx:318`, `components/versions-workspace.tsx:866-947`                                  | `escape-routes`, `modal-escape`          |
| P2  | Run test is below the fold at 1440×900 and is not sticky; on 390 px the result appears below the whole setup with no scroll or focus                                           | `components/test-workspace.tsx:843`                                                                                       | `primary-action`                         |
| P2  | History truncates names ("Before r…"); the compare selects and the search placeholder are cut                                                                                  | `components/versions-workspace.tsx:647`                                                                                   | `truncation-strategy`                    |
| P2  | Risky actions look safe: Discard draft changes sits among safe menu items; Delete version has default ink; Close module (live) is a full-width button at the top of Properties | `components/sandbox-header-actions.tsx:272`, `components/versions-workspace.tsx:995`, `components/designer.tsx:1866-1890` | `destructive-emphasis`                   |
| P2  | Editing a relationship shows the heading "Create relationship"                                                                                                                 | `components/designer.tsx:1436`                                                                                            | Clear labels                             |
| P2  | On 390 px, Triggers stacks list, flow, and settings into one long page; Test puts the result below the full form                                                               | `components/trigger-studio.tsx`, `components/test-workspace.tsx`                                                          | `progressive-disclosure`                 |
| P2  | Successes use a page alert that never clears ("Products saved in the design."); trigger delete and discard have no confirmation and no Undo                                    | `page.tsx:1305`, `components/trigger-studio.tsx:910-936`                                                                  | `success-feedback`, `undo-support`       |
| P2  | Many disabled controls give no reason (Undo, Redo, Review and Publish, Run test, Connect modules, Save checkpoint, Discard)                                                    | `page.tsx:1221-1260`, `components/test-workspace.tsx:845`, `components/designer.tsx:2220`                                 | `state-clarity`                          |
| P3  | The selected filter looks the same as the others (History, Test, Field comparison)                                                                                             | `components/versions-workspace.tsx:547-574`, `components/test-workspace.tsx:674`, `components/test-run-result.tsx:431`    | `state-clarity`                          |
| P3  | Test skips from h1 to h3                                                                                                                                                       | `components/test-workspace.tsx:436`                                                                                       | `voiceover-sr`                           |
| P3  | One state has two names: "Unpublished changes" and "Draft"                                                                                                                     | `page.tsx:1212`, `:1476`                                                                                                  | Consistency                              |
| P3  | Test repeats facts: "live workspace unchanged" three times, the Run again advice twice                                                                                         | `components/test-run-result.tsx:153`, `:199`, `:350`, `:526-528`                                                          | R3.4                                     |

What works today: destructive actions confirm first and save a recovery checkpoint (`confirmation-dialogs`, `undo-support`); Review and Publish lists the changes and its password field allows password managers (`accessible-authentication`); every input has a visible label (`input-labels`).

### Design findings (`impeccable critique`)

The first critique scored heuristic 4 (Consistency) at 2 and heuristic 8 (Aesthetic and minimalist) at 3. The archive is in `.impeccable/critique/`.

| Pri | Finding                                                                                                                                                     | Where                                                                                                                               | Command    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1  | Single-select filters show no selected state: pressed and rail resolve to the same surface in `.sandbox-ui`                                                 | `frontend/src/app/globals.css:77`, `:79`, `:369-370`                                                                                | `harden`   |
| P1  | Department identity stops at the canvas edge; the Structure tree, department selects, trigger steps, and the Test module select carry no department mark    | `frontend/src/components/sandbox/sandbox-inspector-outline.tsx:560-600`, `components/trigger-flow.tsx:127-170`                      | `colorize` |
| P2  | Dialog footers follow five patterns (button order, variants, and Cancel labels differ)                                                                      | `components/designer.tsx:2893-2906`, `components/sandbox-header-actions.tsx:461-476`, `components/versions-workspace.tsx:1058-1075` | `polish`   |
| P2  | The type hierarchy is off spec: the Sandbox title is lighter than the shared page header; section titles use three sizes; the status chip is always outline | `page.tsx:1208`, `:1212`, `frontend/src/components/page-header.tsx:16`                                                              | `typeset`  |
| P2  | The inspector uses outline buttons for every action and nests field cards inside the panel card                                                             | `components/designer.tsx:1866-1890`, `components/designer-field-settings.tsx`                                                       | `quieter`  |

Minor: uppercase eyebrows ("CHECKPOINT", "SUPPLY CHAIN"); the canvas toolbar mixes three button styles; two View menu items have no icon; permanent scroll thumbs read as dividers; in Slate dark inside `.sandbox-ui`, `--card` is darker than `--background`.

**Detector.** The source scan is clean. The live overlay confirms nested cards (Build 15, Triggers 5, Test 5, History 2), helper lines of 96 to 112 characters, and the skipped heading in Test. Its 38 text-occlusion hits on the canvas and the overused-font hit are false positives (stacked SVG labels; Geist is the Slate face).

## Skills and their roles

| Work                                                        | Skill                                    | Use                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Usability: disclosure, feedback, copy, flows, accessibility | `ui-ux-pro-max`                          | Rule checks (rule IDs below) and searches for each concern                                         |
| Visual design: hierarchy, type, color, components, looks    | `impeccable`                             | `distill`, `clarify`, `harden`, `typeset`, `colorize`, `quieter`, `polish`; `critique` at the exit |
| Contract and slices                                         | `sdd-workflow`                           | This document                                                                                      |
| Tests                                                       | `tdd-workflow`, `playwright-e2e-testing` | Behavior changes test first                                                                        |
| React rules                                                 | `react-frontend-patterns`                | Implementation                                                                                     |

## Rules

These rules go into `DESIGN.md` as "Disclosure and feedback" in Phase 0. They apply to every control, essential or advanced.

### R1. Essential first, Advanced last

1. Show the controls that the common task needs. Put everything else in one **Advanced** block.
2. Advanced is the last block of its panel. It is closed by default.
3. Advanced remembers its open or closed state for each viewer and panel (`localStorage`, with try/catch).
4. When Advanced is closed, its header shows how many of its controls are set, for example "Advanced · 2 set". A control is **set** when its value differs from its default.
5. Lifecycle actions (Close, Reopen, Delete, Permanently delete) always live in Advanced.
6. A control that applies only in one case appears only in that case. Example: "All or any" appears only when there are two or more conditions.

Correct: the module panel shows the name, the field list, and "Add field", then "Advanced · 1 set" (closed).
Wrong: the module panel opens with "Close module" above "Move module to department", "Record title field", and the field list.

### R2. Feedback at four moments

| Moment                | Rule                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Before (would happen) | A risky action states its consequence in one line, with numbers when known. A disabled control states why it is disabled. |
| During (is happening) | The control itself shows progress ("Saving…") and keeps its width. Only the affected item locks.                          |
| After (is done)       | Use the lowest channel that the user can see (ladder below).                                                              |
| Context (should know) | One save-state chip in the header. It also counts unsaved trigger changes.                                                |

**Channel ladder.** Use the lowest channel that works.

1. **Inline.** The result is visible where the user acts (a row updates, the canvas changes). Add nothing else.
2. **Notice.** The result is off screen or invisible. Use the toast (`reportDone`, 6 s), with **Undo** when the action can be undone.
3. **Dialog.** Use a dialog only before an action that cannot be undone or that changes the live workspace.
4. **Page alert.** Use the page alert only for blocking states (conflict, load failure). Never use it for success.

Errors appear next to the control that failed. When a dialog is open, its errors appear inside the dialog.

Correct: the user deletes a trigger; the list updates, and a notice says "Trigger deleted · Undo".
Wrong: the user renames a module, and a page alert "Products saved in the design." stays on screen until the next message replaces it.

### R3. Few words

1. A label has 3 words or fewer.
2. A helper line has one sentence of 12 words or fewer. Add one only for a consequence, a limit, or an error.
3. When a sentence explains how to use a control, fix the control instead.
4. A fact appears in one place only.
5. Numbers, marks, and state chips replace sentences. Icons keep a visible text label, except standard icon buttons that have a tooltip and an accessible name.
6. Guidance for first-time users lives in empty states and in the Help drawer, not in permanent text.

Correct: the If step shows "Always" when there are no conditions.
Wrong: "No condition filter is configured." shown twice, in the flow and in the summary.

## Decisions

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1  | **Trigger saving.** Keep the explicit **Save triggers**. A trigger is valid only when complete, and validation runs on save (`trigger-studio.tsx:787-793`); autosave would store broken triggers or show errors during editing. Make the unsaved state visible: the header chip counts trigger changes, Review and Publish says why it is disabled, and leaving with unsaved changes opens **Save · Discard · Stay**.                                      | Approved |
| D4  | **Label changes.** "Record title field" → "Title field" (`designer.tsx:1967`). "Enabled in draft" → an On/Off switch labeled "On" (`trigger-studio.tsx:1188`). "Value source: Literal value / Field reference" → "Fixed value / Another field" (`trigger-studio.tsx:677-707`). The footer "Draft" is removed; the header chip is the one name for the draft state. No glossary row changes (Close, Reopen, Permanently delete, History, and version stay). | Approved |
| D2  | Advanced remembers its state for each viewer (R1.3).                                                                                                                                                                                                                                                                                                                                                                                                       | Decided  |
| D3  | Every dialog has Cancel and closes on Escape. Only the two large dialogs (Templates, Review and Publish) also get a close (X) button.                                                                                                                                                                                                                                                                                                                      | Decided  |
| D5  | Deleting a trigger gives an Undo notice, not a confirmation. A trigger has no downstream impact, and Discard already restores it.                                                                                                                                                                                                                                                                                                                          | Decided  |
| D6  | Success messages move from the page alert to inline results or notices (R2 ladder).                                                                                                                                                                                                                                                                                                                                                                        | Decided  |

## Shared parts (Phase 1)

| Part                  | Contract                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdvancedSection`     | A disclosure with the label "Advanced". Takes a stable key and a count of set controls. Closed by default; remembers its state (R1.3). Keyboard: Enter or Space toggles; the header has `aria-expanded`. |
| Pending action        | A button that shows its pending label ("Saving…", "Deleting…") with `aria-busy`, and keeps its width. One component or one helper for every data-changing button.                                        |
| Save-state chip       | The header chip. Publish state ("Unpublished changes", "Published", "Nothing to publish yet") plus save state ("Saving…", "Saved", "Not saved · Retry", "N unsaved trigger changes").                    |
| `DisabledReason`      | Gives a disabled control a reason: a tooltip on hover and focus, `aria-describedby`, and a tap reveal on touch. Uses `aria-disabled` so the control stays focusable.                                     |
| Dialog footer         | One order everywhere: Cancel (outline) on the left, the commit button on the right (primary, or destructive for a destructive commit). One label: "Cancel".                                              |
| `DepartmentMark`      | An 8 px rounded square in `var(--dept-n)`. It appears beside a department or module name outside the canvas.                                                                                             |
| Single-select filters | Use `Tabs` (or a toggle with a visible pressed state) so the selected option shows in every look.                                                                                                        |

## Classification

**Current** placement is in the inventories (cited by file and line). The tables below are the **proposed** placement. E = essential (visible), A = Advanced, C = only in its case (R1.6), M = menu.

### Build: canvas toolbar and View menu

| Control                                        | Place                                 | Reason                    |
| ---------------------------------------------- | ------------------------------------- | ------------------------- |
| Zoom out, zoom in, zoom %, Fit                 | E                                     | Navigation on every visit |
| View: Auto-arrange, Center canvas, Canvas help | M (top)                               | Occasional                |
| View: Grid, Snap, Reset zoom, Reset layout     | M (group "Layout", after a separator) | Rare, technical           |

### Build: nothing selected

| Control                                                            | Place            | Reason                                                                                    |
| ------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| "Select a department or module."                                   | E                | Replaces 3 definition sentences (`designer.tsx:1806-1829`); the Key holds the definitions |
| Empty design: "Start from a template", "Add your first department" | C (empty design) | First run                                                                                 |

### Build: department

| Control                    | Place                           | Reason                                                                               |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| Name (editable title)      | E                               | Common                                                                               |
| Add module                 | E                               | Common                                                                               |
| Close or Reopen department | A                               | Lifecycle                                                                            |
| Delete department          | A                               | Lifecycle; today only in the Structure menu and the Delete key (discoverability fix) |
| Permanently delete         | A, C (closed and purge enabled) | Rare                                                                                 |

### Build: module

| Control                                                   | Place | Reason                                  |
| --------------------------------------------------------- | ----- | --------------------------------------- |
| Name (editable title), `DepartmentMark`                   | E     | Common                                  |
| Fields list (rows: required mark, name, type)             | E     | Core content; replaces the field cards  |
| Add field                                                 | E     | Common                                  |
| Relationships list, Connect modules                       | E     | Occasional, but the module's identity   |
| Department (move)                                         | A     | Rare; dragging on the canvas also moves |
| Title field (was "Record title field", D4)                | A     | Rare                                    |
| Close or Reopen module, Delete module, Permanently delete | A     | Lifecycle                               |

### Build: field (row expanded)

| Control                                                 | Place                      | Reason             |
| ------------------------------------------------------- | -------------------------- | ------------------ |
| Name, type, required                                    | E                          | Common             |
| Options                                                 | C (type Select), E         | Common for Select  |
| Move up, move down                                      | E (row icon buttons)       | Occasional         |
| Description, default value                              | A                          | Occasional or rare |
| Limits (max length; min, max, step; earliest, latest)   | A, C (by type)             | Rare               |
| Close or Reopen field, Delete field, Permanently delete | A                          | Lifecycle          |
| Save field changes, Cancel                              | E (when the row has edits) | Common             |

### Build: create forms and relationship dialog

| Control                                                          | Place | Reason            |
| ---------------------------------------------------------------- | ----- | ----------------- |
| Name                                                             | E     | Always            |
| Field type, Required (field create)                              | E     | Common            |
| Options (field create, type Select)                              | C     | Common for Select |
| Default value (field create)                                     | A     | Rare              |
| Relationship: Source, Target, Type, Name (prefilled from Target) | E     | All needed        |

### Build: Structure tab

| Control                                                                   | Place                              | Reason     |
| ------------------------------------------------------------------------- | ---------------------------------- | ---------- |
| Search, tree, add rows, relationship list                                 | E                                  | Common     |
| Expand all, Collapse all, Jump to selection                               | E (icon buttons in the search row) | Occasional |
| Row menu (Rename, Close or Reopen, Duplicate, Delete, Permanently delete) | M                                  | Occasional |

### Triggers

| Control                                                   | Place                                                              | Reason                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| New trigger, trigger list                                 | E                                                                  | Entry point                                                                 |
| Trigger menu: Delete trigger (Undo notice, D5)            | M                                                                  | Occasional                                                                  |
| Name, On switch (D4)                                      | E                                                                  | Common                                                                      |
| When: event, module                                       | E                                                                  | Common                                                                      |
| When: field; operator and value; frequency, time, weekday | C (by event), E                                                    | Needed for that event                                                       |
| If: conditions, Add condition                             | E                                                                  | Common; when empty, the step shows "Always" and one "Add condition" control |
| If: All or Any                                            | C (2 or more conditions)                                           | Matters only then                                                           |
| Then: actions (field, value), Add action                  | E                                                                  | Common                                                                      |
| Value: Fixed value or Another field (D4)                  | A (inside the value editor)                                        | Rare                                                                        |
| Recent activity                                           | A                                                                  | Occasional, already collapsed                                               |
| Save triggers, Discard changes                            | E (sticky bar, shown when changes exist)                           | D1                                                                          |
| Flow preview                                              | E (desktop column); the summary at the top of the detail on 390 px | Reading aid                                                                 |

### Test

| Control                                             | Place                             | Reason                       |
| --------------------------------------------------- | --------------------------------- | ---------------------------- |
| Module, When, event settings                        | E                                 | Every test                   |
| Inputs for relevant fields                          | E                                 | Core                         |
| "All fields (n)" switch                             | E                                 | Occasional                   |
| Search fields                                       | C (more than 12 fields)           | Useful only on large modules |
| Run test                                            | E (sticky at the bottom of Setup) | Primary action               |
| Triggers to run (all on, or pick)                   | A                                 | Rare                         |
| Recent results, Clear results                       | A                                 | Rare                         |
| Result: headline, steps, Show on canvas, Run again  | E                                 | Core                         |
| Field comparison: changed fields; All fields switch | E                                 | Core                         |
| Inputs used, Relationship routing                   | A (already collapsed)             | Rare                         |

### History

| Control                                             | Place                                                 | Reason                                  |
| --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| Version list with full names                        | E                                                     | Core                                    |
| Restore                                             | E                                                     | Recovery                                |
| Save checkpoint                                     | E (button in the list header; also stays in the menu) | Natural home                            |
| Search                                              | E                                                     | Compact, at the top of the list         |
| Kind filter (All, Checkpoints, Published, Imported) | E (compact select)                                    | Rare; today four toggles                |
| Compare with…                                       | E (in the version detail; preselects that version)    | Replaces the always-visible compare bar |
| Label, note                                         | A (version detail)                                    | Rare                                    |
| Delete version                                      | A (version detail, danger ink)                        | Rare                                    |

### Header and menu

| Control                                                        | Place                                   | Reason               |
| -------------------------------------------------------------- | --------------------------------------- | -------------------- |
| Title, save-state chip, Undo, Redo (Build), Review and Publish | E                                       | Common               |
| Menu: Save checkpoint, Start from a template, Import or export | M                                       | Occasional           |
| Menu: Discard draft changes                                    | M (last, after a separator, danger ink) | Rare and destructive |

## Feedback by action

Each cell names the **proposed** channel. "Inline" means the visible result is the feedback. The inventories hold the **current** rows; every "none" there is closed here.

| Action                                            | Before                                                      | During                                 | After                                                         | Error                                                    |
| ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Rename, add department, module, or field          | —                                                           | Pending label on the save button       | Inline (row or canvas); save chip shows "Saved"               | Inline under the input                                   |
| Change type, required, options, description       | —                                                           | Field row locks                        | Inline; save chip                                             | Inline in the row                                        |
| Move module (select or drag)                      | —                                                           | Item locks                             | Inline (canvas)                                               | Inline under the select, or a notice for a drag          |
| Title field                                       | —                                                           | Select locks                           | Inline                                                        | Inline (today the error is dropped, `designer.tsx:1974`) |
| Delete department, module, field, or relationship | Dialog with impact counts                                   | "Deleting…"                            | Notice "… deleted · Undo"                                     | Inside the dialog                                        |
| Close or reopen a live item                       | Dialog with the affected count                              | "Confirming…"                          | Inline state chip on the item                                 | Inside the dialog                                        |
| Duplicate                                         | —                                                           | Item locks                             | Inline (new item selected)                                    | Notice                                                   |
| Create trigger                                    | —                                                           | —                                      | Inline (selected, flow updates)                               | Inline                                                   |
| Edit trigger                                      | —                                                           | —                                      | Inline flow update; header chip counts unsaved changes        | Inline at the field on save                              |
| Delete trigger                                    | —                                                           | —                                      | Notice "Trigger deleted · Undo"                               | Notice                                                   |
| Save triggers                                     | Save bar shows the count                                    | "Saving…"                              | Notice "Triggers saved"; chip updates                         | Inline at the first invalid field; scroll to it          |
| Discard trigger changes                           | —                                                           | —                                      | Inline; notice with Undo                                      | Notice                                                   |
| Leave with unsaved triggers                       | Dialog Save · Discard · Stay                                | —                                      | —                                                             | —                                                        |
| Run test                                          | —                                                           | "Running…"; result area shows progress | Inline result; on 390 px, scroll to it and focus the headline | Inline in the result area                                |
| Edit a test input after a run                     | —                                                           | —                                      | Result marked "Inputs changed · Run again" at once            | —                                                        |
| Compare versions                                  | —                                                           | "Comparing…"                           | Inline; a changed selection clears the old result             | Inline in the compare area                               |
| Restore version                                   | Dialog (consequence)                                        | "Restoring…"                           | Notice "Draft restored · checkpoint saved"                    | Inside the dialog                                        |
| Delete version                                    | Dialog                                                      | "Deleting…"                            | Inline (row removed); notice                                  | Inside the dialog                                        |
| Edit label                                        | —                                                           | "Saving…"                              | Inline                                                        | Inline                                                   |
| Save checkpoint                                   | —                                                           | "Saving…"                              | Notice "Checkpoint saved"; History updates                    | Inside the dialog                                        |
| Import draft                                      | Dialog shows the chosen file name and "Replaces your draft" | "Importing…"                           | Notice; Build opens                                           | Inside the dialog                                        |
| Export                                            | —                                                           | "Exporting…"                           | Download; notice "Exported"                                   | Inside the dialog                                        |
| Discard draft                                     | Dialog (consequence)                                        | "Discarding…"                          | Notice                                                        | Inside the dialog                                        |
| Apply template                                    | Dialog (consequence)                                        | "Applying…"                            | Notice; Build opens                                           | Inside the dialog                                        |
| Publish                                           | Review list                                                 | "Publishing…"                          | Notice "Published"; chip "Published"                          | Inside the dialog                                        |

Disabled controls without a reason today get one through `DisabledReason`. These include Undo, Redo, Review and Publish, Run test, Connect modules, Save checkpoint, Discard, zoom limits, Delete version, and every control locked by a pending save.

## Copy cuts

Each item is a check in its section phase. Paths are under `frontend/src/components/`.

| #   | Current text                                                                                                                                                                           | Location                                                         | Proposed                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Three definitions ("Module: a list of one kind of record…", "Relationship: …", "Handoff: …")                                                                                           | `systems/sandbox/components/designer.tsx:1815-1829`              | Remove (the Key has them)                                                         |
| 2   | "Select a department or module on the canvas or in Structure to see and change its settings."                                                                                          | `designer.tsx:1806-1809`                                         | "Select a department or module."                                                  |
| 3   | "Select an item for settings. Use the visible actions to add, rename, or manage items."                                                                                                | `sandbox/sandbox-inspector-outline.tsx:642`                      | Remove                                                                            |
| 4   | "Used for Record links in Boards. If blank, links show Record and the first eight characters of its ID."                                                                               | `designer.tsx:2010`                                              | Tooltip on "Title field"                                                          |
| 5   | "Follow the steps to see when this trigger makes a change."                                                                                                                            | `systems/sandbox/components/trigger-studio.tsx:906`              | Remove                                                                            |
| 6   | "Saves all trigger drafts. Publishing is a separate step."                                                                                                                             | `trigger-studio.tsx:1083`                                        | Remove (the chip and Review and Publish carry it)                                 |
| 7   | "Choose what starts this trigger." / "Only continue when these conditions match." / "Choose what changes when the conditions match."                                                   | `trigger-studio.tsx:1208`, `:1525`, `:1671`                      | Remove (When, If, Then are the headings)                                          |
| 8   | "Select a step to edit its settings."                                                                                                                                                  | `systems/sandbox/components/trigger-flow.tsx:192`                | Remove                                                                            |
| 9   | "No condition filter is configured." (twice)                                                                                                                                           | `trigger-flow.tsx:245`, `:302`                                   | "Always"                                                                          |
| 10  | "Disabled in this draft. This trigger will not run when published."                                                                                                                    | `trigger-flow.tsx:196`                                           | "Off · won't run after publish"                                                   |
| 11  | "This preview describes your draft, not a completed run. Save your changes, then review and publish to apply them."                                                                    | `trigger-flow.tsx:318`                                           | Remove                                                                            |
| 12  | "Choose what happens, then set the values to try."                                                                                                                                     | `systems/sandbox/components/test-workspace.tsx:440`              | Remove                                                                            |
| 13  | "Relevant: required fields and fields your triggers use. Hidden fields keep their values."                                                                                             | `test-workspace.tsx:631`                                         | Tooltip on "Relevant"                                                             |
| 14  | "Choose an event and enter temporary values. Your live workspace stays unchanged." and "These are temporary test values. No operational records were created or changed."              | `systems/sandbox/components/test-run-result.tsx:153`, `:526-528` | One chip in the result header: "Test only · live data unchanged"                  |
| 15  | "Run the test again to check the current draft." and "Editing inputs does not change this result. Run the test again to evaluate new values."                                          | `test-run-result.tsx:199`, `:350`                                | One stale bar: "Inputs changed" + Run again                                       |
| 16  | "Field comparison shows each value after the test, including changes that later triggers made."                                                                                        | `test-run-result.tsx:346`                                        | Remove                                                                            |
| 17  | "Compare the inputs used with the test result."                                                                                                                                        | `test-run-result.tsx:408`                                        | Remove                                                                            |
| 18  | "See how two saved versions differ."                                                                                                                                                   | `systems/sandbox/components/versions-workspace.tsx:754`          | Remove                                                                            |
| 19  | "Restore it to the draft. A recovery checkpoint is added to history."                                                                                                                  | `versions-workspace.tsx:977`                                     | Keep only in the restore dialog                                                   |
| 20  | "Save this draft so you can compare or restore it later."                                                                                                                              | `systems/sandbox/components/sandbox-header-actions.tsx:290`      | Remove; the name input says "Checkpoint name"                                     |
| 21  | "A checkpoint is saved first. This restores the latest published draft when available; otherwise it starts with an empty draft. Live workspace data is never changed here." (27 words) | `sandbox-header-actions.tsx:457`                                 | "Saves a checkpoint, then resets the draft to the last publish. Live data stays." |
| 22  | "Start from a detailed operating baseline. Nothing is applied until you select a template and confirm the replacement."                                                                | `systems/sandbox/components/organization-template-dialog.tsx:66` | "Nothing changes until you confirm."                                              |
| 23  | Footer "Draft"                                                                                                                                                                         | `systems/sandbox/page.tsx:1476`                                  | Remove (D4)                                                                       |
| 24  | "Stops new records. Keeps existing data. You can reopen it."                                                                                                                           | `designer.tsx` lifecycle note                                    | "Stops new records. Keeps existing data." (Reopen is the button beside it)        |

## Phases

Each phase is one work unit with its own commit or commits. A phase ends with its focused tests, one Sandbox batch (isolated and HTTP), screenshots at 1440×900 and 390×844 in light and dark, and a `ui-reviewer` pass for visual changes. The pre-push gate runs only when the user asks for a push.

| Phase | Content                                                                                                                                                                                                                                | Acceptance (IDs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Write R1 to R3 into `DESIGN.md` with correct and wrong examples. Record the baseline metrics in the run record.                                                                                                                        | DOC-1: `DESIGN.md` has "Disclosure and feedback" with R1 to R3.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1     | Build the shared parts. Fix the single-select filter state.                                                                                                                                                                            | SH-1: Advanced opens and closes by keyboard and remembers its state after reload. SH-2: Advanced shows "n set" when closed. SH-3: a disabled control with a reason exposes it on focus and to screen readers. SH-4: every Sandbox dialog uses the footer order. SH-5: the selected filter is visible in all four looks.                                                                                                                                                                  |
| 2     | Mechanical fixes Q1 to Q9 (below).                                                                                                                                                                                                     | One criterion for each fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3     | Build: the classification, the feedback table, copy cuts 1 to 4, `DepartmentMark` outside the canvas, field rows instead of cards, title and type steps, both widths.                                                                  | BLD-1: a module panel shows the essentials and a closed Advanced block. BLD-2: Delete is reachable from Properties. BLD-3: every Build action has feedback per the table, except successes that still use the page alert; those move to the toast with Phase 7 (D6). BLD-4: copy cuts 1 to 4 are done. BLD-5: 390 px shows the panel without horizontal scroll.                                                                                                                          |
| 4     | Triggers: the classification; the select-option picker in the value editor; the leave dialog (D1); Undo on delete (D5); the chip counts unsaved trigger changes; copy cuts 5 to 11; on 390 px, the list opens a detail view with Back. | TRG-1: a select condition or action shows option labels and stores the option ID. TRG-2: leaving with unsaved changes asks Save, Discard, or Stay. TRG-3: Delete shows "Trigger deleted · Undo", and Undo restores it. TRG-4: the chip shows the unsaved count. TRG-5: on 390 px, choosing a trigger shows its detail first. Below a 640 px studio width the list and the detail are separate views with Back; the detail shows the Trigger summary at the top and hides the flow graph. |
| 5     | Test: the classification; Run test sticky; result marked stale on edit; on 390 px, Setup and Result tabs, and the view moves to the result after a run; copy cuts 12 to 17.                                                            | TST-1: Run test stays visible while the setup scrolls. TST-2: editing an input marks the result stale at once. TST-3: on 390 px, a run shows the result. TST-4: Run test disabled without a module says why.                                                                                                                                                                                                                                                                             |
| 6     | History: the classification; full version names; Compare with… from the detail; the kind filter as a compact select; label and delete in Advanced; copy cuts 18 and 19.                                                                | HIS-1: names show in full or wrap; no "Before r…" at 1440. HIS-2: Compare with… opens the comparison with that version preselected. HIS-3: delete uses danger ink.                                                                                                                                                                                                                                                                                                                       |
| 7     | Header, menu, and dialogs: the save-state chip, the menu order with Discard last, X on Templates and Review and Publish (D3), successes moved off the page alert (D6), copy cuts 20 to 23.                                             | HDR-1: the chip shows saving, saved, and not-saved states. HDR-2: Review and Publish, when disabled, says why. HDR-3: no success message uses the page alert.                                                                                                                                                                                                                                                                                                                            |
| 8     | Sweep: 390 px for every section and dialog; the four looks (Slate, Whiteboard, Triplicate, Stockroom) in light and dark on one screen per section.                                                                                     | SWP-1: no horizontal scroll and no clipped control at 390 px. SWP-2: every new part follows each look.                                                                                                                                                                                                                                                                                                                                                                                   |
| 9     | Exit review (exit criteria below), then the pattern kit.                                                                                                                                                                               | EXIT-1 to EXIT-6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Phase 2 fixes

| ID  | Fix                                                                                                | Location                                                     |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Q1  | Trigger summaries show the option label, not its ID                                                | `trigger-flow.tsx:53-64`                                     |
| Q2  | Weekday names (Monday to Sunday), not "Day 1" to "Day 7", in Triggers and Test                     | `trigger-studio.tsx:1273-1348`, `test-workspace.tsx:532-575` |
| Q3  | The operator select shows words with the symbol ("at least (≥)")                                   | `trigger-studio.tsx:91`, `:1600`                             |
| Q4  | Editing a relationship does not show "Create relationship"                                         | `designer.tsx:1436`                                          |
| Q5  | Save checkpoint has Cancel                                                                         | `sandbox-header-actions.tsx:318`                             |
| Q6  | Escape cancels the History label edit                                                              | `versions-workspace.tsx:866-947`                             |
| Q7  | Import or export puts Cancel in the footer order                                                   | `sandbox-header-actions.tsx:444`                             |
| Q8  | A changed compare selection clears the old result                                                  | `versions-workspace.tsx:764`, `:776`, `:802`                 |
| Q9  | A failed title-field change shows its error, and a failed delete shows its error inside the dialog | `designer.tsx:1974`, `:2889`                                 |

## Tests

1. Write a failing test first for each behavior change (`tdd-workflow`). Copy-only changes update the assertions that read the copy.
2. Keep accessible names stable. When a name changes, the same commit updates its tests.
3. Add one shared HTTP helper that opens a panel's Advanced block, so tests do not repeat the steps.
4. Update `frontend/tests/behavior-maps/sandbox.md` rows in the same slice as the behavior.
5. Put logic (the set count, the stale result, the option label) in isolated tests, and one journey per behavior in HTTP tests.

## Measurement

Numbers go in the run record (`.agent-runtime/sandbox-ui-ux/metrics.md`), not in this document.

- **Visible helper words**: words in helper text that is visible by default in each panel and selection state, excluding user data, measured with one browser script on the same data before and after.
- **Default-visible controls**: interactive controls visible by default in each panel and selection state.
- **Coverage**: every control in the inventories is still reachable.
- **Baseline captures**: the 26 screenshots in `.playwright-mcp/sandbox-review/` (production build, Slate dark, Harbor data).

## Exit criteria

The pass is desirable, and the pattern may go to other pages, when all of these hold:

| ID     | Criterion                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| EXIT-1 | A re-run `impeccable critique` of the Sandbox has no P1, and heuristics 4 and 8 score 3 or more.                                               |
| EXIT-2 | No "none" cell remains in the feedback table for a data-changing action.                                                                       |
| EXIT-3 | In every section, visible helper words and default-visible controls are both lower than the baseline, and every capability is still reachable. |
| EXIT-4 | All Sandbox isolated and HTTP tests pass, and the frontend static checks are clean.                                                            |
| EXIT-5 | `ui-reviewer` returns "ship" on the final screenshots (1440 and 390, light and dark, four looks).                                              |
| EXIT-6 | The user approves the 390 px sweep.                                                                                                            |

After the exit, write the pattern kit: a short checklist in `DESIGN.md` that applies R1 to R3 to a new page, with the Sandbox as the example.

## Risks

| Risk                                      | Mitigation                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A setting hidden in Advanced is forgotten | The closed header shows "n set" (R1.4).                                                         |
| Power users lose a click                  | Advanced remembers its state (R1.3); Structure search reaches every item.                       |
| Fewer words confuse first-time users      | Empty states and the Help drawer carry guidance; consequences and errors keep their text.       |
| Notices become noise                      | The channel ladder (R2) allows a notice only when the result is not visible.                    |
| Many tests break                          | Stable accessible names, one Advanced helper, and the behavior map updated in the same slice.   |
| A look skin breaks a new part             | New parts use tokens only; Phase 8 checks the four looks.                                       |
| `designer.tsx` grows further              | Extract an inspector panel only when it separates a real responsibility (`frontend/AGENTS.md`). |
