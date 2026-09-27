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
    fontFamily: "Geist, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.035em"
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
    fontWeight: 500
    lineHeight: "20px"
  label:
    fontFamily: "Geist, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  code:
    fontFamily: "Geist Mono, monospace"
  canvas-table:
    fontFamily: "Geist, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  canvas-field:
    fontFamily: "Geist, sans-serif"
    fontSize: "12px"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  canvas-node: "8px"
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
    textColor: "{colors.action-text}"
    typography: "{typography.control}"
    height: "44px"
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
---

# Design System: OpenSlate

## Overview

**Creative North Star: "The Themeable Slate"**

OpenSlate has no fixed identity. It is a slate that each organization themes. The owner picks one look for the whole organization in Manage > Organization > Organization look, and each person then picks light or dark. There are four looks, each with a light and a dark mode: **Slate** (the default), **Whiteboard**, **Triplicate**, and **Stockroom**. A look changes color, type, materials, shapes, and motion. It never changes layout, behavior, or words. The Sandbox is where the looks differ most: the owner's own departments and modules, drawn large as an ERD-style canvas, in the look the owner chose.

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
| Slate (default) | `:root`, `.dark` in `globals.css` | Geist / Geist Mono                      | 8px                 | Calm neutral surfaces, precise hairlines, flat cards with a rule edge. No page pattern and no canvas frame.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Whiteboard      | `themes/whiteboard.css`           | Atkinson Hyperlegible Next / Geist Mono | 6px                 | The planning board. The page is a white board with a faint 24px marker grid inside an aluminium frame; the same frame surrounds the canvas and each dialog. Marker weights everywhere: bold type, 2px field and outline-button edges, a rounded marker underline under the page title, open tabs with a 4px marker underline. Edgeless raised cards. On the canvas: taped department frames, frameless modules in their department's pastel tint, bold round-capped marker lines. Dark is a slate chalkboard.  |
| Triplicate      | `themes/triplicate.css`           | Archivo (width axis) / Geist Mono       | 2px                 | The carbon-copy business form. The page is ruled paper; the top bar is a printed header with a double rule. Navy printed structure, ballpoint blue for what people typed, condensed tracked labels, perforated card headers and dialog tops, rubber-stamp chips, numbered ledger rows, double-ruled notices. On the canvas: each department is a tinted carbon copy, modules share their department's paper, field names are in ballpoint blue, solid carbon lines with dashed handoffs. Dark is carbon paper. |
| Stockroom       | `themes/stockroom.css`            | Archivo (width axis) / Martian Mono     | 2px                 | Steel shelving and kraft boxes. A flat wall-colored page, a painted steel sidebar, a top bar on a steel rail, stencilled uppercase page titles, a heavy shelf rule under card headers, label-maker tape chips, steel table-head bands, steel-topped dialogs. On the canvas: steel uprights on the frame and on each department bay, kraft module boxes with a white paper end label and a steel shelf lip.                                                                                                     |

The choice is saved in the browser under `openslate-org-theme` (`public/theme-init.js` applies it before paint; `lib/appearance-preferences.ts` owns it). The light and dark choice is saved under `openslate-theme`. The organization look moves to a workspace setting when the backend has one.

### Named Rules

**The Look-Only Rule.** A look changes color, type, materials, shapes, and motion. It never adds, removes, or reorders DOM, and it never changes a word. `frontend/tests/http/theme-parity.spec.ts` compares the element count and `textContent` across the four looks.

Correct: `[data-theme="triplicate"] [data-slot="badge"] { border: 1px solid currentColor; }`

Wrong: `{theme === "triplicate" && <span>Stamped</span>}` (theme-only markup, and a new word).

**The Skin Place Rule.** A look restyles only through tokens and the named hooks. A new skin place is a shared hook that every look can use, added to the component once. The hooks are:

- **Shell:** `data-skin="page"` on `main#main-content`, `data-skin="topbar"` on the app header, and `data-slot="sidebar"`, `data-slot="sidebar-container"`, and `data-slot="sidebar-inner"` on the sidebar.
- **Type:** `data-slot="page-title"` (PageHeader), `card-title`, `field-label`, and `table-head`.
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

