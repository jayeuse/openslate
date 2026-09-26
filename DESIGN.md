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
- Motion is small and functional: color and opacity only, and none under reduced motion.

### The four looks

| Look            | Selector and file                 | Type (`--font-ui` / `--font-code`)      | Radius (`--radius`) | Material                                                                                                                                                                  |
| --------------- | --------------------------------- | --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slate (default) | `:root`, `.dark` in `globals.css` | Geist / Geist Mono                      | 8px                 | Calm neutral surfaces, precise hairlines, flat cards with a rule edge.                                                                                                    |
| Whiteboard      | `themes/whiteboard.css`           | Atkinson Hyperlegible Next / Geist Mono | 6px                 | Marker ink on a white board, an aluminium frame around the canvas, bold solid marker lines, taped department frames, pastel department bands. Dark is a slate chalkboard. |
| Triplicate      | `themes/triplicate.css`           | Archivo (width axis) / Geist Mono       | 2px                 | Navy form ink on off-white paper, square corners, condensed labels, rubber-stamp chips, dashed department frames, paper-tinted department copies. Dark is carbon paper.   |
| Stockroom       | `themes/stockroom.css`            | Archivo (width axis) / Martian Mono     | 2px                 | Steel rails and kraft boxes: condensed uppercase page titles, steel uprights on the canvas frame, kraft module cards, a steel shelf beam on each department.              |

The choice is saved in the browser under `openslate-org-theme` (`public/theme-init.js` applies it before paint; `lib/appearance-preferences.ts` owns it). The light and dark choice is saved under `openslate-theme`. The organization look moves to a workspace setting when the backend has one.

### Named Rules

**The Look-Only Rule.** A look changes color, type, materials, shapes, and motion. It never adds, removes, or reorders DOM, and it never changes a word. `frontend/tests/http/theme-parity.spec.ts` compares the element count and `textContent` across the four looks.

Correct: `[data-theme="triplicate"] [data-slot="badge"] { border: 1px solid currentColor; }`

Wrong: `{theme === "triplicate" && <span>Stamped</span>}` (theme-only markup, and a new word).

**The Skin Place Rule.** A look restyles only through tokens and the named hooks. The hooks are `data-slot` on Card, CardTitle, Badge (with `data-variant`), TabsList, TabsTrigger, Alert (with `data-variant`), FieldLabel, table head, and page title (`data-slot="page-title"`); `data-skin="canvas-frame"`; and on the canvas `data-sandbox-kind`, `data-sandbox-part`, `data-sandbox-line`, and `data-sandbox-edge-kind`. A new skin place is a shared hook that every look can use, added to the component once.

Correct: `[data-theme="stockroom"] [data-skin="canvas-frame"]::after { box-shadow: inset 6px 0 0 var(--sr-steel), inset -6px 0 0 var(--sr-steel); }`

Wrong: `<Card className={theme === "whiteboard" ? "shadow-lg border-0" : ""}>` (a class switched per look).

**The Full Dark Rule.** Every token that a look's light block sets, its dark block sets too. The light block outranks Slate's `.dark` block, so a missing dark value leaks the light value into dark mode. The contrast guard fails on a missing token.

Correct: `--wb-frame` is set in both `:root[data-theme="whiteboard"]` and `.dark[data-theme="whiteboard"]`.

Wrong: a look sets `--canvas-module-fill` in light only, and dark mode shows a white card on a dark canvas.

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
- **Rules** (`--rule`, `--rule-strong`): hairline borders and dividers. The Sandbox raises its borders to `--rule-strong` (`.sandbox-ui`).
- **Control edge** (`--control-edge`): input and control borders, 3:1 against surface and ground.

### Canvas skin

The canvas has its own layer so a look can restyle the Sandbox without new markup: `--canvas-background`, `--canvas-grid`, `--canvas-grid-major`; departments (`--canvas-dept-fill`, `--canvas-dept-frame`, `--canvas-dept-ink`); module cards (`--canvas-module-fill`, `--canvas-module-frame`, `--canvas-module-ink`); field rows (`--canvas-row-rule`, `--canvas-row-stripe`, `--canvas-type-ink`); lines (`--canvas-edge`); and line labels (`--canvas-label-fill`, `--canvas-label-frame`, `--canvas-label-ink`). In Slate these are aliases of the neutrals. Whiteboard, Triplicate, and Stockroom give them their own materials.

