---
name: OpenSlate
description: A slate each organization themes. Four looks, one layout, the same words.
colors:
  ground: "#f7f8fa"
  surface: "#ffffff"
  surface-raised: "#ffffff"
  surface-sunken: "#f1f3f5"
  surface-hover: "#eef0f3"
  ink: "#0f1115"
  ink-muted: "#555e6c"
  rule: "#e4e7ec"
  rule-strong: "#d0d5dd"
  control-edge: "#858e9b"
  action: "#2563eb"
  action-ink: "#ffffff"
  action-text: "#1d4ed8"
  action-tint: "#eef3fe"
  flow: "#0f766e"
  flow-ink: "#ffffff"
  flow-text: "#0f766e"
  flow-tint: "#e7f5f3"
  flow-rule: "#b7dfd9"
  warn: "#a36600"
  warn-ink: "#ffffff"
  warn-text: "#8a5300"
  warn-tint: "#fff7e8"
  warn-rule: "#f2d3a0"
  danger: "#d92d20"
  danger-ink: "#ffffff"
  danger-text: "#b42318"
  danger-tint: "#fef3f2"
  danger-rule: "#fecdca"
  focus: "#2563eb"
  canvas-background: "#f5f6f8"
  canvas-grid: "#dde1e7"
  canvas-grid-major: "#c3c9d2"
  canvas-edge: "#7d8694"
  dept-1: "#8e79b8"
  dept-2: "#3e8f8a"
  dept-3: "#c08a3e"
  dept-4: "#c0677e"
typography:
  headline:
    fontFamily: "Schibsted Grotesk, Geist, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title-lg:
    fontFamily: "Geist, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "Geist, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  control:
    fontFamily: "Geist, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
  label:
    fontFamily: "Geist, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  code:
    fontFamily: "Geist Mono, monospace"
  canvas-department:
    fontFamily: "Schibsted Grotesk, Geist, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  canvas-table:
    fontFamily: "Geist, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  canvas-field:
    fontFamily: "Geist, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  canvas-type:
    fontFamily: "Geist Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  canvas-department: "14px"
  canvas-node: "10px"
  canvas-label: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  card: "20px"
  canvas-unit: "24px"
  section: "28px"
  target: "44px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  button-outline-hover:
    backgroundColor: "{colors.surface-sunken}"
  button-ghost:
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-sunken}"
  button-destructive:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.danger-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
    height: "36px"
  button-sm:
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "40px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "{spacing.card}"
  badge-default:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-success:
    backgroundColor: "{colors.flow-tint}"
    textColor: "{colors.flow-text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-warning:
    backgroundColor: "{colors.warn-tint}"
    textColor: "{colors.warn-text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-destructive:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger-text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-outline:
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  tabs-list:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.lg}"
    padding: "4px"
  tabs-trigger-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  alert-warning:
    backgroundColor: "{colors.warn-tint}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "16px"
  alert-destructive:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "16px"
  alert-success:
    backgroundColor: "{colors.flow-tint}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "16px"
  nav-item-active:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.action-text}"
    typography: "{typography.control}"
    height: "32px"
  canvas-module:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.canvas-node}"
    width: "232px"
  canvas-module-header:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.canvas-table}"
    height: "34px"
  canvas-field-row:
    textColor: "{colors.ink}"
    typography: "{typography.canvas-field}"
    height: "26px"
  radio-card:
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "12px"
  radio-card-selected:
    backgroundColor: "{colors.action-tint}"
    textColor: "{colors.action-text}"
  summary-block:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  badge-level-manager:
    backgroundColor: "{colors.action-tint}"
    textColor: "{colors.action-text}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
---

# Design System: OpenSlate

## Overview

**Creative North Star: "The Themeable Slate"**