## Colors

The palette is a set of semantic roles, not a hue list. Each look supplies its own values for the same names in light and dark. Prose below names tokens; the values live in the stylesheets.

### Primary

- **Action** (`--action`, with `--action-ink`, `--action-text`, `--action-tint`): the one color that acts. It fills primary buttons, draws focus (`--focus`), marks the active navigation item (`--action-text`, weight 600), traces hovered canvas lines, and draws the minimap viewport. `--action-text` is the text-safe shade for links and active labels on a surface. `--action-tint` is a quiet fill for drop targets and selected states.

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
- **Outline button material** (`--button-edge`, `--button-ink`): the outline button's border and text. Slate leaves `--button-edge` unset and falls back to `--border` where the outline variant reads it, so the Sandbox's stronger `--border` still applies; its ink is the foreground; Whiteboard uses a marker grey edge; Triplicate uses `--action` for both; Stockroom uses a `--ink-muted` edge with `--ink` text.
- **Rules** (`--rule`, `--rule-strong`): hairline borders and dividers. The Sandbox raises its borders to `--rule-strong` (`.sandbox-ui`).
- **Control edge** (`--control-edge`): input and control borders, 3:1 against surface and ground.

### Canvas skin

The canvas has its own layer so a look can restyle the Sandbox without new markup: `--canvas-background`, `--canvas-grid`, `--canvas-grid-major`; departments (`--canvas-dept-fill`, `--canvas-dept-frame`, `--canvas-dept-ink`); module cards (`--canvas-module-fill`, `--canvas-module-frame`, `--canvas-module-ink`); field rows (`--canvas-row-rule`, `--canvas-row-stripe`, `--canvas-field-ink` for field names, `--canvas-type-ink` for type labels); lines (`--canvas-edge`); and line labels (`--canvas-label-fill`, `--canvas-label-frame`, `--canvas-label-ink`). In Slate these are aliases of the neutrals. Whiteboard, Triplicate, and Stockroom give them their own materials. `--canvas-field-ink` is `--canvas-module-ink` in every look except Triplicate, where field names are ballpoint blue.

### Department identity

Four identity colors per look (`--dept-1` to `--dept-4`), cycled in department order. Each department also has four fills:

| Token             | Fills                 | Slate                  | Whiteboard            | Triplicate          | Stockroom                            |
| ----------------- | --------------------- | ---------------------- | --------------------- | ------------------- | ------------------------------------ |
| `--dept-n`        | identity mark         | identity hue           | pastel marker hue     | identity hue        | identity hue                         |
| `--dept-n-band`   | department head       | `--canvas-dept-fill`   | the pastel `--dept-n` | paper tint          | one steel band for all               |
| `--dept-n-card`   | module header         | `--surface-sunken`     | light pastel tint     | the same paper tint | paper end label (white in light)     |
| `--dept-n-sheet`  | department frame body | `--canvas-dept-fill`   | `--canvas-dept-fill`  | paper tint          | `--canvas-dept-fill`                 |
| `--dept-n-module` | module body           | `--canvas-module-fill` | `--dept-n-card`       | `--dept-n-sheet`    | kraft (`--canvas-module-fill`)       |
| `--dept-n-stripe` | alternate field rows  | `--canvas-row-stripe`  | `--dept-n-card`       | `--dept-n-sheet`    | darker kraft (`--canvas-row-stripe`) |

Slate and Stockroom stripe alternate field rows; Whiteboard and Triplicate set the stripe equal to the module body, so their rows are divided by `--canvas-row-rule` only.

**The Same Department Rule.** Department color is meaning: it tells an owner which department a table belongs to. Every look keeps Slate's hue order (1 violet, 2 teal, 3 amber, 4 rose) and changes only lightness and strength for its material: marker pastels in Whiteboard, paper tints in Triplicate, muted paint on steel in Stockroom.

