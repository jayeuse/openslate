# OpenSlate Frontend

The workspace is currently UI-first: business data, roles, permissions, branding, and interaction state are local sample state. Workspace screens do not fetch business APIs or subscribe to realtime updates. Existing-account sign-in, session validation/refresh, and logout remain connected to Supabase Auth.

Browser-held workspace snapshots and Comms drafts are scoped to the verified
account in each tab. Older snapshots without an account owner remain stored but
are not loaded automatically.

FastAPI does not need to be running for existing-account login and workspace UI work. Existing configuration still supplies a backend URL, and invitation onboarding retains its protected backend acceptance flow. The backend and BFF implementations remain available for later integration; current workspace controls do not call them.

Frontend-specific commands and architecture are documented in the repository root [`README.md`](../README.md).

Workspace pages use `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`. The URL prefix is independent of the local placeholder data.

The active workspace implementation lives in `src/components/systems/`.
The sidebar owns top-level section navigation for Sandbox, Boards, Access,
OpenView, Manage, and Platform; OpenComms remains a direct page link at the
bottom of the navigation area, above the footer divider. The
group labels expand or collapse their child links without navigating; choose a
child link to open a section. The selected section is encoded in each page's
existing `view` or `section` query parameter, including `section` on Sandbox and
Platform. Existing Platform hash and file links remain supported.

## Shared interface contract

The frontend uses the local shadcn-style components in `src/components/ui/`,
Base UI primitives for focus-managed interactions, and semantic CSS variables
from `src/app/globals.css`. Feature screens own their data, filtering rules,
and state transitions; shared components own the common interaction shape and
visual treatment.

### Tokens and dimensions

- Use semantic tokens such as `bg-background`, `bg-card`, `text-foreground`,
  `text-muted-foreground`, `border-border`, `ring-ring`, `bg-primary`, and
  `bg-destructive`. Every surface must remain readable in both `:root` and
  `.dark`.
- The default radius is `--radius` (`0.65rem`); use the derived
  `--radius-sm`, `--radius-md`, and `--radius-lg` tokens instead of inventing
  per-screen radii. The appearance settings can change this token at runtime.
- Comfortable density uses `--density-space: 1rem` and
  `--density-control-height: 2.5rem`; compact density uses `0.75rem` and
  `2.25rem`. Touch-oriented actions and shared search controls use a minimum
  height of `2.75rem` (44px) even when surrounding content is denser.
- Buttons use the shared variants: default `h-9`, small `h-8`, large `h-11`,
  and icon `size-9`. Text inputs and combobox controls are `h-10` by default;
  use the 44px minimum for touch-heavy or full-width controls.

### Type, spacing, and page structure

- The application uses Geist Sans and Geist Mono through the global font
  tokens. Body copy and labels use the existing `text-sm` scale; supporting
  metadata uses `text-xs`.
- Use `PageHeader` for standard authenticated page headings. Feature-specific
  headers follow its `text-2xl` to 30px type scale, `text-sm leading-6`
  description, and responsive action layout. Keep the heading as the page's
  primary landmark (`h1`).
- Use the existing spacing rhythm: field groups use `gap-2`, page headers use
  `mb-7` and `gap-4`, and card content uses the existing `gap-5` composition.
  Prefer responsive `gap-*`, `flex-wrap`, and `min-w-0` over fixed widths.

### Forms and search

- Every form control has a visible `FieldLabel` or an equivalent accessible
  name. Keep validation and pending state with the feature that owns the form.
- Use `SearchField` for a labeled, controlled text search. It supplies the
  search icon, 44px control height, semantic input surface, visible focus, and
  light/dark treatment; the caller supplies `value`, `onValueChange`, the
  placeholder, and the search predicate.
- Use `SearchSelect` for a controlled searchable option list. It composes the
  existing Base UI combobox with the shared field label, 44px trigger and
  search input, option descriptions, keyboard navigation, and an empty state.
  The caller owns option values and domain rules.
- Do not add search to a native select solely for visual symmetry. Use the
  searchable pattern when the option set or existing workflow benefits from
  filtering.

### Tables, dialogs, and states

- Render data tables with the shared table primitives so header, cell, border,
  and small-screen behavior remain consistent. Table headers use the existing
  40px row treatment and `text-sm`; feature-owned columns, sorting, selection,
  and filtering stay outside the primitive. Directories with real pagination
  use `PaginationControls` with one-based labels. Pass a complete collection to
  `DataTable` with controlled zero-based pagination, or pass an already prepared
  page without local pagination so it is not sliced twice. Filter and sort before
  paging; aggregate and export from complete results. Feature screens keep their
  mobile row presentation.
- Use `Dialog` for focused tasks and `AlertDialog` for decisions that must
  interrupt. Use `Sheet` for responsive side or bottom tasks. Let Base UI
  manage focus, Escape, dismissal, and restoration.
- Provide loading, empty, error, disabled, and success states with the shared
  `Skeleton`, `Empty`, `Alert`, `Badge`, and semantic state tokens where they
  apply. Status cannot rely on color alone; pair it with text or an icon.

### Focus, responsive behavior, and themes

- Global focus uses a 2px `ring`/outline with a 2px offset. Preserve the
  primitive's focus behavior and keep every action keyboard reachable.
- Build mobile-first. Controls that users tap are at least 44px high, action
  groups wrap, long values truncate safely, and wide tables provide an
  understandable responsive presentation rather than forcing page overflow.
- Light and dark values are defined by the semantic tokens in `globals.css`.
  Components should consume those tokens rather than add raw colors or
  one-off `dark:` overrides. The Sandbox canvas may keep its local visual
  treatment, while ordinary controls follow this contract.