### Department identity

Four identity colors per look (`--dept-1` to `--dept-4`), cycled in department order. `--dept-n` colors the small identity mark beside the department name and on each module header. `--dept-n-band` fills the department head and `--dept-n-card` fills the module header. Each look sets how loud these are: Slate keeps the band neutral and the card sunken; Whiteboard uses pastel bands; Triplicate uses paper-tinted copies; Stockroom uses one steel band and one kraft card for every department.

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

**The AA Everywhere Rule.** Every text pair is at least 4.5:1, and focus rings and control borders are at least 3:1, in all eight look modes. The canvas pairs (module ink, type ink, line label ink, and department ink on each band and card) are in the guard.

Correct: adding a canvas text token also adds its pair to `PAIRS` in `check-theme-contrast.mjs`.

Wrong: a new chip tint that is checked only in Slate light.

## Typography

**UI Font:** `--font-ui`, which each look sets. Slate uses Geist; Whiteboard uses Atkinson Hyperlegible Next; Triplicate and Stockroom use Archivo with its width axis.
**Code Font:** `--font-code`. Geist Mono in Slate, Whiteboard, and Triplicate; Martian Mono in Stockroom.

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

- Whiteboard: page titles, card titles, chips, and table heads at weight 700.
- Triplicate: page and card titles at 92% width and weight 700; field labels, table heads, and chips at 85% width with 0.03em tracking.
- Stockroom: page titles uppercase at 70% width, weight 800, 0.02em tracking; card titles at 85% width; field labels, table heads, and chips at 80% width, weight 700, 0.04em tracking.

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

**The Sandbox.** The canvas owns at least 65% of the work area. One right workbench switches between Structure and Properties; creation actions live in the workbench, not on the canvas. Narrow screens switch among Canvas, Structure, and Properties as tabs. The canvas snaps to a 24px unit and shows a dot grid (minor dots every 24px, major dots every 120px, each dot on a snap point). It scales uniformly from 50% to 150%. It opens at 100% on the busiest department (the most modules and lines), so table and field names are readable; if the department is wider than the view, it shows the department's first table whole. Fit shows the whole design and never zooms past 100%. The minimap sits bottom right and the Key bottom left, both from 640px up.

## Elevation & Depth