Correct: Whiteboard's `--dept-2` is a teal marker pastel (`#8fcfc6`), so Commerce stays teal-family in every look.

Wrong: Whiteboard's `--dept-2` is lavender, so Commerce is teal in Slate and lavender on the board.

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

Correct: the module header shows the `--dept-n` mark, then the module name, in the department's frame under its named head.

Wrong: a legend that says "purple = Commerce" and cards with only a purple edge.

**The AA Everywhere Rule.** Every text pair is at least 4.5:1, and focus rings and control borders are at least 3:1, in all eight look modes. The guard also checks `--data-ink` on card and background, `--button-ink` on card, and the canvas pairs: module ink, type ink, field ink, and line label ink on their fills; department ink on each `--dept-n-band`; module ink on each `--dept-n-card`; and field ink and type ink on each `--dept-n-module` and `--dept-n-stripe`.

Correct: adding a canvas text token also adds its pair to `PAIRS` in `check-theme-contrast.mjs`.

Wrong: a new chip tint that is checked only in Slate light.

## Typography

**UI Font:** `--font-ui`, which each look sets. Slate uses Geist; Whiteboard uses Atkinson Hyperlegible Next; Triplicate and Stockroom use Archivo with its width axis.
**Code Font:** `--font-code`. Geist Mono in Slate, Whiteboard, and Triplicate; Martian Mono in Stockroom.
**Stencil Font:** `--font-stencil`, Big Shoulders Stencil. Only Stockroom page titles use it.

**Character:** Slate reads as a precise, familiar product sans. Each other look changes the face and the width, not the hierarchy. Faces load without preload, so a browser fetches a face only when rendered text uses it, and Slate pages load none of the look faces. Canvas lettering follows `--font-ui` too.

### Hierarchy

- **Headline** (600, 24px, 30px from 640px up, line height 1.25, -0.035em): page titles only, through `PageHeader` (`data-slot="page-title"`). One per page.
- **Title Large** (600, 18px, 28px line, tight tracking): section headings inside a page, such as "Organization look".
- **Title** (600, 16px): card titles (`data-slot="card-title"`).
- **Body** (400, 14px, 20px line; descriptions use a 24px line and a 672px maximum width): the default text size for content, tables, and descriptions.
- **Control** (500, 14px): buttons, tabs, field labels, table heads.
- **Label** (500, 12px, 16px line): chips, the canvas key, pagination, and small meta text.
- **Canvas** (13px bold for table names, 12px regular for field names and types): module cards on the canvas.

### Skin places for type

- Whiteboard: page titles at weight 700 with -0.01em tracking; card titles, buttons, chips, field labels, table heads, and the open tab at weight 700.
- Triplicate: page titles at 88% width, weight 800, -0.01em tracking; card titles at 90% width, weight 700; field labels and table heads at 12px, 78% width, weight 700, 0.06em tracking, in `--ink-muted`; chips at 80% width, weight 800, 0.05em tracking; buttons at weight 650 with 0.01em tracking; ledger line numbers at 12px, 75% width, weight 700.
- Stockroom: page titles in the stencil face, uppercase, weight 800, 0.03em tracking; card titles at 85% width, weight 800; field labels and table heads at 75% width, weight 800, 0.05em tracking; buttons at 88% width, weight 700; chips in the code face at 75% width, weight 600, 0.04em tracking.

### Named Rules

**The Case Stays Rule.** A case transform is allowed only on page titles. Field labels, chips, table heads, and card titles can show names that people typed, so they keep their case. A look uses width, weight, and tracking to carry its label style instead.

Correct: `[data-theme="stockroom"] [data-slot="page-title"] { text-transform: uppercase; }`

Wrong: `[data-theme="stockroom"] [data-slot="table-head"] { text-transform: uppercase; }` (a column named "iPhone SKU" becomes "IPHONE SKU").

**The Words Stay Rule.** A look never changes the words in the DOM. `textContent` ignores `text-transform`, so the parity test compares words, not how a look displays them.