OpenSlate has no fixed identity. It is a slate that each organization themes. The owner picks one look for the whole organization in Manage > Organization > Organization look, and each person then picks System (the device's color mode), Light, or Dark. There are four looks, each with a light and a dark mode: **Slate** (the default), **Whiteboard**, **Triplicate**, and **Stockroom**. A look changes color, type, materials, shapes, and motion. It never changes layout, behavior, or words. The Sandbox is where the looks differ most: the owner's own departments and modules, drawn large as an ERD-style canvas, in the look the owner chose.

The system is built as a token contract plus a short list of named skin places. `frontend/src/app/globals.css` defines the contract and the Slate values on `:root` and `.dark`. Each other look lives in `frontend/src/app/themes/<look>.css`. It overrides the same token names on `:root[data-theme="<look>"]` and adds a few rules on the skin places. `[data-theme-preview="<look>"]` scopes a look's tokens to one element, for the look picker. The frontmatter above mirrors Slate light only, as a machine-readable default. The stylesheets are normative for every look and mode. When the two disagree, the stylesheets win.

Density is calm and practical: 14px body text, 36px buttons, hairline rules, and one action color. The system refuses one brand world imposed on every business. It also refuses the grey template that looks like nobody's business. The four looks answer both: Slate is a quiet, familiar default, and the other three are workplace materials that a Philippine MSME back office knows (a planning whiteboard, carbon-copy business forms, steel shelving and kraft boxes).

**Key Characteristics:**

- One markup and one set of words for every look; the look is tokens plus skin places.
- Four signals with one meaning each: action, flow, warn, danger.
- Department identity color is always beside the department name, never alone.
- Every look passes WCAG AA in light and dark, checked by `npm run check`.
- Motion explains where things came from and went: short, directional, and token-timed per look. Reduced motion keeps fades and color but removes travel.

### The four looks

| Look            | Selector and file                 | Type (`--font-ui` / `--font-code`)      | Radius (`--radius`) | Material                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | --------------------------------- | --------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slate (default) | `:root`, `.dark` in `globals.css` | Geist / Geist Mono, Schibsted Grotesk titles | 8px            | The same look as the website and the film: calm neutral surfaces (neutral grays in dark, not blue-leaning ones), precise hairlines, flat cards with a rule edge, titles in Schibsted Grotesk. On the canvas: a 3px department-color top edge, mono field types, dashed action-blue relationships and solid handoffs with arrowheads. No page pattern and no canvas frame.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Whiteboard      | `themes/whiteboard.css`           | Atkinson Hyperlegible Next / Geist Mono | 6px                 | The planning board. The page is a white board with a faint 24px marker grid inside an aluminium frame; the same frame surrounds the canvas and each dialog. Marker weights everywhere: bold type, 2px field and outline-button edges, a rounded marker underline under the page title, open tabs with a 4px marker underline. Edgeless raised cards. On the canvas: taped department frames, frameless modules in their department's pastel tint, bold round-capped marker lines. Dark is a slate chalkboard.  |
| Triplicate      | `themes/triplicate.css`           | Archivo (width axis) / Geist Mono       | 2px                 | The carbon-copy business form. The page is ruled paper; the top bar is a printed header with a double rule. Navy printed structure, ballpoint blue for what people typed, condensed tracked labels, perforated card headers and dialog tops, rubber-stamp chips, numbered ledger rows, double-ruled notices. On the canvas: each department is a tinted carbon copy, modules share their department's paper, field names are in ballpoint blue, dashed carbon relationships with solid handoffs. Dark is carbon paper. |
| Stockroom       | `themes/stockroom.css`            | Archivo (width axis) / Martian Mono     | 2px                 | Steel shelving and kraft boxes. A flat wall-colored page, a painted steel sidebar, a top bar on a steel rail, stencilled uppercase page titles, a heavy shelf rule under card headers, label-maker tape chips, steel table-head bands, steel-topped dialogs. On the canvas: steel uprights on the frame and on each department bay, kraft module boxes with a white paper end label and a steel shelf lip.                                                                                                     |

The workspace stores the organization look; each account stores its color mode, motion, and keyboard shortcut preferences. Text size and page density stay device-local. Browser storage caches the look under `openslate-org-theme`, color mode under `openslate-theme`, and reduced motion under `openslate-motion`; `public/theme-init.js` applies them before paint, then the server preferences reconcile them through `lib/appearance-preferences.ts`.

### Named Rules

**The Look-Only Rule.** A look changes color, type, materials, shapes, and motion. It never adds, removes, or reorders DOM, and it never changes a word. `frontend/tests/http/theme-parity.spec.ts` compares the element count and `textContent` across the four looks.

Correct: `[data-theme="triplicate"] [data-slot="badge"] { border: 1px solid currentColor; }`

Wrong: `{theme === "triplicate" && <span>Stamped</span>}` (theme-only markup, and a new word).

**The Skin Place Rule.** A look restyles only through tokens and the named hooks. A new skin place is a shared hook that every look can use, added to the component once. The hooks are:

- **Shell:** `data-skin="page"` on `main#main-content`, `data-skin="topbar"` on the app header, and `data-slot="sidebar"`, `data-slot="sidebar-container"`, and `data-slot="sidebar-inner"` on the sidebar.
- **Type:** `data-slot="page-title"` (one per page, on its h1), `section-title` (a heading for a part of a page that is not a card), `card-title`, `empty-title`, `field-label`, and `table-head`. A hand-made title or panel without its hook does not change with the look, so use the shared component or add the hook.
- **Containers:** `data-slot="card"`, `card-header`, `dialog-content`, `sheet-content`, and `dropdown-menu-content`.
- **Controls:** `data-slot="button"` (with `data-variant` and `data-size`), `input`, `select`, and `textarea`.
- **Status and navigation:** `data-slot="badge"` (with `data-variant`), `alert` (with `data-variant`), `tabs-list`, and `tabs-trigger` (with `data-active`).
- **Tables:** `data-slot="table-body"`, `table-row`, `table-cell`, and `table-head`.
- **Canvas:** `data-skin="canvas-frame"`; on cells `data-sandbox-kind`, `data-sandbox-body`, `data-sandbox-part`, `data-sandbox-line`, and `data-sandbox-edge-kind`; state attributes `data-selected`, `data-feedback`, `data-sandbox-pressed`, and `data-trace`.

Correct: `[data-theme="stockroom"] [data-skin="canvas-frame"]::after { box-shadow: inset 6px 0 0 var(--sr-steel), inset -6px 0 0 var(--sr-steel); }`

Wrong: `<Card className={theme === "whiteboard" ? "shadow-lg border-0" : ""}>` (a class switched per look).

**The Full Dark Rule.** Every token that a look's light block sets, its dark block sets too. The light block outranks Slate's `.dark` block, so a missing dark value leaks the light value into dark mode. The contrast guard fails on a missing token.

Correct: `--wb-frame` is set in both `:root[data-theme="whiteboard"]` and `.dark[data-theme="whiteboard"]`.

Wrong: a look sets `--canvas-module-fill` in light only, and dark mode shows a white card on a dark canvas.

**The Add-Only Skin Rule.** The look stylesheets are unlayered CSS, so a skin rule beats every Tailwind utility, including a call site's own class. A property that an instance may override (card edge and lift, outline-button edge and ink, radius, text ink, fill) therefore comes from a token that the base class reads: `--card-edge`, `--card-lift`, `--button-edge`, `--button-ink`, `--data-ink`, `--radius`. An unlayered skin rule only adds what no instance sets: pseudo-elements, page and canvas patterns, border widths and styles, and type (width, weight, tracking, face).

Correct: the Triplicate block sets `--button-edge: var(--action); --button-ink: var(--action);`, the outline variant reads them, and a skin rule adds only `border-width: 1.5px`. A call site's `border-danger-rule` still wins.

Wrong: `[data-theme="triplicate"] [data-slot="button"][data-variant="outline"] { border-color: var(--action); color: var(--action); }` (every outline button turns blue, and no call site can change it back).

**The Advanced Last Rule.** A panel shows the controls that its common task needs. Every other control goes in one closed **Advanced** block (`AdvancedSection`), the last block of the panel. Advanced remembers its state for each viewer, and when closed its header counts the controls whose value differs from the default ("Advanced · 2 set"). An error inside a closed Advanced block opens it for that render (`forceOpen`) without storing the choice, so the person sees the field that failed. Lifecycle actions (Close, Reopen, Delete, Permanently delete) always live in Advanced. A control that applies only in one case appears only in that case.

Correct: The module panel shows the name, the field list, and "Add field", then "Advanced · 1 set" (closed).

Wrong: The module panel opens with "Close module" above "Move module to department", "Record title field", and the field list.

**The Four Moments Rule.** Every action gives feedback before (a risky action states its consequence in one line, and a disabled control states why), during (the control shows its pending label and keeps its width; only the affected item locks), and after, through the lowest channel the person can see: inline when the result is visible, a toast (with Undo when the action can be undone) when it is not, a dialog only before an action that cannot be undone or that changes the live workspace, and a page alert only for a blocking state. Errors appear next to the control that failed, or inside the open dialog.

Correct: Deleting a trigger removes it from the list and shows the toast "Trigger deleted · Undo".

Wrong: Renaming a module shows the page alert "Products saved in the design.", which stays until another message replaces it.

**The Few Words Rule.** A label has three words or fewer. A helper line is one sentence of twelve words or fewer, and only for a consequence, a limit, or an error. A sentence that explains how to use a control means the control needs fixing. A fact appears in one place. Numbers, marks, and state chips replace sentences, and guidance for a first visit lives in empty states and the Help drawer.

Correct: The If step of a trigger with no conditions shows "Always".

Wrong: "No condition filter is configured." shown twice, once in the flow and once in the summary.

**The One Selection Rule.** Selection reads the same everywhere in the Sandbox: the selected row or step takes the 14% ink tint and hover the 6% tint, with no blue edge or ring. Where a selection links two panels (a trigger step and its settings), the settings section adds a thin `--ink-muted` rule. Blue stays for focus rings and primary actions.

Correct: Condition 1 in the flow is tinted, and its settings block has a thin grey rule.

Wrong: the flow card has a blue border and the settings block a blue ring.

**The Kept Edits Rule.** Edits that wait for an explicit Save (Sandbox triggers) belong to the page, not to the panel that shows them. Moving between sections, Back, and Forward keep them; leaving the page asks Save, Discard, or Stay; a reload keeps them in session storage and offers them back once with "Restore unsaved trigger changes?" (Restore, Discard). While that prompt waits, the trigger editor is read-only (the On switch included) and Review & Publish waits, so nothing is typed over the kept edits; the prompt's Discard has Undo, which offers them again. If newer edits already exist, they stay editable and Restore waits until they are saved or discarded; the kept edits keep their stored copy meanwhile. Each unsaved item carries an "Unsaved" warning badge in its list, and a step that Save will refuse shows the reason in warning ink before Save. Ctrl+S (Cmd+S) saves.

Correct: Back from Triggers to Build keeps the edit; the chip reads "· 1 unsaved trigger change"; returning to Triggers shows it.

Wrong: Back unmounts the editor and the edit is gone, with the chip back at "Saved".

**The Tree Keys Rule.** A hierarchy that people edit (the Sandbox Structure outline) is a WAI-ARIA tree: one Tab stop, Up and Down move, Right opens or goes to the first child, Left closes or goes to the parent, Home and End, a letter jumps to the next name, Enter selects, F2 renames, and the context-menu key opens the item's actions. "Add …" rows are items in the tree, not extra Tab stops. Only the selected item is `aria-selected`; "Closed" is the item's description, not part of its name.

Correct: Tab lands on the selected module; ArrowDown reaches its first field; "e" jumps to Equipment.

Wrong: Tab walks through every department, module, field, and "Add field" button.

**The Read-Only Is Text Rule.** A value that is fixed after save, or that only someone else can change, shows as text on a sunken block: the label, the value, and the description that the choice had. A disabled control is different: the viewer could use it, but not now or not with this role, so it stays focusable and says why through `DisabledReason`. The two never look the same.

Correct: Channel settings shows "Who can use this channel: Department · Sales" (with the Sales mark) on a sunken block, and the scope description under it.

Wrong: Channel settings shows the two scope radio cards greyed out, so the viewer looks for a way to turn them on.

**The Same Answer Rule.** A resource that the viewer cannot read gets one state, whether it exists or not: one title, one line, and one recovery action. Nothing on the page (the header, a member count, a request-to-join action) confirms that it exists.

Correct: an unknown id and a private channel both show "This conversation is not available." and "It may have been removed, or you may not have access.", with Retry history.

Wrong: a private channel shows "You need access to #payroll" and a Request access button.

**The page pass (pattern kit).** To bring a workspace page to these rules, take its panels one at a time, with the Sandbox as the worked example (`docs/specs/sandbox-ui-ux-pass.md`):

1. Inventory every control and helper line per panel and selection state, and measure helper words and default-visible controls with one script on fixed data before you change anything.
2. Classify each control as essential, conditional (shown only in its case), menu, or Advanced; lifecycle actions go to Advanced.
3. Give every data-changing action its four moments: a consequence or a disabled reason before, a pending label during, the lowest visible channel after, and the error beside the control or in the open dialog.
4. Cut every helper sentence that explains a control, repeats a fact, or restates a heading; move first-visit guidance to the empty state.
5. Reuse the shared parts: `AdvancedSection`, `DisabledReason`, the segmented `ToggleGroup`, the Button pending label, Cancel-first dialog footers, `DialogCloseButton` for large dialogs only, and ink-tint row states (6% hover, 14% selected).
6. Apply the Still Page Rule on desktop and keep phones scrolling; give a phone a list-or-detail view with Back where a desktop shows panels side by side.
7. Verify at 1440 and 390, light and dark, in all four looks; add one HTTP journey per criterion and a 390 sweep; measure again on the same data.

Correct: History's kind filter becomes one select, Delete version moves into Advanced in danger ink with "Published versions are kept." as its disabled reason, and Restore shows "Draft restored · checkpoint saved".

Wrong: History keeps four filter toggles, adds an Advanced block per version row, and confirms a label edit with a page alert.

## Colors

The palette is a set of semantic roles, not a hue list. Each look supplies its own values for the same names in light and dark. Prose below names tokens; the values live in the stylesheets.

### Primary

- **Action** (`--action`, with `--action-ink`, `--action-text`, `--action-tint`): the one color that acts. It fills primary buttons, draws focus (`--focus`), marks the active navigation item (`--action-text`, weight 600), traces hovered canvas lines, draws the minimap viewport, and fills the shell's unread count pill. `--action-text` is the text-safe shade for links and active labels on a surface. `--action-tint` is a quiet fill for drop targets, selected states, and the one tinted level chip (Manager).

### Secondary

- **Flow** (`--flow`, with `-ink`, `-text`, `-tint`, `-rule`): movement and success. Success chips, success notices, and published states use it. It is never a button fill.

### Tertiary

- **Warn** (`--warn`, with `-ink`, `-text`, `-tint`, `-rule`): asks for attention. Warning chips and notices, and a module that is moving on the canvas (`--canvas-moving`), use it.
- **Danger** (`--danger`, with `-ink`, `-text`, `-tint`, `-rule`): destructive actions and errors only. Destructive buttons fill with `--danger`; error notices use `--danger-tint` with a `--danger-rule` border.

### Neutral

- **Ground** (`--ground`): the page behind everything; also the stripe on alternate field rows.
- **Surface family** (`--surface`, `--surface-raised`, `--surface-sunken`, `--surface-hover`): cards and inputs, popovers and menus, tab rails and secondary fills, and hover fills.
- **Ink** (`--ink`, `--ink-muted`): body text and secondary text. `--ink-muted` passes AA on ground, surface, and the sunken fill in every look.
- **Data ink** (`--data-ink`): the text that people type into an input. It is `--ink` in every look except Triplicate, where it is ballpoint blue (the pen on a printed form). Input and Textarea read it. Table cells stay `--ink` on purpose, so stored data never looks like a link.
- **Outline button material** (`--button-edge`, `--button-ink`): the outline button's border and text. Slate uses `--rule-strong` for the edge, as on the website, and the foreground for the ink; Whiteboard uses a marker grey edge; Triplicate uses `--action` for both; Stockroom uses a `--ink-muted` edge with `--ink` text.
- **Rules** (`--rule`, `--rule-strong`): hairline borders and dividers. The Sandbox raises its borders to `--rule-strong` (`.sandbox-ui`).
- **Control edge** (`--control-edge`): input and control borders, 3:1 against surface and ground.

### Canvas skin

The canvas has its own layer so a look can restyle the Sandbox without new markup: `--canvas-background`, `--canvas-grid`, `--canvas-grid-major`; departments (`--canvas-dept-fill`, `--canvas-dept-frame`, `--canvas-dept-ink` for the count, `--canvas-dept-name` for the name: `--ink` in Slate, `--canvas-dept-ink` in the other looks); module cards (`--canvas-module-fill`, `--canvas-module-frame`, `--canvas-module-ink`); field rows (`--canvas-row-rule`, `--canvas-row-stripe`, `--canvas-field-ink` for field names, `--canvas-type-ink` for type labels); lines (`--canvas-edge`); and line labels (`--canvas-label-fill`, `--canvas-label-frame`, `--canvas-label-ink`). In Slate these are aliases of the neutrals. Whiteboard, Triplicate, and Stockroom give them their own materials. `--canvas-field-ink` is `--canvas-module-ink` in every look except Triplicate, where field names are ballpoint blue.

### Department identity

Four identity colors per look (`--dept-1` to `--dept-4`), cycled in department order. Each department also has four fills:

| Token             | Fills                 | Slate                  | Whiteboard            | Triplicate          | Stockroom                            |
| ----------------- | --------------------- | ---------------------- | --------------------- | ------------------- | ------------------------------------ |
| `--dept-n`        | identity mark         | identity hue           | pastel marker hue     | identity hue        | identity hue                         |
| `--dept-n-band`   | department head       | `--canvas-dept-fill`   | the pastel `--dept-n` | paper tint          | one steel band for all               |
| `--dept-n-card`   | module header         | `--canvas-module-fill` | light pastel tint     | the same paper tint | paper end label (white in light)     |
| `--dept-n-sheet`  | department frame body | `--canvas-dept-fill`   | `--canvas-dept-fill`  | paper tint          | `--canvas-dept-fill`                 |
| `--dept-n-module` | module body           | `--canvas-module-fill` | `--dept-n-card`       | `--dept-n-sheet`    | kraft (`--canvas-module-fill`)       |
| `--dept-n-stripe` | alternate field rows  | `--canvas-row-stripe`  | `--dept-n-card`       | `--dept-n-sheet`    | darker kraft (`--canvas-row-stripe`) |

Slate and Stockroom stripe alternate field rows; Whiteboard and Triplicate set the stripe equal to the module body, so their rows are divided by `--canvas-row-rule` only.

**The Same Department Rule.** Department color is meaning: it tells an owner which department a table belongs to. Every look keeps Slate's hue order (1 violet, 2 teal, 3 amber, 4 rose) and changes only lightness and strength for its material: marker pastels in Whiteboard, paper tints in Triplicate, muted paint on steel in Stockroom.

Correct: Whiteboard's `--dept-2` is a teal marker pastel (`#8fcfc6`), so Commerce stays teal-family in every look.

Wrong: Whiteboard's `--dept-2` is lavender, so Commerce is teal in Slate and lavender on the board.

**Outside the canvas.** `DepartmentMark` (`components/sandbox/department-mark.tsx`) is the canvas identity mark at 8px: a small square with the extra-small corner, filled with `--dept-n` by the department's canvas position, so a department has the same color in the Sandbox and in OpenComms. It is `aria-hidden`, and the department name follows it as text. OpenComms shows it in category rows of the conversation list and, through `DepartmentName`, in the channel scope label, the Access summary, and the grants list; `DepartmentList` gives each of a person's departments its mark in the member panel, the channel's Members tab, and person rows of the grants list, in department order, with names that wrap and are never cut. A followed record has no department here, so its row shows the record's table glyph instead of a mark. Inside a native select option or a search option description, the name stands alone.

Correct: `<DepartmentName id={channel.departmentId} />` renders the mark, then "Sales".

Wrong: a category row with only a colored left edge, or a second, larger mark drawn for the same department.

### Look-private tokens

A look may define private material tokens for its own skin rules: `--wb-*` (Whiteboard frame, tape, board, grid), `--tp-*` (Triplicate paper rule and perforation), and `--sr-*` (Stockroom steel, tape, and wall). They follow The Full Dark Rule. Components never read them; a component reads only contract tokens.

### Aliases

The shadcn names (`--primary`, `--card`, `--muted`, `--border`, `--input`, `--ring`, `--destructive`, `--success`, `--warning`, and others) are aliases of the semantic tokens and are set once in `globals.css`. A look sets semantic tokens, not aliases. The observed exception is the sidebar pair: Whiteboard sets `--sidebar`, and Stockroom sets `--sidebar` and `--sidebar-accent`. The chart series (`--chart-1` to `--chart-5`) are Slate's in every look; no look overrides them.

### Named Rules

**The One Meaning Rule.** Each signal has one meaning: action acts, flow shows movement and success, warn asks for attention, danger marks destructive actions and errors. A color never takes a second job.

Correct: a "Published" chip uses `Badge variant="success"` (`--flow-tint` and `--flow-text`).

Wrong: a primary button filled with `--flow` because the look "feels green", or a success chip in `--action-tint`.

**The Thirty Degree Rule.** In every look and mode, the warn hue is at least 30° from the danger hue, and `--action` has at least 1.5:1 contrast against `--ink`. The first keeps amber from reading as red; the second keeps links and buttons distinct from body text (Triplicate's carbon blue exists for this reason). `frontend/tooling/check-theme-contrast.mjs` enforces both.

Correct: Triplicate sets `--action` to a carbon blue that is separate from its navy `--ink`.

Wrong: Triplicate sets `--action` to its navy form ink, so a link looks like body text.

**The Name Beside Color Rule.** A department identity color never carries meaning alone. It is always shown beside the department name, as a mark, a band, or a card header.

One exception, for dense rows: an Access People row may show a person's department marks with a count ("■■■ 3") when the names are in the row's accessible text and in the person sheet one click away. A single department still shows its name.

Correct: the module header shows the `--dept-n` mark, then the module name, in the department's frame under its named head.

Wrong: a legend that says "purple = Commerce" and cards with only a purple edge.

**The AA Everywhere Rule.** Every text pair is at least 4.5:1, and focus rings and control borders are at least 3:1, in all eight look modes. The guard also checks `--data-ink` on card and background, `--button-ink` on card, and the canvas pairs: module ink, type ink, field ink, and line label ink on their fills; department ink on each `--dept-n-band`; module ink on each `--dept-n-card`; and field ink and type ink on each `--dept-n-module` and `--dept-n-stripe`.

Correct: adding a canvas text token also adds its pair to `PAIRS` in `check-theme-contrast.mjs`.

Wrong: a new chip tint that is checked only in Slate light.

## Typography

**UI Font:** `--font-ui`, which each look sets. Slate uses Geist; Whiteboard uses Atkinson Hyperlegible Next; Triplicate and Stockroom use Archivo with its width axis.
**Code Font:** `--font-code`. Geist Mono in Slate, Whiteboard, and Triplicate; Martian Mono in Stockroom.
**Display Font:** `--font-display`, which each look sets. Slate uses Schibsted Grotesk (700 and 800) for page titles, other `h1` headings, and canvas department names, the same face the website and the film use for headings. The other looks set it to their UI font.
**Stencil Font:** `--font-stencil`, Big Shoulders Stencil. Only Stockroom page titles use it.

**Character:** Slate reads as a precise, familiar product sans with a firm grotesk for titles. Each other look changes the face and the width, not the hierarchy. Faces load without preload, so a browser fetches a face only when rendered text uses it, and Slate pages load none of the look faces. Canvas lettering follows `--font-ui`; department names follow `--font-display` and field types follow `--font-code`.

### Hierarchy

- **Headline** (`--font-display`, 700, 24px, 30px from 640px up, line height 1.25, -0.025em): page titles only, through `PageHeader` (`data-slot="page-title"`). One per page.
- **Title Large** (600, 18px, 28px line, tight tracking): section headings inside a page, such as "Organization look" (`data-slot="section-title"`).
- **Title** (600, 16px): card titles (`data-slot="card-title"`).
- **Body** (400, 14px, 20px line; descriptions use a 24px line and a 672px maximum width): the default text size for content, tables, and descriptions.
- **Control** (500, 14px): buttons, tabs, field labels, table heads.
- **Label** (500, 12px, 16px line): chips, the canvas key, pagination, and small meta text.
- **Canvas** (13px bold for table names, 12px regular for field names and types): module cards on the canvas.

### Skin places for type

- Whiteboard: page titles at weight 700 with -0.01em tracking; card, section, and empty-state titles, buttons, chips, field labels, table heads, and the open tab at weight 700.
- Triplicate: page titles at 88% width, weight 800, -0.01em tracking; card, section, and empty-state titles at 90% width, weight 700; field labels and table heads at 12px, 78% width, weight 700, 0.06em tracking, in `--ink-muted`; chips at 80% width, weight 800, 0.05em tracking; buttons at weight 650 with 0.01em tracking; ledger line numbers at 12px, 75% width, weight 700.
- Stockroom: page titles in the stencil face, uppercase, weight 800, 0.03em tracking; card, section, and empty-state titles at 85% width, weight 800; field labels and table heads at 75% width, weight 800, 0.05em tracking; buttons at 88% width, weight 700; chips in the code face at 75% width, weight 600, 0.04em tracking.

### Named Rules

**The Case Stays Rule.** A case transform is allowed only on page titles. Field labels, chips, table heads, and card titles can show names that people typed, so they keep their case. A look uses width, weight, and tracking to carry its label style instead.

Correct: `[data-theme="stockroom"] [data-slot="page-title"] { text-transform: uppercase; }`

Wrong: `[data-theme="stockroom"] [data-slot="table-head"] { text-transform: uppercase; }` (a column named "iPhone SKU" becomes "IPHONE SKU").

**The Words Stay Rule.** A look never changes the words in the DOM. `textContent` ignores `text-transform`, so the parity test compares words, not how a look displays them.

Correct: Stockroom shows "SANDBOX" in its page title with `text-transform`, and the DOM still holds "Sandbox".

Wrong: Stockroom renders the string "SANDBOX" or "Shelf: Sandbox".

## Layout

The app shell is the same in every look. A resizable sidebar holds the workspaces and their sections: 240px by default, 220px to 360px, collapsible to a 3.5rem rail (56px at 100% text) that scales with the text size, like the width. The resize separator keeps its keyboard control (arrows, Home and End for the ends) and draws a 4px handle on hover and focus; a double-click resets the default. The sidebar shows from 1024px; below 1024px it is a 288px drawer. A sticky 56px header row holds the breadcrumbs: Workspace › workspace › section. Phones drop the Workspace root so the crumbs that change stay readable. Each route sets its own browser title (`Sandbox | OpenSlate`).

The main region pads 16px on phones and 20px by 28px from 640px up. Manage uses a tighter 12px vertical pad; OpenComms and Access fill the full height. Profile and Account settings set their own frame: Profile cancels the padding so its band spans the content area, and Account settings keeps a 12px vertical pad from 1280px, as Manage does. The shell has no branch for either. `PageHeader` stacks the title, description, and actions on phones and puts the actions on the right from 640px up, with 28px below.

The rhythm is a 4px base: 8px and 12px gaps inside groups, 16px between groups, 20px card padding, 28px between the page header and content. Tables open at 10 rows per page (options 5, 10, 25, 50).

**The Still Page Rule.** On desktop (1280px and wider) a workspace page fills the viewport and never scrolls; its panels do. The shell header, the page header, and the footer line stay in place, and each panel (canvas, Structure, Properties, a section body) scrolls on its own. Scroll panels are `relative`, so screen-reader text inside them cannot stretch the page. Phones and tablets scroll the page. The Sandbox, Access (People, Groups, Security), Manage, Profile, and Account settings follow it now; inside a still page any panel, card, or list may scroll on its own with the quiet scrollbar. The other workspaces follow it when their pass comes.

**The Quiet Scrollbar Rule.** Every scroll area uses a 4px thumb in an 8px lane with no track, tinted from `--ink-muted`; under the pointer it widens to 6px and darkens, in every look (Firefox draws its standard thin bar, which cannot be narrower). It is never hidden: it is the only cue that a panel has more below the fold. The sidebar tints its thumb with `--sidebar-muted`.

Targets stay reachable: below 1280px, sidebar and drawer rows are at least 44px tall; from 1280px the sidebar takes the slim sizes (Navigation). Below 640px, shell buttons and inputs are at least 44px. In the Sandbox and its dialogs, controls are at least 44px below 1280px, and inline toggles inside a list row keep 24px so rows keep one rhythm. Breadcrumb links keep a 24px target.

**The Sandbox.** The canvas owns at least 65% of the work area. One right workbench switches between Structure and Properties; creation actions live in the workbench, not on the canvas. Narrow screens switch among Canvas, Structure, and Properties as tabs. The canvas snaps to a 24px unit and shows a dot grid (minor dots every 24px, major dots every 120px, each dot on a snap point). It scales uniformly from 50% to 150%; the floor keeps field text readable, and the minimap shows what does not fit. There is no overview level: every zoom shows the same tables with their fields. The canvas and Properties always open on the same item: with no link, Build selects the first module of the busiest department (the most modules and lines, `openingModuleId`), and the canvas opens at 100% on the selected item's department, lifting it when the selected table would sit below the fold; if the department is wider than the view, it shows the selected table whole, with the department's left edge when it fits. Fit shows the whole design and never zooms past 100%. When Fit reaches the floor, or a trace is pinned from Test, a small notice bar at the top of the canvas says so, with Dismiss, or Back to result and Clear. The minimap sits bottom right from 640px up; the Key sits bottom left at every width.

**OpenComms.** The workspace fills the main region: a 44px connection strip on top, then panes that scroll on their own (`comms-layout.tsx`, `use-comms-panel-layout.ts`). From 768px up, the conversation list and the conversation sit side by side with a resize handle; below 768px a phone shows the list or the conversation, and the conversation header has a Back button to the list. From 1280px up, the members, thread, or record pane opens as a third resizable pane; below 1280px it opens as a dialog. The list is at least 200px; the conversation keeps a minimum of 280px to 360px, by the space there is; members take 200px to 360px; a thread or record takes 320px to 560px. Each person's pane widths are saved with their preferences. Inside OpenComms, buttons are at least 24px, and at least 44px below 640px.

## Elevation & Depth

The system is a hybrid: tonal layering first, and a lift that each look sets. Four tokens carry depth: `--lift` (resting), `--lift-raised` (popovers and raised cards), `--lift-filter` (the SVG `drop-shadow` form of the raised lift, for canvas nodes), and `--card-lift` (a card's own material). Dark modes deepen the same shadows with black instead of tinted ink.

### Shadow Vocabulary

- **Slate:** a soft ambient lift. Cards are flat (`--card-lift` is none) and take a `--rule` edge. Popovers take the two-layer `--lift-raised`. Every Tailwind shadow step maps to a lift token in `globals.css` (`shadow-xs` and `shadow-sm` to `--lift`, `shadow-md` and up to `--lift-raised`), so no component draws a shadow that its look did not set.
- **Whiteboard:** a 1px zero-blur ledge under a soft 6px shadow, like a board sitting on its tray. Cards have no edge (`--card-edge: transparent`) and use the raised lift. Dialogs and sheets take a 3px aluminium frame, a 1px inner highlight, and the raised lift. Canvas modules rest on the board with `--lift-filter`.
- **Triplicate:** a thin paper shadow. Cards take a `--rule-strong` edge and the resting lift, like a form on a desk. Canvas departments rest with `--lift-filter`, like copies on the desk.
- **Stockroom:** a 2px zero-blur shelf edge under a soft shadow. Cards take a `--rule-strong` edge and the resting lift. Dialogs and sheets take a 5px inset steel band on top and the raised lift. Canvas modules sit on a 2px solid steel shelf lip (`drop-shadow(0 2px 0 var(--sr-steel))`).

Rules drawn with `box-shadow` are rules, not lifts: Whiteboard's inset frame on the page and canvas; Triplicate's double rule under the top bar; Stockroom's steel rail under the top bar, steel edge on the sidebar, and 3px top band on notices. Exact shadow values live in each look's stylesheet and in `.impeccable/design.json`.

### Named Rules

**The Card Material Rule.** A look sets a card's material through `--card-edge` and `--card-lift`, never by overriding Card. A card's own border or ring class then still wins.

Correct: `--card-edge: transparent; --card-lift: var(--lift-raised);` in the Whiteboard block.

Wrong: `[data-theme="whiteboard"] [data-slot="card"] { border: 0; box-shadow: ...; }`

**The Ledge Not Block Rule.** A zero-blur lift layer is a vertical ledge of at most 2px. In a look's `--lift` tokens it is at low opacity under a soft shadow; a material edge (Stockroom's steel shelf lip under a kraft box) may be solid. It never offsets sideways and never becomes a block shadow.

Correct: `--lift: 0 2px 0 rgb(28 30 33 / 0.14);` (Stockroom).

Wrong: `--lift: 4px 4px 0 var(--ink);`

**The Selection Lifts Rule.** On the canvas, state lift belongs to selection: the selected department or module takes `--lift-filter` and a heavier stroke. A look may give a node kind a resting material lift (Whiteboard modules, Triplicate departments, Stockroom's shelf lip), and it is the same on every node of that kind. Hovering a module or a line traces its connections: the rest dims to 35% opacity in 150ms, the traced lines turn `--action` at 2px (3.4px in Whiteboard), and nothing moves. "Show test on canvas" from a Test result pins the same trace on the tested module (`?trace=` and `?run=`) and plays the run as three still steps in a strip above the canvas (What happened, Triggers, Result) with Previous step, Next step, Back to result, and Clear, plus a one-line legend. The strip repeats the result's caveats (an older draft, open issues). The trigger field row takes a solid 2.5px `--action` outline; changed rows take `--canvas-test-fill` (the action color mixed into the module fill; Stockroom dark mixes it into a darker base to keep type ink AA) and a dashed 1.5px `--action` outline, so the marks differ by pattern, not only hue. A field can carry both. Rows also carry an `aria-description` ("started the test", "changed in the test"). Each step keeps the earlier marks, and nothing moves. Clear, or a click on empty canvas, removes the trace and the marks; Back to result reopens the same run on its module and event.

Correct: `.sandbox-ui :is([data-sandbox-node], [data-sandbox-edge])[data-trace="dim"] { opacity: 0.35; }`

Wrong: hover scales the table up or slides the connected tables toward it.

## Shapes

Corners come from one token, `--radius`: 8px in Slate, 6px in Whiteboard, 2px in Triplicate and Stockroom. Tailwind derives the steps: large is `--radius`, medium is 2px less, small is 4px less (and resolves to square in the 2px looks); extra large is 1.5x and 2xl is 2x `--radius`. Buttons, inputs, cards, tab rails, and notices use large; chips use medium; the active tab uses small. Skin rules set a few corners directly: Whiteboard gives tabs a 6px top-only corner; Triplicate squares chips, tabs, notices, dialogs, sheets, and menus; Stockroom sets 1px on chips and 2px on the tab rail and notices.

Borders start as hairlines (1px). A look may thicken or restyle a border for its material:

- **Whiteboard (marker):** 2px on inputs, selects, text areas, outline buttons, and notices; a 2px tape rule under table heads; a 3px aluminium frame on dialogs and sheets; a 1px frame rule under the top bar.
- **Triplicate (printed form):** 1.5px on outline buttons and chips (with a second inner stamp line); a 1.5px ink rule under table heads; a 3px double border on notices; a dashed perforation under card headers and a 2px dashed ink top on dialogs and sheets; a 1px ink rule on the sidebar and menus.
- **Stockroom (steel):** a 3px `--sr-steel` shelf beam under card headers; a 2px steel rule under the steel table-head band; 1px row rules.

Canvas corners derive from `--radius` in CSS (`rx` on the `data-sandbox-*` hooks): departments 1.75x (14px in Slate), modules 1.25x (10px), line labels 0.75x (6px). Triplicate squares department and module bodies, headers, and the department edge (`rx: 0`); Stockroom sets 2px. The Sandbox uses the stronger rule. On the canvas, a look may thicken strokes for its material:

| Look       | Department frame (idle / selected) | Lines                                           | Relationship     | Handoff                 |
| ---------- | ---------------------------------- | ----------------------------------------------- | ---------------- | ----------------------- |
| Slate      | 1px / 2px                          | 1.6px, arrowheads, drift when traced            | dashed (5 4), `--action` | solid, `--canvas-edge` |
| Whiteboard | 2.5px tape / 3.5px (any node)      | 2.6px, round caps, 3.4px when traced, drift off | dashed (10 6)            | solid                  |
| Triplicate | 1px dotted (1 3) / 2px solid       | 1.5px, drift when traced                        | dashed (6 4), butt caps  | solid, butt caps       |
| Stockroom  | 6px steel uprights / 7px           | 1.6px, drift off                                | dashed (8 5)             | solid                  |

State strokes (selected, moving, drop target, pressed) stay heavier than idle strokes in every look. Whiteboard modules have no frame (`--canvas-module-frame: transparent`); Triplicate modules take a navy frame; Stockroom modules take a kraft edge.

The canvas frame (`data-skin="canvas-frame"`) draws its look on a pointer-transparent layer above the canvas: a 4px aluminium frame with a 1px highlight (Whiteboard), a 1px ink form rule (Triplicate), or 6px steel uprights on both sides (Stockroom). Slate has no frame.

The page ground (`data-skin="page"`) carries a look's surface: a white board with a 24px marker grid of 1px lines inside the same aluminium frame (Whiteboard), ruled form paper with a 1px rule every 28px (Triplicate), or a flat wall color (Stockroom). Slate keeps the plain ground.

### Named Rules

**The Dash Means Link Rule.** On the canvas, a dash carries meaning, the same meaning as on the website and in the film. In Slate a relationship line is dashed (5 4) in `--action`, and a handoff to another department is a solid `--canvas-edge` line; both end in an arrowhead at the target module. A look may restyle width, cap, color, and dash length, but a relationship stays dashed and a handoff stays solid in every look, so the dash means the same thing wherever an owner sees it. Looks target the two kinds through `data-sandbox-edge-kind`. The Key's sample lines carry the same hooks, so they always match the canvas.

Correct: `[data-theme="stockroom"] .sandbox-ui [data-sandbox-line][data-sandbox-edge-kind="relationship"] { stroke-dasharray: 8 5; }` beside a solid handoff rule.

Wrong: Triplicate draws handoffs dashed and relationships dotted (both kinds are dashed, so a dash no longer means link).

Wrong: `[data-theme="whiteboard"] .sandbox-ui [data-sandbox-line] { stroke-dasharray: none; }` (every relationship turns solid, and the Key no longer matches the canvas).

**The Hairline Pattern Rule.** A look may draw a flat hairline pattern with CSS gradients on the page ground and the canvas, when the pattern comes from the look's own material (a whiteboard's marker grid, a form's ruled paper). Lines are 1px, in a quiet tint of the ground, on a regular step. Photo textures, handwriting fonts, glossy gradients, and glass stay out of every look.

Correct: `[data-theme="triplicate"] [data-skin="page"] { background-image: repeating-linear-gradient(to bottom, transparent 0 27px, var(--tp-paper-rule) 27px 28px); }`

Wrong: `[data-theme="whiteboard"] [data-skin="page"] { background: url(board-photo.jpg), linear-gradient(135deg, #fff, #dfe6ec); }` (a photo texture and a glossy sheen), or `backdrop-filter: blur(12px)` on a dialog.

## Motion

Motion answers what a person did; it never decorates and never makes them wait. Pages swap at once. Motion is timed by tokens that each look sets, so a look changes how things move without changing what moves.

### Tokens

`--motion-fast` (feedback and exits), `--motion-base` (routine state), `--motion-slow` (layout and authored moments), with `--ease-out` (arrivals), `--ease-in` (exits), and `--ease-in-out` (even strokes).

| Look       | fast / base / slow | Signature (after a successful Publish)                |
| ---------- | ------------------ | ----------------------------------------------------- |
| Slate      | 140 / 220 / 360ms  | none                                                  |
| Whiteboard | 110 / 180 / 320ms  | the page-title marker underline draws from the left   |
| Triplicate | 120 / 200 / 340ms  | the page-title rule is written in one even stroke     |
| Stockroom  | 160 / 260 / 420ms  | the stencilled page title is sprayed on from the left |

### Navigation

- **Instant swap.** A sidebar move, crumb, or link replaces the page body at once, with no view transition. A view transition makes the page body ignore clicks while it runs and makes React hold the next navigation, so rapid moves felt stuck (measured: 380–514ms per move with the old handoff, 25–27ms without).
- **Active item.** The active section's fill is one element under the list (`data-slot="sidebar-active-indicator"`) that moves to the active link over `--motion-base` and follows groups as they open and close. It stays under the labels and inside the sidebar's scroll clipping.
- **Groups and panels.** Sidebar groups open and close by height over `--motion-base`, with the chevron turning; the sidebar collapses over `--motion-base`; the phone menu sheet enters over `--motion-slow` and leaves over `--motion-base`.
- **Signatures.** Each look's title signature plays once when Publish succeeds (`data-signature="play"` on the Sandbox page title), never on load or navigation.

### Loading

- **Frame first.** A page renders its title, description, and actions at once. Only the part that waits for data loads.
- **One pattern.** Data regions use `LoadingRegion` (`components/ui/loading-region.tsx`) with a skeleton built from `Skeleton` that matches the real layout: the same rows, panes, and heights, so nothing moves when data arrives.
- **No flash.** For the first 300ms the skeleton holds the space but stays invisible, so a fast load shows no placeholder. After that it shows for at least 300ms. Data that replaces a loading state fades in over `--motion-fast`; cached data appears at once.
- **Screen readers.** The region is `aria-busy` while it loads, and a `role="status"` label speaks only once the skeleton shows.
- **Reduced motion.** The skeleton stops pulsing and content appears without the fade.

### Named Rules

**The Still Shell Rule.** Navigation changes the page body, never the frame around it. The sidebar, top bar, and page ground are the fixed reference that tells a person only the content changed.

**The No Choreography Rule.** Never animate a navigation. Motion belongs to the element a person acted on or to the state that changed, and it never blocks the next click.

Correct: the sidebar fill glides to the clicked item while the new page body is already in place.

Wrong: wrapping the page body in a `ViewTransition` so every sidebar click slides the page.

### Reduce motion setting

Appearance has a **Reduce motion** switch saved to the person's account and cached as `openslate-motion` in the browser. On, it sets `data-motion="reduced"` on `<html>` before first paint (`public/theme-init.js`), and every reduced-motion rule answers to that attribute as well as to the device's `prefers-reduced-motion`: the Tailwind `motion-reduce:` variant is redefined in `globals.css` to cover both, and each hand-written reduced rule has a `[data-motion="reduced"]` twin. Off, OpenSlate follows the device setting; when the device already asks for reduced motion, the page says so.

**The Signal Not Travel Rule.** Reduced motion stops glides, height changes, and signatures, but keeps the color and state changes that say something changed.

Correct: under reduced motion, the sidebar fill jumps to the new item.

Wrong: hiding the active fill under reduced motion, so a move gives no sign of where you are.

## Components

### Buttons

Quiet and direct. A button is text first, with a 16px icon when it helps.

- **Shape:** gently curved corners (large radius).
- **Primary:** `--action` fill, `--action-ink` text, 14px weight 500, 36px tall with 16px sides. Small is 32px with 12px sides and 12px text; large is 44px.
- **Hover / Focus:** the primary and destructive fills drop to 90% opacity; secondary fades to 80%; outline and ghost take the sunken fill. Focus is a 2px `--focus` outline with a 2px offset in every look. In the Sandbox, a press adds a 10% action wash and a 1px inner outline, and color changes take 120ms.
- **Secondary / Outline / Ghost / Destructive:** secondary on the sunken fill; outline on the card surface with a `--button-edge` border and `--button-ink` text; ghost with no fill; destructive on `--danger`. Disabled is 50% opacity with no pointer events.
- **Looks:** Whiteboard sets every button at weight 700 and the outline edge at 2px. Triplicate sets weight 650 with 0.01em tracking and draws the outline button as a 1.5px pen rule in `--action`. Stockroom condenses buttons to 88% width at weight 700, with a `--ink-muted` outline edge.

### Chips (Badge)

- **Style:** 12px weight 500, 2px by 8px, medium radius. Variants: default (hover fill), secondary, success (flow), warning (warn), destructive (danger), and outline (rule border, muted ink).
- **Whiteboard:** bold marker lettering (700) with a 4px corner.
- **Triplicate:** a rubber stamp. The fill is transparent, with a square 1.5px `currentColor` frame and a second inner line (a double frame), 80% width, weight 800, 0.05em tracking. Status stamps (success, warning, destructive) sit askew at -2deg.
- **Stockroom:** label-maker tape. The code face at 75% width, weight 600, 0.04em tracking, a 1px corner, no border, and a 1px inner shade on the bottom edge. Default, secondary, and outline chips are dark tape (`--sr-tape` with `--sr-tape-ink`); the signal variants keep their tint, so the signal still reads.

### Cards / Containers

- **Corner Style:** large radius.
- **Background:** `--surface` with `--ink`.
- **Shadow Strategy:** `--card-lift`, per The Card Material Rule.
- **Border:** `--card-edge` (unset in Slate, which falls back to `--border` where Card reads it, none in Whiteboard, strong rule in Triplicate and Stockroom). Card header (`data-slot="card-header"`) and footer divide with `--border`.
- **Card header by look:** Triplicate perforates it (a dashed `--tp-perforation` rule); Stockroom sets it on a 3px `--sr-steel` shelf beam (steel, not ink, so it never outshines the titles in dark). Slate and Whiteboard keep the hairline.
- **Internal Padding:** 20px.

### Inputs / Fields

- **Style:** `--surface` fill, `--control-edge` border, large radius, 40px tall, 12px sides, 14px text. Typed text is `--data-ink` (ballpoint blue in Triplicate, ink elsewhere). The caret is `--action`; placeholders are muted ink at 80%.
- **Focus:** the border turns `--action` and a 2px `--focus` outline sits 1px outside.
- **Labels:** FieldLabel is 14px weight 500 (`data-slot="field-label"`); each look restyles it per the type skin places.
- **Looks:** Whiteboard draws inputs, selects, and text areas with a 2px marker edge. Triplicate keeps a 1px form box on `--surface`.
- **Access and Sandbox:** inside `slim-ui`, fields follow the slim controls below.

### Slim controls

Access tested a slimmer, quieter control set before any other page (owner, 2026-10-23); the Sandbox adopted it next (S1, `docs/specs/sandbox-relayout.md`), then Manage (MD1, `docs/specs/manage-relayout.md`). On 2026-10-25 the owner made the slim grammar the product identity (`docs/specs/profile-sidebar-relayout.md`): slim 32px controls from 1280px, 40px one-line rows, label-left rows, still pages, quiet actions with one primary action, framed dialogs, and 44px targets on phones. The shell, Profile, and Account settings carry it now. A page without its relayout keeps its old layout inside the slim shell, and its pass adopts the grammar. The controls apply only inside the `slim-ui` class: on the Access page root, the Sandbox control areas, the Manage page, the Profile details, and the Account settings panel, and on the content of every sheet, dialog, popover, and menu of those pages, because they render in portals. The shell rows carry their own slim sizes instead of the class (Navigation). The canvas toolbar takes the slim sizes (S16); the canvas drawing itself (nodes, lines, labels, Key content, and minimap) never carries the class. `access-ui` keeps only the Access page layout.

- **Sizes, every look, from 1280px:** fields, selects, search, and input groups are 32px tall with 10px sides; buttons are 32px with 12px sides, icon buttons 32×32; segmented items 28px; checkboxes 14px; switches 28×16; field labels 12px weight 500; sheet tabs 32px. Text stays 14px. The primary button differs by its fill, not its height. Below 1280px nothing changes and the 44px floor holds.
- **Slate skin (no `data-theme`):** a field is a sunken well (`--surface-sunken`) with clear sides and top and a 1px bottom rule, small top corners and a square bottom. The rule is the field's 3:1 edge: `--control-edge` in dark, `--ink-muted` in light (where `--control-edge` reaches only 2.98:1 against the well). Hover shows the full edge and keeps the rule. Focus draws a 2px `--action` rule (the rule plus an inset line) and the standard focus outline. An error draws the rule in `--danger`, with the message under the field. Disabled fields drop the fill and dash the rule. Read-only values are plain text, never a disabled field. Outline buttons become quiet buttons: no border, the sunken fill, the hover fill on hover.
- **Other looks:** Whiteboard, Triplicate, and Stockroom keep their own field and button skins at the slim sizes.
- **On a sunken panel:** a field inside an inline panel on the sunken fill (for example Add to group) takes the surface as its well (`--slim-well: var(--surface)`, set by a data attribute on the panel), so the well still steps away from its ground. The bottom rule stays the 3:1 edge.
- **Advanced in a sheet:** the closed Advanced header names what is inside instead of a set count when the block holds actions, not settings: "Advanced · Disable, Delete", "Advanced · Delete group".
- **Layout:** in a sheet, Details uses label-left rows: a 128px muted label column and the field on the right, about 40px per row, so the tab reads as facts until someone edits it. Dialogs and toolbars keep the label above. Phones stack the label above the field. Every label is a real `<label for>`.

Correct: the person sheet shows "Job title" in the muted label column and "Service Coordinator" in a sunken well with a hairline under it; hovering draws the full edge.

Wrong: a disabled, boxed "Email" field that the person cannot change (it is read-only, so it is plain text), or a 44px bordered box at 1440px inside Access.

### Tabs

The open-tab mark is one element, `data-slot="tabs-indicator"` (Base UI's tab indicator), that glides between tabs over `--motion-base`; the open tab itself only changes its ink and weight. Each look styles the indicator:

- **Slate:** a sunken rail (`--surface-sunken`, 4px pad, inset `--rule` hairline); the indicator is the lifted `--surface-raised` pill with an inset `--rule` hairline, and the open tab takes `--action-text`.
- **Whiteboard:** no rail (transparent, no pad, 4px gaps). Tabs have a 6px top-only corner; the indicator is a 4px inset `--action` marker stroke, and the open tab is weight 700.
- **Triplicate:** form sections. The list has no fill and a 1px `--ink` rule under it; tabs are square; the indicator is a 3px `--ink` rule, and the open tab is weight 700.
- **Stockroom:** a steel rail (`--sr-steel-lite`, 2px corner, 2px `--sr-steel` inset at the bottom). The indicator is a surface tab with a 3px `--action` edge on a 1px steel lip, and the open tab is weight 700.

### Notices (Alert)

A tinted band per signal: warning, destructive, and success use the signal's `-tint` fill and `-rule` border with `--ink` text; default uses the card surface. 16px padding, 14px text, `role="status"` for ordinary notices and `role="alert"` for failures. Whiteboard draws a 2px border with a 6px corner. Triplicate draws a square 3px double border, like a stamped box. Stockroom keeps a 1px border with a 2px corner and adds a 3px inset band in the text color along the top.

### Request feedback

Keep feedback where the person can act on it. Preserve working inline notices; use a toast when the action leaves no inline surface. The Four Moments Rule sets the order of channels; this table applies it.

| Situation | Feedback |
| --- | --- |
| An action in an open dialog, sheet, or form | Inline. If success closes the dialog, also show a success toast. Failure stays inline. |
| An action that closes or leaves its surface | Toast. |
| A one-click list action or a background action | Toast. |
| Sandbox autosave | Header status for progress and success; a destructive inline alert for failure. |
| Authentication pages | An inline Alert on the destination page. Password setup and recovery completion say “Password set. Sign in.” |
| Any request failure | `role="alert"` and the destructive variant; never neutral status styling. |

Show safe, actionable error text based on known status and error codes. Network failures, unexpected responses, and unknown errors use generic text without exposing raw server messages. Deduplicate an error while its toast is visible; allow it again after dismissal. Keep independent success notices separate. Clear private workspace notices and their actions when the verified account ends or changes.

### Tables

Hairline rows with 14px cells. Cells stay `--ink` in every look, so stored data never reads as a link. Whiteboard puts a 2px `--wb-tape` rule under bold heads. Triplicate makes a ruled ledger: a 1.5px `--ink` rule under the heads and a line number on each record row: a CSS counter in a `::before` with empty alternative text (`content: counter(tp-line) / ""`), placed in the first cell's left padding, with the same padding on the first head cell. Rows with a spanning cell (empty states, expanded details) and rows led by a checkbox get no number. Stockroom sets the heads on a steel band (`--sr-steel-lite`) with a 2px `--sr-steel` rule.

**Access rows.** People, Groups, and Sessions share one row grammar. From 1280px a row is 40px and one line: a 24px avatar with the presence dot, the name at weight 500 and the email in muted ink on the same line (truncated, full text available), then words, dots, chips, and marks instead of sentences: Role as a word (Administrator as the action-tint chip), Status as a dot and a word ("Ends in 5 days" for an expiring guest), groups as chips with "+n", departments as marks with a count, two-step as "On" with a shield in flow ink, "Off", or "Unknown", and last activity as relative time in tabular figures. The whole row is one open target (`RowOpenButton`, named "Manage <name>"); the name is not a hover card. Hover takes the 6% ink tint and the open row the 14% tint. The head is sticky inside the scrolling table; a look's head band still applies. From 768 to 1279px a row keeps Person, Role, Status, and Last active, and the sheet holds the rest; phones show two-line rows of at least 56px. Row chips render through `Badge`, so each look's chip skin (Triplicate stamps, Stockroom tape) applies, and the row and the sheet read the same.

**Undo inside a sheet.** A sheet covers the toast region, so an Undo there could not be clicked. Inside an Access sheet, a discarded edit shows an inline line under the tab, "Changes discarded · Undo", in muted text with a ghost Undo, until the next edit or the sheet closes. An action that closes the sheet (Delete person) uses the ordinary Undo toast.

**Status quick filters.** Beside the People search, a segmented control filters by status with counts: All, Active, Invited, Ending soon, Disabled, and a final "More" menu with the rare statuses (Expired, Deleted, Everyone); a rare status shows as the selected item ("Status: Deleted"). The counts are organization totals and do not follow the search. Status lives only here. On phones the control scrolls sideways instead of wrapping. The Sort select at the toolbar end is a field like any other: it keeps the field skin and its 3:1 edge, with a "Sort:" label before it.

**Groups rows.** A group row is its name, the member count, and its reach in one line: up to four department marks, "N departments", and the strongest level as one chip; a screen-reader sentence lists every department with its level, and the group sheet's Access tab holds the full list. Name takes about 28% when no Description column shows. Phones show two-line rows.

**A section the account cannot open.** A link to an Access section that the account cannot open lands on the section it can open, with one default notice at the top that names the asked section ("People is not available to your account."). The next navigation inside Access clears it. Never a silent redirect.

**Filters.** Every other filter sits behind one quiet "Filters" button. From 768px it opens a popover anchored to the button's right edge: label-left rows of slim fields (a 96px muted label column), searchable dropdowns for long lists (Group, Department), filters that apply as they are chosen, and a ghost "Clear all". Below 768px it opens as a bottom sheet. The table never moves when it opens. Active filters show as removable chips in a slim row above the table ("Showing Role: Administrator ✕ · Two-step: Off ✕ · Clear all"); each ✕ is a named button, the Filters button carries the count, the row is absent when nothing is active, and links from the Overview land as chips. Groups and Sessions use the same button, popover, and chips.

Correct: "Active 43" in the segmented control and a 40px row "Ana Castillo ana.castillo@… · Member · ● Active · Service Triage · ■■ 2 · Off · 3 hours ago".

Wrong: a 145px row with two avatars, the username under the name, and an underlined "Manage" link.

### Dialogs, sheets, and menus

Card surface (popover surface for menus), a `--border` edge, and a large shadow; dialogs and menus take the large radius. Whiteboard frames dialogs and sheets in 3px aluminium (`--wb-frame`) with a 1px highlight and the raised lift. Triplicate makes them carbon slips: an `--ink` edge, a 2px dashed `--ink` top (the perforation), and square corners; its dropdown menus take a square 1px `--ink` edge. Stockroom gives dialogs and sheets a 5px inset steel band on top and the raised lift.

### Radio cards

A choice of two to four options, drawn as cards with `RadioGroupItem`. "Who can use this channel" (`channel-scope.tsx`) uses it. Color in Account settings is a radio group drawn as a segmented rail instead (Profile and Account settings).

- **Shape:** a bordered card at least 44px tall, medium radius, 12px padding. An option is left-aligned: an 18px line icon, the title (14px, weight 600) over a one-line description in muted body text, and a 15px check at the right.
- **States:** unselected takes a `--border` edge, and the sunken fill on hover. Selected takes an `--action` edge, the `--action-tint` fill, `--action-text` ink, and the check. Focus is the standard ring.
- **Locked option:** `DisabledReason` wraps it with `reasonId`, so it stays focusable, ignores the click, and opens the reason on hover, focus, or tap. Its ink turns muted, hover adds no fill, a lock icon takes the check's place, and the reason shows as 12px muted text under the card; the card points at that text, so a screen reader reads it once.
- **Order and columns:** one column on phones, two from 640px. When only one option is open to the viewer, it comes first, so the selected card shows without scrolling.
- **Follow-up field:** a field that only one option needs (Department) appears under the group only while that option is chosen.

Correct: "Who can use this channel" shows Organization and Department as two radio cards; a member sees Department first and Organization locked, with "Only admins can create organization channels." under it.

Wrong: the same choice as a select, or as a segmented control with the descriptions in tooltips.

### Read-only summaries

What the viewer cannot change here is text on a sunken block (The Read-Only Is Text Rule).

- **Block:** the sunken fill (`bg-muted`), large radius, 10px by 12px padding, 14px text, at most `max-w-prose` wide.
- **Value line:** "Label: value", with the label at weight 500, then the description in muted ink. The channel scope summary repeats the description of the radio card that made the choice (`SCOPE_COPY`), so the words match.
- **Access list:** a `dl` in a two-column grid: who (`dt`, weight 500) and what they can do (`dd`, muted), 16px between the columns and 6px between rows. The outcome is a phrase ("can read", "can post", "can manage"); no color carries it.
- **Where to change it:** when the viewer can change the source in another workspace, one underlined text link names the place ("Change department roles in Access → Groups"). Other viewers see no link and no control.
- **A list that someone else edits:** rows show a word chip instead of a select, and one muted line names who can change it ("Only an admin or a manager of Sales can change this list.").

### Level badges

An access level is always a word in a chip (`LevelBadge`, `member-level.tsx`). The member panel and the channel's Members tab use the same chip.

- **Read:** outline chip. **Post:** secondary chip. **Manager:** the one tinted level, with the `--action-tint` fill and `--action-text` ink.
- **Grants:** access given to people outside the department uses two words of its own, "Read" and "Read and post": a select on rows the viewer can change, a chip on the rest.
- **Place:** in the member panel, the chip follows the person's departments on the row's second line; in the Members tab, it ends the row.

### Grouped search

`SearchSelect` lists options under headings when the options carry a `group`; groups keep the order given (Groups, then People). Headings are 12px muted at weight 500. Each option row is at least 44px, with the name and an optional 12px muted description (a person's departments). An option that cannot be chosen stays in the list, disabled, and its description says why ("Already has access"). The empty line follows the query: "Type a name to find them." before typing, "No groups or people match." after. Loading, an error with Retry, and Load more keep the SearchSelect pattern.

### Access grants list

"Also has access" (`access-grants.tsx`) lists the groups and people outside the department who can also read or post.

- **List:** a bordered list with hairline dividers, large radius, at most `max-w-prose` wide. A row has a 16px muted icon (group or person), the name at weight 500, and a 12px muted line under it: "Group · 3 people", the person's departments with their marks ("No department" when none), or "From category <name>" for an inherited row.
- **Inherited first:** grants from the channel's category come first and are read-only. The channel's own grants follow and are editable.
- **Per-row save:** the level select and a ghost text Remove (named "Remove access for <name>") save at once; there is no form-level Save. While a row saves, it is `aria-busy`, its controls lock, its line adds "· Saving…", and the chosen level stays shown. A failure shows under that row in danger text with `role="alert"`; a conflict says "Someone changed access first. Check the list, then try again."
- **Empty:** one muted line that names the department with its mark ("Only people with a role in Sales can use this channel.").
- **Give access:** an outline button opens an inline panel on the sunken fill, not a second dialog: the grouped search, a Level radio pair (Read, Read and post; Read is the default), then a primary "Give access" (pending label "Giving access…") and a ghost Cancel.
- **Hidden:** organization channels have no grants list, because everyone already has access. A viewer whose read is refused sees nothing.
- **Phones:** the name stacks above the controls, the select fills the width, and the targets are 44px.

### Navigation

The sidebar holds workspaces and their sections. From 1280px each workspace row and section is 32px and one line with a 14px label; workspace rows lead with a 16px line icon at a 1.65 stroke. A row's description ("Who can see and change what") is its `title` and `aria-description`, never a visible line; the collapsed rail's tooltip reads "Access — Who can see and change what". From 1024px to 1279px the rows stay one line at the 44px floor. The drawer (below 1024px) has 44px rows, and a closed workspace row (and OpenComms) shows its description as a visible second line in `text-xs` sidebar-muted ink; an open row shows its sections instead. The name alone stays the row's accessible name.

The sidebar header holds the 24px organization mark (a link to the workspace home), the organization menu with the full name (it wraps to two lines before it truncates; 40px tall from 1280px), and the collapse control, a quiet `--sidebar-muted` icon button ("Collapse sidebar"), 32px from 1280px. In the rail the mark is the organization menu trigger ("Organization: <name>"), and the menu's first item is "Workspace home". The footer, above a `--sidebar-border` rule, holds OpenComms with its unread count, then the account row: a 24px avatar, the name, and the role as a muted second line that is also the row's `aria-description`. The account row is a link to `/profile`, named "Your profile, <name>", 40px tall from 1280px (48px in the drawer), and current only on the person's own profile.

The current section is `--action-text` at weight 600 on the gliding `--sidebar-accent` fill (Motion, Active item). OpenComms and the account row, when current, take the same ink on their own `--sidebar-accent` fill. The active workspace row keeps its own `--sidebar-accent` fill in sidebar ink. The sidebar's scroll area follows the Quiet Scrollbar Rule with a `--sidebar-muted` thumb.

The header stays 56px. From 1280px its controls are 32px (Search, the notification bell, Help, and the account menu); below 1280px they are 44px. Search is a quiet link to Platform search, named "Search workspace": from 640px it shows the word "Search" on the sunken fill, and below 640px it is an icon. The account menu holds Your profile, Account settings, and Sign out. The breadcrumbs read Workspace › workspace › section.

Correct: at 1440px the Access row is 32px and one line, and its tooltip reads "Who can see and change what".

Wrong: a two-line 44px row at 1440px with the description cut under the name, or a 32px drawer row on a phone.

The top bar (`data-skin="topbar"`) and sidebar carry the look's frame. Whiteboard puts a 1px frame rule under the top bar. Triplicate prints the top bar as a form header with a double `--ink` rule and rules the sidebar edge in `--ink`. Stockroom paints the sidebar steel through the `--sidebar` token (so the pinned OpenComms block matches) with a 1px `--sr-steel` edge on `sidebar-container`, and sets the top bar on a 3px `--sr-steel` rail.

### Counts

An unread count is a number, at most "99+", and the control's accessible name carries it.

- **Shell:** the notification bell and the OpenComms sidebar link show a fully round count pill: `--action` fill, `--action-ink` text, 12px tabular figures, 16px tall. The pill is `aria-hidden`; the control's name says "Notifications, 3 unread" or "OpenComms, 3 unread". The collapsed sidebar rail shows an 8px action dot with a sidebar-colored ring instead.
- **Tab title:** on every signed-in page, the OpenComms unread count prefixes the title ("(3) Sandbox | OpenSlate", "(99+) " at most), and the prefix goes when the count clears.
- **Conversation rows:** a secondary chip at the end of the row, with its own name ("3 unread", "1 mention"). A mention count takes the unread count's place; a muted row shows no unread count but still shows mentions. Unread rows are at weight 600; read rows are muted at weight 500.

### Sample data note

`SampleDataNote` is the one label for sample data: an outline "Example" chip, then the screen's own sentence, then "Changes last until you close this tab." Every screen that runs on the local sample runtime shows it.

### Publish status

The Sandbox header has one save-state chip (`role="status"`). It names the publish state ("Nothing to publish yet", "Not published yet", "Unpublished changes", or "Published"), then what is happening to the draft ("Saving…", "Saved", or "N unsaved trigger changes"). A save conflict turns the whole chip to "Not saved". Review & Publish is available only when publishing would change something, and its disabled state says why ("Nothing to publish yet.", "Save trigger changes first."). Trigger settings that cannot publish show in the page's "need attention" list before the review, and each blocker in the review has a button that opens it. The review groups changes by kind (departments, modules, fields, relationships, triggers), with a New, Changed, Closed, or Reopened chip on each row, field changes nested under their module, and a "Show all" control on groups longer than five rows.

### Sandbox sections (relayout)

The Sandbox uses the Access grammar around its canvas (`docs/specs/sandbox-relayout.md`). Each section title names the section; the save-state chip and, when something needs attention, one quiet warn-ink button ("2 need attention") sit under it. The button opens a popover of rows with the same actions; a polite live region announces count changes.

- **Two panes.** Triggers and History are a list and a detail; Test is Setup and Result. Lists use 40px rows with the selected row in the tint only (The One Selection Rule), search, and quick filters with counts.
- **Triggers.** Rows show an On/Off dot and word, the name, and the event. The detail is Name and Status (a switch whose word reads On or Off) as label-left rows, then one When / If / Then rail that is the editor. The explicit Save bar stays; Undo notices close on the next edit or save.
- **History.** Rows group by day with the kind as an icon and a word (hidden when the label already starts with it). Automatic saves fold into one row per day and show during a search. Compare lives in the version detail: Older and Newer selects, ordered older to newer, preselected to the previous version; the result reads as tagged rows. Restore is a quiet button with its confirmation.
- **Test.** Result shows a run only when it matches the current module, event, and watched field; a mismatch asks for a run, and changed inputs say so from the run itself. Setup fields show an error only after a run on this page fails.
- **Build.** With nothing selected, Properties is a Summary of "Needs attention" rows or "All clear"; the footer holds the counts. Settings are label-left rows and Advanced names what it holds, marking set values "(set)". The canvas opens fitted; the minimap hides while everything is in view.
- **Dialogs.** A pinned header and footer and a named close button; on phones the dialog is the only scroller. A disabled primary says why.
- **Phones.** Two short header rows (title with Review & Publish and the menu; then the chip and attention button); Undo and Redo sit beside the pane tabs.

### Manage sections (relayout)

Manage uses the Access grammar inside `manage-ui` and `slim-ui` (`docs/specs/manage-relayout.md`: layout direction, MD1–MD20, glossary MG1–MG39). From 1280px the page stays still and only its panels scroll.

**Header.** The section title (`data-slot="page-title"`) has one 14px muted meta line under it that says what the section is for. There is no source chip, repeated sentence, or banner. Actions are quiet (ghost). A section has at most one primary action: Back up now in the Backup Status panel, or Save settings in the Organization footer. On phones the actions take a second row (`data-slot="page-actions"`) that never scrolls sideways; from 640px they sit beside the title.

Correct: "Backup" over "The person who runs your server restores backups.", then a ghost "Access security" button with a shield icon.

Wrong: an "Organization" source chip, a sentence, and a banner under the title that repeat one fact, and a filled Export button.

**Sections by role.** The navigation shows a section only to an account that can open it. Organization shows to every member; administrators edit and the others read. Audit shows to administrators, and to department managers for the departments they manage. Jobs shows to a verified administrator, and Backup and Updates & licensing show to the installation owner. A direct link to a hidden section shows one default notice and "Go to <first open section>". The notice has no Retry and sends no refused request; only a failed access check ("Your access could not be checked.") offers Retry.

Correct: a department manager opens `/manage?view=backup` and reads "Backup is managed by the installation owner." with "Go to Organization".

Wrong: the Backup controls over a 403 error, with a Retry that can never succeed.

**Summary first.** Backup opens on a Status panel (Schedule, Last good backup, Service, Queue). Updates & licensing is one Installation panel (Version, Release check, License, Limits). Each panel is a card with a 56px header that holds the panel title (`data-slot="section-title"`) and the panel's actions. Its rows are label-left: a muted label column of 7rem (8.5rem from 640px), values in tabular figures, and 6px between rows. A missing time reads "—".

Correct: "Last good backup" in the muted label column, and its time with "Verified" beside it, as one row of the Status panel.

Wrong: a schedule card, a status banner, and a history header, each with its own heading and sentence.

**Lists.** From 1280px a row is 40px and one line. Its state is a `StatusWord` (an 8px dot and a word); an Audit row puts a `StatusDot` before its verb. Backup, Jobs, Audit, and Security events share one tone map: `flow` done, `action` running or changed, `danger` failed or deleted, `warn` interrupted, denied, or partial, and `muted` waiting or ended. The muted dot is a hollow `--ink-muted` ring. Above a list sit quick filters, the Filters popover, and removable chips; below it sits the shared `TablePagination` (10 rows). Manage quick filters show no counts, because each count costs another read. Below 1280px Jobs and Audit change from tables to two-line list rows.

Correct: a 40px Jobs row with "Queued" beside a hollow ring, the subject in ink, and "—" for no attempts.

Wrong: a green "Succeeded" badge in Jobs, a filled dot for Queued in Backup, and blue subject links.

**The Audit sentence row.** An Activity row is one sentence: the verb and the target at weight 500, up to two field names in muted ink between them ("Changed Status, Sent on +3 · Quote Q-1042"). The whole row opens the event sheet. Bookkeeping values (ids, revisions, times, keys, digests) stay out of the sentence and What changed; Advanced shows them raw, with "Record ID". A reference (a person, department, module, field, or record) reads as its loaded name, else "Set", "Changed", or "Removed", never as an id. A target without a name falls back to the kind alone ("Created · Test run").

Correct: "Changed Description · Organization Harbor Operations Group", with the revision only in Advanced.

Wrong: "Changed Revision, Description · Organization 01a14acf", or "Created by 01a15e0a-…" in What changed.

**The shared dialog frame.** Manage dialogs use the Sandbox frame in `ui/dialog-frame.tsx`. With `dialogFrameContentClass`, the content is the only scroller. `DialogFrameHeader` keeps the title and a close named for its result ("Close without backing up") in view, and `DialogFrameFooter` keeps the buttons in view. The form dialogs (Back up now, Prepare encrypted backup, Confirm password) put an outline Cancel beside the action and open on their first field. The Backup schedule dialog shows Close at rest, and Discard changes and Save schedule only after an edit. Closing it after an edit (the close, Escape, or a click outside) asks "Discard unsaved changes?" first.

Correct: on a phone, Back up now keeps its title, the named close, and Cancel beside Back up now in view while the fields scroll.

Wrong: a "Saved · Discard · Save" bar before any edit, or a closed dialog that keeps an edit behind an "Unsaved changes" chip.

**Words.** One object keeps one word in the section, its dialogs, and Help: "backup schedule", never "policy"; "Manual" and "Automatic" for the source. Work on the server names "the person who runs your server". "Installation owner" names the in-app account, and only in refusals and the hidden-section notice ("Only the installation owner can do this.").

Correct: the Updates meta line "The person who runs your server installs updates."

Wrong: "Operator recovery required", or "Only administrators can request a backup." for an action that only the installation owner can do.

### Profile and Account settings (relayout)

Profile (`/profile`, `/profile?person=<id>`) and Account settings (`/settings`) use the slim grammar (`docs/specs/profile-sidebar-relayout.md`: layout direction, PD1–PD65, glossary PG1–PG35). From 1280px both pages stay still and only their panels scroll. Each page sets its own frame, so the shell has no branch for them.

**The Profile view.** Profile is read-only. A quiet band on `--surface-sunken` with a hairline under it spans the content area (96px tall, 120px from 768px); it holds no photo and no generated image. Without the shell it is a rounded, bordered block in the column. The left column (300px from 1280px) holds the 96px photo with a 4px ring in the page ground, 48px over the band's edge, then the name as the page title (24px, weight 600) and the job title in muted ink. Only the person's own profile has a button: a secondary "Account settings" with the `UserCog` icon. The right column (at most 760px) scrolls alone and holds card panels with a 40px header and a 16px section title. About (Phone, Role, Groups) is label-left rows: an 8rem column of 13px muted labels and 40px rows from 768px, stacked 56px rows on phones. Groups are secondary chips, and the phone is a `tel:` link in `--action-text`. Bio is text at most 65ch wide. An empty field shows no row, and a profile with no bio shows no Bio panel. A guest's view has only the photo, the name, and the job title. On the person's own bare profile (no job title, phone, or bio, but a role), one muted line under About reads "Add your job title, phone, and bio in Account settings.", with "Account settings" as the link. A profile that is not available shows one default notice, "This profile is not available.", with "Go to your profile" and no Retry; the notice, the crumb ("Profile"), and the tab title never name the person. A failed read is a different state: a destructive notice, "This profile could not load.", with Retry.

Correct: another member's profile at 1440px shows the band, the photo over its edge, "Ana Castillo" over "Service Coordinator", and About with Phone, Role "Member", and two group chips; it has no button, and no Bio panel when the bio is empty.

Wrong: a "Phone: —" row, an "Account settings" button on someone else's profile, or "Ana Castillo is not available." for a person the viewer cannot see.

**Account settings.** The page follows Manage › Organization. The header is the title "Account settings" (24px, 30px from 640px, weight 600) over one 14px muted meta line. From 1280px two panes fill the viewport: the settings panel (a card that carries `slim-ui`) and Preview (300px, 340px from 1440px); each scrolls on its own. Below 1280px one column scrolls with the frame. The panel holds four groups, Identity, Sign-in, Appearance, and Regional, each with a 16px section title over label-left rows: from 768px a muted label column of 8rem (10rem from 1440px), level with the first control line; phones stack the label above. Identity holds the photo, display name, job title, phone, bio, and email (last). The four text fields save through one pinned footer; the photo and email save on their own, as described below. The footer has the save-state chip ("Saved", "1 unsaved change", "Saving profile…", then "Profile saved."), Discard changes only while there is a draft, and Save profile, the page's one primary action, which says "No changes to save." at rest. A save error shows in the footer, beside the button. The footer ends the panel from 1280px and sticks to the bottom of the viewport below it. Appearance and Regional save at once, with one status line beside the title of the group changed last: empty at rest, "Saved" with a flow check after a change in this visit, or the shared status with "Retry preferences". The photo saves at once too, with its own status in its row ("Uploading…", "Removing…", "Photo saved", "Photo removed"), and never moves the footer chip. Color is a radio group drawn as a segmented rail on the muted fill (28px segments from 1280px, 44px below); the checked segment takes the card surface and a `--rule` hairline. Preview shows only what the panel cannot: how others see you (the person card drawn from the draft, with "View your profile"), your formats, and an appearance sample whose button is a picture, not a control.

Correct: a color mode change shows "Saved" beside Appearance while the footer chip still reads "Saved"; typing a job title turns the chip to "1 unsaved change" and enables Save profile.

Wrong: a Save button in each group, "Saved" beside Appearance before any change, or "Profile saved." in the footer after a photo upload.

**Sign-in and dialogs.** Sign-in is label-left rows with status words, not sentences. Email, the last Identity row, shows the saved address as plain text; Password shows no value, because the server sends no change date. Each has an outline "Change…" (quiet under the Slate slim skin) whose accessible name starts with the visible word ("Change email", "Change password"). Two-step is a `StatusWord` ("On" in flow, "Off" muted) with "Manage…". Sessions are 40px one-line rows from 768px (56px two-line rows on phones) in a bordered list: a device icon, the device and browser at weight 500 with the full user agent as its tooltip, "This device" as an `--action-tint` chip in `--action-text` on the current session, then the address ("Unknown address" when none) and "Last active" with the date and time, in 13px muted tabular figures. Each row ends in a ⋯ menu named for the device ("Session actions, Safari on macOS"), whose one item, End session, is named "End session, Safari on macOS". Below the list sits an outline "Sign out other sessions"; with no other session it says why ("No other sessions."). The end-session confirmation names the device in its title ("End the session on Safari, macOS?"). Change email and Change password use the shared dialog frame (a named close, a pinned footer, Cancel beside the action) and open on their first field (New email, Current password). The password dialog says "Other devices sign out after the change." before the action. Two-step has the framed header and "Close two-step", and its steps stay in the body (PD40). The end-session and unsaved-changes confirmations keep the plain alert dialog.

Correct: a 40px row "Safari on macOS · This device · 192.168.1.20 · Last active Oct 25, 9:41 AM" with a ⋯ menu named "Session actions, Safari on macOS, this device".

Wrong: four rows that all read "Safari on macOS, 127.0.0.1" with an unnamed End button each, or a two-step status that shows only inside its dialog.

**Searchable lists.** A `SearchSelect` whose popup carries `slim-ui` (Access, Manage, and Account settings pass it) has 32px options from 1280px; elsewhere, and below 1280px, options stay at least 44px (Grouped search). The chosen option has a 16px check at its end in `--action-text`, so it shows without the highlight. The popup is at most `min(20rem, var(--available-height))`, about 10 slim rows: it opens below its field when that fits, flips above only when it does not (the default collision flip), and then covers at most 20rem, so a field near the bottom of a phone screen never gets a tiny list.

Correct: the Regional timezone list at 1440px has 32px rows, "UTC+08:00 · Asia/Manila" with a check at its end, and stops at 20rem.

Wrong: a list of 400 zones as tall as the viewport that covers the header, or a chosen option shown only by its highlight.

**Phones.** Below 768px the 56px bar names no page on `/profile` and `/settings`: the page heading (the person's name, or "Account settings") is the title row under the bar, as the section title is in the Sandbox and Manage, because the bar beside its 44px controls cuts long names. Profile stacks the photo, name, and job title, then About, then Bio, in one column; Account settings is one column with the footer pinned at the bottom. Below 1280px every target is 44px, including the account menu items, the fill-hint link, the phone link, the Color segments, and the switch labels. The shared `Input` and `Textarea` take 16px text below 768px and 14px from 768px, so iOS Safari does not zoom when a field takes focus.

Correct: at 390px `/settings` shows the bar's controls, then "Account settings" as the heading row under the bar, and a tap in Display name does not zoom the page.

Wrong: "Account settin…" cut in the phone bar, or a 14px field that makes Safari zoom on focus.

### Organization look picker

A radio group of four tiles (two columns below 1440px, four from 1440px). Each tile shows a small canvas swatch drawn with that look's own tokens (`data-theme-preview`): a department head with its identity mark, and a table card with a header and two field rows. The checked tile takes an `--action` border and ring. The look is saved for the workspace; each person keeps their own color mode.

### Access overview (dashboard)

The Access Overview answers "who is here" and "what needs attention", from existing data only, and stays still from 1280px.

- **Who's here:** one line with tabular figures ("5 signed in now · 8 in the last day · 16 in the last 7 days, of 35 people", then " · 3 disabled not counted" when any are disabled), the people signed in now as small chips (the viewer last, "+n" to Security), and one bar of everyone by last sign-in, as ranges that never repeat a phrase of the line: Now, Under a day, 1–7 days, 7–30 days (a ramp from `--action` to a faint tint), Older (`--rule-strong`), Never signed in (hatched), Invited (outlined). "Now" counts the roster that the chips show, and the line's other counts never fall below it. The bar has a full accessible sentence in the same words. Legend words that open a filtered list are in `--action-text`; the time ranges are plain ink.
- **Recent sign-ins:** Access rows with the time, the person (or "Unknown account"), the address, and a dot and a word in a fixed 6rem column (Signed in, Failed in danger, Locked in warn). A row from an earlier day stacks the day in 12px muted ink ("Yesterday", a weekday within 7 days, else "Oct 21") over the time, inside the same 40px row and 4.5rem column; today shows the time alone. Days follow the organization time zone.
- **Needs attention:** first in reading order (on a phone it comes before the sign-in feed); only items above zero, in severity order, as 40px rows with a toned icon, a bold count, and a verb ("Review", "Add to groups", "Show"); then one "All clear: …" line that names the zeros. It stays whole from 768px tall; below that its body scrolls, and the cut row is the cue.
- **Access by department:** each department with its mark, the people who can reach it, and a level bar that differs by pattern, not hue: Read outlined, Write hatched, Manage solid `--action`. The counts ("R 8 · W 0 · M 3") replace the bar on hover, focus, and touch. A guest counts at Read; administrators are named apart ("2 administrators manage all.").
- **Overflow:** a card that scrolls always shows that it does. The sign-in feed never scrolls: it shows the rows that fit and pages by time ("‹ Newer · Older ›", time cursors over the merged events, so no row is skipped or repeated). Needs attention and Access by department scroll inside, with a soft bottom fade and an edge shadow while more is below (neither covers a focused row), the header count, and for departments a footer count ("2 of 14 shown"). One shared hook (`useScrollCue`) drives all three.
- **States:** each block draws its frame first and its own skeleton; a failed read shows the destructive Alert with Retry inside, few words ("Needs attention could not be loaded.").

### Access account policy

The Security page and its policy dialog keep the policy quiet until someone changes it.

- **Dialogs in Access:** a long Access dialog keeps its header and footer in view (sticky) and has a named close button ("Close new group", "Close invitation"); on a phone the dialog is the only scroller. A disabled Save at rest says why ("No changes to save."). The member picker says "Add" and "Remove" in words.
- **Frame below 1280px:** the Still Page Rule holds from 1280px. Below it, the whole Access frame scrolls as one, so the title and header buttons scroll away.
- **Reset two-step:** shown only when the person has two-step on.

- **Summary:** one card with one line of facts ("12-character passwords · Two-step for administrators · 60-minute timeout"), the viewer's own line ("Your two-step verification: Off · Set up"; in warn ink with "required for your role" when the policy requires it), and one button: Edit policy for the installation owner, View policy for everyone else. Below 768px "Set up" takes its own line, so the wrapped text keeps its line height.
- **Dialog:** label-left rows from 768px. The common settings come first (roles that must use two-step, days to set up two-step, session timeout); allowed addresses, password rules, session limits, history, and sign-in attempts go in Advanced. The footer is fixed: the save-state chip ("Unsaved changes", "Saved", or "Changes discarded" with Undo), any save error as `role="alert"` above the buttons, then Cancel, Discard changes, and Save settings. A viewer who cannot change the policy sees the values as text on the sunken fill and a footer with one Close.
- **Quiet danger:** "End all remote sessions" is an outline button in danger ink with no fill. Its confirmation names the count ("Signs out 4 sessions on 1 person"), and the result is a toast that says how many are still active.
- **Session rows:** the device line drops unknown parts and says "Unknown device" once; on phones only the current row shows a status word, and the sign-in address stays visible.
- **Stockroom:** the "Saved" chip carries `data-save-state` and takes the light tape, like the Sandbox save chip.

Correct: a non-owner administrator opens View policy and reads "Session timeout 60 minutes" on the sunken fill, with one Close in the footer.

Wrong: a disabled select for every setting, or a save error at the top of a dialog that the person has scrolled past.

### Sandbox canvas (signature)

An ERD-style canvas of the owner's own structure, drawn in the same materials as the website and the film. Departments are named frames on their own sheet (`--dept-n-sheet`) with a head band (`--dept-n-band`), a 3px top edge in the department color (the frame's own shape, clipped), an identity mark, and the name in `--font-display`. Modules are compact 232px table cards on `--dept-n-module`: a 34px header (`--dept-n-card`) with a table glyph and the table name, then 26px field rows with the name on the left in `--canvas-field-ink` and the type label on the right in `--font-code` and `--canvas-type-ink`, on `--dept-n-stripe` for alternate rows. A filled dot marks a required field; a hollow dot marks an optional one. Lines join tables at 1.6px and end in an arrowhead: a relationship is dashed in `--action`, a handoff is solid in `--canvas-edge` (the Dash Means Link Rule). Each line has a label chip (`--canvas-label-*`; `--action-text` ink on relationships) at the middle of the line, or at the first stop along it (35%, 65%, 20%, 80%) that no other line crosses, no table covers, and no other label overlaps. Hovering a module or line traces its connections in `--flow`, and only traced lines drift (2.4s per cycle) in Slate and Triplicate; Whiteboard and Stockroom turn the drift off. The Key (closed by default, opens upward) names relationship, handoff, required field, and optional field, and says in one line what a module and a line are. The minimap hides text and lines and shows frames and tables. When department frames or module tables cover each other, the canvas notice bar says "Some departments or modules overlap." with Auto-arrange and Dismiss; Dismiss holds until the layout changes, and Auto-arrange spaces rows by the drawn table height, so it never makes an overlap itself. Under reduced motion, the drift and the trace fade stop.

### OpenComms conversation (signature)

A conversation is a header, a timeline, and a composer between the conversation list and the right pane (Layout). Every refusal says why, in place, and keeps the draft.

- **Header:** at least 56px tall: the conversation icon, the name as a section title (`data-slot="section-title"`), and the description in 12px muted text from 1024px up. A channel shows its scope chip, "Organization" or "Department · Sales" (with the Sales mark): 12px muted text on the sunken fill, an inset `--border` hairline, 28px tall, the `--radius` corner, at most 256px wide. For a viewer who manages the channel, the chip is a button that opens channel settings; for others it is text. Below 640px the chip hides, and a Details button shows the menu, the description, and the scope as text lines.
- **Connection strip:** a 44px `role="status"` strip above the panes: the organization name, a muted "Connection" label, then one state: Connecting, Live, Reconnecting (only after 3 seconds, so a short drop shows nothing), Offline with a ghost Retry, or "Live updates paused in this tab" with a ghost Refresh. It is `aria-busy` while it connects.
- **Timeline dividers:** a day divider is a 12px muted label between hairlines. The "New messages" divider is a named separator in `--action-text` at weight 600.
- **Cannot post:** a default notice above the composer gives the reason ("This channel is archived. Restore it to post.", "Your role cannot post in this channel."), and the input is disabled.
- **Slow mode:** Send is disabled, and a 12px muted `role="status"` line under the composer counts down ("Send available in 12s"); the input's description points at it.
- **Other refusals:** a compact destructive notice above the input, with the server's wait when there is one ("Too many attempts. Try again in 5s."), or the mention limit ("This conversation allows 3 mentions per message."). A send that fails after it left shows "Not sent" in a destructive notice with Retry message.
- **Mention picker:** "@" opens an inline listbox above the input: a hairline border, medium radius, at most 160px tall and 8 names, 44px rows. The active row takes the secondary fill, and the input keeps focus through `aria-activedescendant`. The query may hold spaces while a name still matches; Escape, a choice, or no match closes the list.
- **Unavailable conversation:** the shared `Empty` state with "This conversation is not available.", "It may have been removed, or you may not have access.", and one Retry history action. The header reads "Not available", there is no composer, and the member, thread, and pinned lists stay empty (The Same Answer Rule).

## Do's and Don'ts

### Do:

- **Do** use semantic tokens (`bg-card`, `text-muted-foreground`, `var(--canvas-edge)`) and never a raw color or a Tailwind palette color in a component.
- **Do** add a new token to Slate light, Slate dark, and every look's light and dark blocks in the same change, and add any new text pair to the contrast guard.
- **Do** restyle a look only through tokens and the named skin places, and keep `theme-parity.spec.ts` passing.
- **Do** keep each signal to its one meaning: action acts, flow shows movement and success, warn asks for attention, danger destroys.
- **Do** put a department's identity color beside its name every time it appears.
- **Do** time every transition with the motion tokens and give it a `prefers-reduced-motion` path that keeps meaning (fades, color) and drops travel.
- **Do** show `SampleDataNote` on every screen that runs on sample data, and name the real publish state in the Sandbox header.
- **Do** put a panel's less common controls in its one closed Advanced block, last in the panel, and give every disabled control its reason.
- **Do** show a value that the viewer cannot change here as text on a sunken block, and keep disabled controls for actions the viewer cannot take now.
- **Do** show an access level or a count as a word or a number; Manager is the one tinted level.

### Don't:

- **Don't** add, remove, or reword DOM for one look. Correct: a CSS rule on `[data-slot="badge"]`. Wrong: a Triplicate-only "Stamped" label.
- **Don't** transform case anywhere except page titles; labels, chips, table heads, and card titles can show names people typed.
- **Don't** let a look erase the difference between a relationship line and a handoff line; the Key must match the canvas.
- **Don't** override Card, Badge, or the canvas cells with a per-look class; set `--card-edge`, `--card-lift`, and the canvas skin tokens instead.
- **Don't** set a color, fill, radius, edge, or lift in an unlayered skin rule when an instance may override it; read a token in the base class instead (`--button-edge`, `--button-ink`, `--data-ink`).
- **Don't** use photo textures, handwriting fonts, glossy gradients, or glass; a flat 1px CSS-gradient pattern from the look's own material is allowed on the page ground and the canvas only.
- **Don't** read a look-private token (`--wb-*`, `--tp-*`, `--sr-*`) in a component.
- **Don't** use a sideways or solid block shadow; a zero-blur lift is a vertical ledge of at most 2px.
- **Don't** use warn and danger hues closer than 30°, or an action color that reads like body ink.
- **Don't** copy token values into other documents; point to `globals.css`, `themes/*.css`, and this file.
- **Don't** put two choices that each need a description in a select or a segmented control; use radio cards.
- **Don't** give a missing resource and a forbidden one different states, names, or actions.