The system is a hybrid: tonal layering first, and a lift that each look sets. Four tokens carry depth: `--lift` (resting), `--lift-raised` (popovers and raised cards), `--lift-filter` (the SVG `drop-shadow` form of the raised lift, for canvas nodes), and `--card-lift` (a card's own material). Dark modes deepen the same shadows with black instead of tinted ink.

### Shadow Vocabulary

- **Slate:** a soft ambient lift. Cards are flat (`--card-lift` is none) and take a `--rule` edge. Popovers take a two-layer soft shadow.
- **Whiteboard:** a 1px zero-blur ledge under a soft 6px shadow, like a board sitting on its tray. Cards have no edge (`--card-edge: transparent`) and use the raised lift.
- **Triplicate:** a thin paper shadow. Cards take a `--rule-strong` edge and the resting lift, like a form on a desk.
- **Stockroom:** a 2px zero-blur shelf edge under a soft shadow. Cards take a `--rule-strong` edge and the resting lift.

Exact shadow values live in each look's stylesheet and in `.impeccable/design.json`.

### Named Rules

**The Card Material Rule.** A look sets a card's material through `--card-edge` and `--card-lift`, never by overriding Card. A card's own border or ring class then still wins.

Correct: `--card-edge: transparent; --card-lift: var(--lift-raised);` in the Whiteboard block.

Wrong: `[data-theme="whiteboard"] [data-slot="card"] { border: 0; box-shadow: ...; }`

**The Ledge Not Block Rule.** A zero-blur lift layer is a vertical ledge of at most 2px, at low opacity, under a soft shadow. It never offsets sideways and never becomes a solid block shadow.

Correct: `--lift: 0 2px 0 rgb(28 30 33 / 0.14);` (Stockroom).

Wrong: `--lift: 4px 4px 0 var(--ink);`

**The Selection Lifts Rule.** On the canvas, only the selected department or module lifts (`--lift-filter`). Hovering a module or a line traces its connections: the rest dims to 35% opacity in 150ms, the traced lines turn `--action` at 2px, and nothing moves.

Correct: `.sandbox-ui .x6-cell[data-trace="dim"] { opacity: 0.35; }`

Wrong: hover scales the table up or slides the connected tables toward it.

## Shapes

Corners come from one token, `--radius`: 8px in Slate, 6px in Whiteboard, 2px in Triplicate and Stockroom. Tailwind derives the steps: large is `--radius`, medium is 2px less, small is 4px less (and resolves to square in the 2px looks). Buttons, inputs, cards, tab rails, and notices use large; chips use medium; the active tab uses small.

Canvas nodes draw an 8px corner in SVG. Triplicate squares departments, cards, and headers (`rx: 0`); Stockroom sets 2px. Borders are hairlines (1px), and the Sandbox uses the stronger rule. On the canvas, a look may thicken strokes for its material: Whiteboard tapes department frames at 2.5px and draws marker lines at 2.4px; Stockroom draws 4px shelf uprights; Triplicate dashes department frames (6 4). State strokes (selected, moving, drop target, pressed) stay heavier than idle strokes in every look.

The canvas frame (`data-skin="canvas-frame"`) draws its look on a pointer-transparent layer above the canvas: an aluminium frame (Whiteboard), a 1px form rule (Triplicate), or steel uprights on both sides (Stockroom). Slate has no frame.

### Named Rules

**The Dash Means Handoff Rule.** On the canvas, a dash carries meaning. In Slate a relationship line is solid and a handoff to another department is dashed (6 4). A look may restyle width, cap, color, and dash, but it keeps the two kinds visibly different and targets them through `data-sandbox-edge-kind`; Triplicate, for example, draws relationships as dashed carbon lines and handoffs as dotted ones. The Key's sample lines carry the same hooks, so they always match the canvas.

Correct: `[data-theme="triplicate"] .sandbox-ui [data-sandbox-line][data-sandbox-edge-kind="handoff"] { stroke-dasharray: 1.5 3.5; }` beside a dashed (5 4) relationship rule.

Wrong: `[data-theme="whiteboard"] .sandbox-ui [data-sandbox-line] { stroke-dasharray: none; }` (every handoff turns solid, and the Key no longer matches the canvas).

## Components

### Buttons

Quiet and direct. A button is text first, with a 16px icon when it helps.

- **Shape:** gently curved corners (large radius).
- **Primary:** `--action` fill, `--action-ink` text, 14px weight 500, 36px tall with 16px sides. Small is 32px with 12px sides and 12px text; large is 44px.
- **Hover / Focus:** the primary and destructive fills drop to 90% opacity; secondary fades to 80%; outline and ghost take the sunken fill. Focus is a 2px `--focus` outline with a 2px offset in every look. In the Sandbox, a press adds a 10% action wash and a 1px inner outline, and color changes take 120ms.
- **Secondary / Outline / Ghost / Destructive:** secondary on the sunken fill; outline on surface with a rule border; ghost with no fill; destructive on `--danger`. Disabled is 50% opacity with no pointer events.

### Chips (Badge)

- **Style:** 12px weight 500, 2px by 8px, medium radius. Variants: default (hover fill), secondary, success (flow), warning (warn), destructive (danger), and outline (rule border, muted ink).
- **Looks:** Triplicate turns every chip into a rubber stamp (transparent fill, 1px `currentColor` border, square). Stockroom and Triplicate condense chip lettering; Whiteboard sets it bold.

### Cards / Containers

- **Corner Style:** large radius.
- **Background:** `--surface` with `--ink`.
- **Shadow Strategy:** `--card-lift`, per The Card Material Rule.
- **Border:** `--card-edge` (rule in Slate, none in Whiteboard, strong rule in Triplicate and Stockroom). Card header and footer divide with `--border`.
- **Internal Padding:** 20px.

### Inputs / Fields

- **Style:** `--surface` fill, `--control-edge` border, large radius, 40px tall, 12px sides, 14px text. The caret is `--action`; placeholders are muted ink at 80%.
- **Focus:** the border turns `--action` and a 2px `--focus` outline sits 1px outside.
- **Labels:** FieldLabel is 14px weight 500 (`data-slot="field-label"`).

### Tabs

A sunken rail (`--surface-sunken`, 4px pad) with the active tab lifted onto `--surface`. Whiteboard and Stockroom add a 3px `--action` underline to the active tab; Triplicate adds a 3px `--ink` underline.

### Notices (Alert)

A tinted band per signal: warning, destructive, and success use the signal's `-tint` fill and `-rule` border with `--ink` text; default uses the card surface. 16px padding, 14px text, `role="status"`.

### Navigation

The sidebar holds workspaces and their sections. Items are at least 44px tall with 1.65-weight line icons. The active item uses `--action-text` at weight 600 and no fill. The scrollbar is 6px, thin, in muted ink. The breadcrumbs read Workspace › workspace › section.

### Sample data note

`SampleDataNote` is the one label for sample data: an outline "Example" chip, then the screen's own sentence, then "Changes last until you close this tab." Every screen that runs on the local sample runtime shows it.

### Publish status

The Sandbox header names the real state of the draft: "Nothing to publish yet", "Draft saved", "Unpublished changes", "Unsaved changes", or "Published". Review & Publish is available only when publishing would change something; it is disabled for "Nothing to publish yet", "Published", and "Unsaved changes". The review groups changes by kind (departments, modules, fields, relationships, automations), with a New, Changed, Closed, or Reopened chip on each row, field changes nested under their module, and a "Show all" control on groups longer than five rows.

### Organization look picker

A radio group of four tiles (two columns from 640px, four from 1280px). Each tile shows a small canvas swatch drawn with that look's own tokens (`data-theme-preview`): a department head with its identity mark, and a table card with a header and two field rows. The checked tile takes an `--action` border and ring. The note under the tiles says the look is saved in this browser only.

### Sandbox canvas (signature)

An ERD-style canvas of the owner's own structure. Departments are named frames with a head band (`--dept-n-band`) and an identity mark. Modules are compact 232px table cards: a 34px header with the identity mark and the table name, then 26px field rows with the name on the left and a quiet type label on the right, striped on alternate rows. A filled dot marks a required field; a hollow dot marks an optional one. Lines join tables at 1.5px in `--canvas-edge`, with a centered label chip (`--canvas-label-*`). Dashed lines drift slowly (2.4s per cycle) in Slate and Triplicate; Whiteboard and Stockroom turn the drift off. The Key (closed by default, opens upward) names relationship, handoff, required field, and optional field. The minimap hides text and lines and shows frames and tables. Under reduced motion, the drift and the trace fade stop.

## Do's and Don'ts

### Do:

- **Do** use semantic tokens (`bg-card`, `text-muted-foreground`, `var(--canvas-edge)`) and never a raw color or a Tailwind palette color in a component.
- **Do** add a new token to Slate light, Slate dark, and every look's light and dark blocks in the same change, and add any new text pair to the contrast guard.
- **Do** restyle a look only through tokens and the named skin places, and keep `theme-parity.spec.ts` passing.
- **Do** keep each signal to its one meaning: action acts, flow shows movement and success, warn asks for attention, danger destroys.
- **Do** put a department's identity color beside its name every time it appears.
- **Do** keep canvas motion to color and opacity, and turn it off under `prefers-reduced-motion`.
- **Do** show `SampleDataNote` on every screen that runs on sample data, and name the real publish state in the Sandbox header.

### Don't:

- **Don't** add, remove, or reword DOM for one look. Correct: a CSS rule on `[data-slot="badge"]`. Wrong: a Triplicate-only "Stamped" label.
- **Don't** transform case anywhere except page titles; labels, chips, table heads, and card titles can show names people typed.
- **Don't** let a look erase the difference between a relationship line and a handoff line; the Key must match the canvas.
- **Don't** override Card, Badge, or the canvas cells with a per-look class; set `--card-edge`, `--card-lift`, and the canvas skin tokens instead.
- **Don't** use a sideways or solid block shadow; a zero-blur lift is a vertical ledge of at most 2px.
- **Don't** use warn and danger hues closer than 30°, or an action color that reads like body ink.
- **Don't** copy token values into other documents; point to `globals.css`, `themes/*.css`, and this file.