Correct: Stockroom shows "SANDBOX" in its page title with `text-transform`, and the DOM still holds "Sandbox".

Wrong: Stockroom renders the string "SANDBOX" or "Shelf: Sandbox".

## Layout

The app shell is the same in every look. A resizable sidebar (271px to 400px, collapsible to a 64px rail; a 288px sheet on phones) holds the workspaces and their sections. A sticky 56px header row holds the breadcrumbs: Workspace › workspace › section. Phones drop the Workspace root so the crumbs that change stay readable. Each route sets its own browser title (`Sandbox | OpenSlate`).

The main region pads 16px on phones and 20px by 28px from 640px up. Manage uses a tighter 12px vertical pad; OpenComms and Access fill the full height. `PageHeader` stacks the title, description, and actions on phones and puts the actions on the right from 640px up, with 28px below.

The rhythm is a 4px base: 8px and 12px gaps inside groups, 16px between groups, 20px card padding, 28px between the page header and content. Tables open at 10 rows per page (options 5, 10, 25, 50).

Targets stay reachable: sidebar items are at least 44px tall. Below 640px, shell buttons and inputs are at least 44px. In the Sandbox and its dialogs, controls are at least 44px below 1280px, and inline toggles inside a list row keep 24px so rows keep one rhythm. Breadcrumb links keep a 24px target.

**The Sandbox.** The canvas owns at least 65% of the work area. One right workbench switches between Structure and Properties; creation actions live in the workbench, not on the canvas. Narrow screens switch among Canvas, Structure, and Properties as tabs. The canvas snaps to a 24px unit and shows a dot grid (minor dots every 24px, major dots every 120px, each dot on a snap point). It scales uniformly from 50% to 150%; the floor keeps field text readable, and the minimap shows what does not fit. There is no overview level: every zoom shows the same tables with their fields. The canvas and Properties always open on the same item: with no link, Build selects the first module of the busiest department (the most modules and lines, `openingModuleId`), and the canvas opens at 100% on the selected item's department, lifting it when the selected table would sit below the fold; if the department is wider than the view, it shows the selected table whole, with the department's left edge when it fits. Fit shows the whole design and never zooms past 100%. When Fit reaches the floor, or a trace is pinned from Test, a small notice bar at the top of the canvas says so, with Dismiss, or Back to result and Clear. The minimap sits bottom right from 640px up; the Key sits bottom left at every width.

## Elevation & Depth

The system is a hybrid: tonal layering first, and a lift that each look sets. Four tokens carry depth: `--lift` (resting), `--lift-raised` (popovers and raised cards), `--lift-filter` (the SVG `drop-shadow` form of the raised lift, for canvas nodes), and `--card-lift` (a card's own material). Dark modes deepen the same shadows with black instead of tinted ink.

### Shadow Vocabulary

- **Slate:** a soft ambient lift. Cards are flat (`--card-lift` is none) and take a `--rule` edge. Popovers take a two-layer soft shadow.
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

**The Selection Lifts Rule.** On the canvas, state lift belongs to selection: the selected department or module takes `--lift-filter` and a heavier stroke. A look may give a node kind a resting material lift (Whiteboard modules, Triplicate departments, Stockroom's shelf lip), and it is the same on every node of that kind. Hovering a module or a line traces its connections: the rest dims to 35% opacity in 150ms, the traced lines turn `--action` at 2px (3.4px in Whiteboard), and nothing moves. "Show test on canvas" from a Test result pins the same trace on the tested module (`?trace=` and `?run=`) and plays the run as three still steps in a strip above the canvas (What happened, Automations, Result) with Previous step, Next step, Back to result, and Clear, plus a one-line legend. The strip repeats the result's caveats (an older draft, open issues). The trigger field row takes a solid 2.5px `--action` outline; changed rows take `--canvas-test-fill` (the action color mixed into the module fill; Stockroom dark mixes it into a darker base to keep type ink AA) and a dashed 1.5px `--action` outline, so the marks differ by pattern, not only hue. A field can carry both. Rows also carry an `aria-description` ("started the test", "changed in the test"). Each step keeps the earlier marks, and nothing moves. Clear, or a click on empty canvas, removes the trace and the marks; Back to result reopens the same run on its module and event.

Correct: `.sandbox-ui .x6-cell[data-trace="dim"] { opacity: 0.35; }`

Wrong: hover scales the table up or slides the connected tables toward it.

## Shapes

Corners come from one token, `--radius`: 8px in Slate, 6px in Whiteboard, 2px in Triplicate and Stockroom. Tailwind derives the steps: large is `--radius`, medium is 2px less, small is 4px less (and resolves to square in the 2px looks). Buttons, inputs, cards, tab rails, and notices use large; chips use medium; the active tab uses small. Skin rules set a few corners directly: Whiteboard gives tabs a 6px top-only corner; Triplicate squares chips, tabs, notices, dialogs, sheets, and menus; Stockroom sets 1px on chips and 2px on the tab rail and notices.

Borders start as hairlines (1px). A look may thicken or restyle a border for its material:

- **Whiteboard (marker):** 2px on inputs, selects, text areas, outline buttons, and notices; a 2px tape rule under table heads; a 3px aluminium frame on dialogs and sheets; a 1px frame rule under the top bar.
- **Triplicate (printed form):** 1.5px on outline buttons and chips (with a second inner stamp line); a 1.5px ink rule under table heads; a 3px double border on notices; a dashed perforation under card headers and a 2px dashed ink top on dialogs and sheets; a 1px ink rule on the sidebar and menus.
- **Stockroom (steel):** a 3px `--sr-steel` shelf beam under card headers; a 2px steel rule under the steel table-head band; 1px row rules.

Canvas nodes draw an 8px corner in SVG. Triplicate squares department and module bodies and headers (`rx: 0`); Stockroom sets 2px. The Sandbox uses the stronger rule. On the canvas, a look may thicken strokes for its material:

| Look       | Department frame (idle / selected) | Lines                                           | Relationship     | Handoff                 |
| ---------- | ---------------------------------- | ----------------------------------------------- | ---------------- | ----------------------- |
| Slate      | 1px / 2px                          | 1.5px, drift on                                 | solid            | dashed (6 4)            |
| Whiteboard | 2.5px tape / 3.5px (any node)      | 2.6px, round caps, 3.4px when traced, drift off | solid            | dashed (10 6)           |
| Triplicate | 1px dashed (6 4) / 2px solid       | 1.5px, drift on                                 | solid, butt caps | dashed (6 4), butt caps |
| Stockroom  | 6px steel uprights / 7px           | 1.6px, drift off                                | solid            | dashed (8 5)            |

State strokes (selected, moving, drop target, pressed) stay heavier than idle strokes in every look. Whiteboard modules have no frame (`--canvas-module-frame: transparent`); Triplicate modules take a navy frame; Stockroom modules take a kraft edge.

The canvas frame (`data-skin="canvas-frame"`) draws its look on a pointer-transparent layer above the canvas: a 4px aluminium frame with a 1px highlight (Whiteboard), a 1px ink form rule (Triplicate), or 6px steel uprights on both sides (Stockroom). Slate has no frame.

The page ground (`data-skin="page"`) carries a look's surface: a white board with a 24px marker grid of 1px lines inside the same aluminium frame (Whiteboard), ruled form paper with a 1px rule every 28px (Triplicate), or a flat wall color (Stockroom). Slate keeps the plain ground.

### Named Rules

**The Dash Means Handoff Rule.** On the canvas, a dash carries meaning. In Slate a relationship line is solid and a handoff to another department is dashed (6 4). A look may restyle width, cap, color, and dash length, but a relationship stays solid and a handoff stays dashed in every look, so the dash means the same thing wherever an owner sees it. Looks target the two kinds through `data-sandbox-edge-kind`. The Key's sample lines carry the same hooks, so they always match the canvas.

Correct: `[data-theme="stockroom"] .sandbox-ui [data-sandbox-line][data-sandbox-edge-kind="handoff"] { stroke-dasharray: 8 5; }` beside a solid relationship rule.

Wrong: Triplicate draws relationships dashed and handoffs dotted (both kinds are dashed, so a dash no longer means handoff).

Wrong: `[data-theme="whiteboard"] .sandbox-ui [data-sandbox-line] { stroke-dasharray: none; }` (every handoff turns solid, and the Key no longer matches the canvas).

**The Hairline Pattern Rule.** A look may draw a flat hairline pattern with CSS gradients on the page ground and the canvas, when the pattern comes from the look's own material (a whiteboard's marker grid, a form's ruled paper). Lines are 1px, in a quiet tint of the ground, on a regular step. Photo textures, handwriting fonts, glossy gradients, and glass stay out of every look.

Correct: `[data-theme="triplicate"] [data-skin="page"] { background-image: repeating-linear-gradient(to bottom, transparent 0 27px, var(--tp-paper-rule) 27px 28px); }`

Wrong: `[data-theme="whiteboard"] [data-skin="page"] { background: url(board-photo.jpg), linear-gradient(135deg, #fff, #dfe6ec); }` (a photo texture and a glossy sheen), or `backdrop-filter: blur(12px)` on a dialog.

## Motion

Motion explains navigation and state; it never decorates. It is timed by tokens that each look sets, so a look changes how things move without changing what moves.

### Tokens

`--motion-fast` (feedback and exits), `--motion-base` (routine state and navigation), `--motion-slow` (layout and arrival signatures), with `--ease-out` (arrivals), `--ease-in` (exits), and `--ease-in-out` (even strokes). `--nav-travel-x` and `--nav-travel-y` set how far page content travels on a sidebar move.

| Look       | fast / base / slow | Page handoff                                     | Signature                                                                |
| ---------- | ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Slate      | 140 / 220 / 360ms  | 10px vertical                                    | the active sidebar item and tab mark glide                               |
| Whiteboard | 110 / 180 / 320ms  | 8px vertical                                     | on a sidebar move, the page-title marker underline draws from the left   |
| Triplicate | 120 / 200 / 340ms  | 16px vertical, like the next sheet of a form pad | on a sidebar move, the page-title rule is written in one even stroke     |
| Stockroom  | 160 / 260 / 420ms  | 24px sideways, like a drawer                     | on a sidebar move, the stencilled page title is sprayed on from the left |

### Navigation

- **Page handoff.** Links that move you through the sidebar carry a direction from one order, top to bottom: the sidebar sections, then OpenComms, then Appearance (`navigationOrder`, `currentNavigationKey`, `navigationTransitionType`). Moving down is `nav-down` and up is `nav-up`. Sidebar items, OpenComms, Appearance, and both breadcrumbs use it, so a crumb animates toward where it actually leads. A React `ViewTransition` around the page body in the app shell animates only those navigations: the old page leaves in `--motion-fast`, then the new one arrives over `--motion-base` from the direction of travel; they never overlap, so text never doubles up. Each look's signature plays as the new page arrives, only during a sidebar handoff (`:active-view-transition-type(nav-down, nav-up)`), never on first load, and never under reduced motion. The body's group does not morph (`::view-transition-group(.nav-*)` has no animation), so a handoff after a scroll never swings the page across the screen. The sidebar, top bar, and page ground stay still (`::view-transition-*(root)` does not animate), data refreshes and in-page updates do not start a view transition at all, and clicks pass through while one runs.
- **Active item.** The active section's fill is one element under the list (`data-slot="sidebar-active-indicator"`) that moves to the active link over `--motion-base` and follows groups as they open and close. It is part of the live page, not a view-transition layer, so it stays under the labels and inside the sidebar's scroll clipping, and it shows during a handoff because the new page is drawn live. It glides only when the place changes; when groups open or close around it, it moves with its label frame by frame, and a closing group clips it like it clips the label.
- **Groups and panels.** Sidebar groups open and close by height over `--motion-base`, with the chevron turning; the sidebar collapses over `--motion-base`; the phone menu sheet enters over `--motion-slow` and leaves over `--motion-base`.

### Named Rules

**The Still Shell Rule.** Navigation moves the page body, never the frame around it. The sidebar, top bar, and page ground are the fixed reference that tells a person only the content changed.

Correct: `::view-transition-old(root), ::view-transition-new(root) { animation: none; }` with the page body in its own `ViewTransition`.

Wrong: letting the browser's default root cross-fade run, so the whole window, sidebar included, dissolves on every click.

### Reduce motion setting

Appearance has a **Reduce motion** switch (per person, per browser, stored as `openslate-motion`). On, it sets `data-motion="reduced"` on `<html>` before first paint (`public/theme-init.js`), and every reduced-motion rule answers to that attribute as well as to the device's `prefers-reduced-motion`: the Tailwind `motion-reduce:` variant is redefined in `globals.css` to cover both, and each hand-written reduced rule has a `[data-motion="reduced"]` twin. Off, OpenSlate follows the device setting; when the device already asks for reduced motion, the page says so.

**The Travel Not Meaning Rule.** Reduced motion removes travel (`--nav-travel-*` become 0, glides and arrival signatures stop) but keeps the fades and color changes that say something changed.

Correct: under `prefers-reduced-motion`, the page body still cross-fades on a sidebar move.

Wrong: `animation: none` on every view transition, so a sidebar move gives no sign that the page changed.

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

### Tabs

The open-tab mark is one element, `data-slot="tabs-indicator"` (Base UI's tab indicator), that glides between tabs over `--motion-base`; the open tab itself only changes its ink and weight. Each look styles the indicator:

- **Slate:** a sunken rail (`--surface-sunken`, 4px pad); the indicator is the lifted `--surface` pill.
- **Whiteboard:** no rail (transparent, no pad, 4px gaps). Tabs have a 6px top-only corner; the indicator is a 4px inset `--action` marker stroke, and the open tab is weight 700.
- **Triplicate:** form sections. The list has no fill and a 1px `--ink` rule under it; tabs are square; the indicator is a 3px `--ink` rule, and the open tab is weight 700.
- **Stockroom:** a steel rail (`--sr-steel-lite`, 2px corner, 2px `--sr-steel` inset at the bottom). The indicator is a surface tab with a 3px `--action` edge on a 1px steel lip, and the open tab is weight 700.

### Notices (Alert)

A tinted band per signal: warning, destructive, and success use the signal's `-tint` fill and `-rule` border with `--ink` text; default uses the card surface. 16px padding, 14px text, `role="status"`. Whiteboard draws a 2px border with a 6px corner. Triplicate draws a square 3px double border, like a stamped box. Stockroom keeps a 1px border with a 2px corner and adds a 3px inset band in the text color along the top.

### Tables

Hairline rows with 14px cells. Cells stay `--ink` in every look, so stored data never reads as a link. Whiteboard puts a 2px `--wb-tape` rule under bold heads. Triplicate makes a ruled ledger: a 1.5px `--ink` rule under the heads and a line number on each record row: a CSS counter in a `::before` with empty alternative text (`content: counter(tp-line) / ""`), placed in the first cell's left padding, with the same padding on the first head cell. Rows with a spanning cell (empty states, expanded details) and rows led by a checkbox get no number. Stockroom sets the heads on a steel band (`--sr-steel-lite`) with a 2px `--sr-steel` rule.

### Dialogs, sheets, and menus

Card surface (popover surface for menus), a `--border` edge, and a large shadow; dialogs and menus take the large radius. Whiteboard frames dialogs and sheets in 3px aluminium (`--wb-frame`) with a 1px highlight and the raised lift. Triplicate makes them carbon slips: an `--ink` edge, a 2px dashed `--ink` top (the perforation), and square corners; its dropdown menus take a square 1px `--ink` edge. Stockroom gives dialogs and sheets a 5px inset steel band on top and the raised lift.

### Navigation

The sidebar holds workspaces and their sections. Each closed workspace row shows a one-line description of its job under its name in `text-xs` sidebar-muted ink ("Who can see and change what"); an open row shows its sections instead, and the collapsed rail shows the description in the tooltip. The name alone stays the row's accessible name. Items are at least 44px tall with 1.65-weight line icons. The active section uses `--action-text` at weight 600 on the gliding `--sidebar-accent` fill; the active workspace row keeps its own fill. The scrollbar is 6px, thin, in muted ink. The breadcrumbs read Workspace › workspace › section.

The top bar (`data-skin="topbar"`) and sidebar carry the look's frame. Whiteboard puts a 1px frame rule under the top bar. Triplicate prints the top bar as a form header with a double `--ink` rule and rules the sidebar edge in `--ink`. Stockroom paints the sidebar steel through the `--sidebar` token (so the pinned OpenComms block matches) with a 1px `--sr-steel` edge on `sidebar-container`, and sets the top bar on a 3px `--sr-steel` rail.

### Sample data note

`SampleDataNote` is the one label for sample data: an outline "Example" chip, then the screen's own sentence, then "Changes last until you close this tab." Every screen that runs on the local sample runtime shows it.

### Publish status

The Sandbox header names the real state of the draft: "Nothing to publish yet", "Draft saved", "Unpublished changes", "Unsaved changes", or "Published". Review & Publish is available only when publishing would change something; it is disabled for "Nothing to publish yet", "Published", and "Unsaved changes". The review groups changes by kind (departments, modules, fields, relationships, automations), with a New, Changed, Closed, or Reopened chip on each row, field changes nested under their module, and a "Show all" control on groups longer than five rows.

### Organization look picker

A radio group of four tiles (two columns from 640px, four from 1280px). Each tile shows a small canvas swatch drawn with that look's own tokens (`data-theme-preview`): a department head with its identity mark, and a table card with a header and two field rows. The checked tile takes an `--action` border and ring. The note under the tiles says the look is saved in this browser only.

### Sandbox canvas (signature)

An ERD-style canvas of the owner's own structure. Departments are named frames on their own sheet (`--dept-n-sheet`) with a head band (`--dept-n-band`) and an identity mark. Modules are compact 232px table cards on `--dept-n-module`: a 34px header (`--dept-n-card`) with the identity mark and the table name, then 26px field rows with the name on the left in `--canvas-field-ink` and a quiet type label on the right in `--canvas-type-ink`, on `--dept-n-stripe` for alternate rows. A filled dot marks a required field; a hollow dot marks an optional one. Lines join tables at 1.5px in `--canvas-edge`, with a label chip (`--canvas-label-*`) at the middle of the line, or at the first stop along it (35%, 65%, 20%, 80%) that no other line crosses and no table covers. Dashed lines drift slowly (2.4s per cycle) in Slate and Triplicate; Whiteboard and Stockroom turn the drift off. The Key (closed by default, opens upward) names relationship, handoff, required field, and optional field, and says in one line what a module and a line are. The minimap hides text and lines and shows frames and tables. Under reduced motion, the drift and the trace fade stop.

## Do's and Don'ts

### Do:

- **Do** use semantic tokens (`bg-card`, `text-muted-foreground`, `var(--canvas-edge)`) and never a raw color or a Tailwind palette color in a component.
- **Do** add a new token to Slate light, Slate dark, and every look's light and dark blocks in the same change, and add any new text pair to the contrast guard.
- **Do** restyle a look only through tokens and the named skin places, and keep `theme-parity.spec.ts` passing.
- **Do** keep each signal to its one meaning: action acts, flow shows movement and success, warn asks for attention, danger destroys.
- **Do** put a department's identity color beside its name every time it appears.
- **Do** time every transition with the motion tokens and give it a `prefers-reduced-motion` path that keeps meaning (fades, color) and drops travel.
- **Do** show `SampleDataNote` on every screen that runs on sample data, and name the real publish state in the Sandbox header.

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
