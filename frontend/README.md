# OpenSlate Frontend

Sandbox, Boards, Access, OpenView, Manage, Platform, and OpenComms use authorized FastAPI adapters for their implemented data and actions. FastAPI owns application authorization and durable state; browser drafts and cached reads do not replace those decisions. OpenComms also receives private Supabase Realtime notifications, which carry ids and transient typing/presence signals only; message content loads through HTTP. Sign-in, session validation/refresh, logout, and invitation/recovery actions use the same-origin API.

`AppPage` mounts the verified-account identity and query/theme providers once for authenticated routes. `src/app/(app)/(workspace)/comms/layout.tsx` mounts the Comms client provider, which creates one live runtime for the verified account and organization. Comms drafts live in tab session storage, keyed by account, organization and composer. Shared session cleanup disposes the runtime and removes owned Comms drafts; leaving the route removes drafts only after a real organization change.

FastAPI must be running for identity actions. Invitation onboarding uses the protected FastAPI setup flow. Feature adapters use the shared same-origin `apiFetch()` contract, including cookie mutation CSRF and session refresh behavior. Production serves the static Next export through FastAPI. For daily frontend development, run `npm run dev` in this directory and open `http://localhost:<FRONTEND_DEV_PORT>`. Next forwards same-origin `/api/*` requests to loopback FastAPI on `BACKEND_PORT`; the launcher parses `FRONTEND_DEV_PORT`, `BACKEND_BIND_HOST`, `BACKEND_PORT`, and `PUBLIC_ORIGIN` from the process or root configuration, then passes only the three direct nonsecret values and the derived exact HMR-origin hostname to Next. The configured `PUBLIC_ORIGIN` hostname becomes that HMR allowlist entry; root environment validation and the launcher limit it to a permitted local or LAN browser address. An IPv6 `BACKEND_BIND_HOST=::1` uses `localhost` with IPv6-first resolution because Next cannot compile a literal IPv6 rewrite host. Developers may pass Next host or port overrides with `npm run dev -- --hostname <host> --port <port>` and use frontend-local `.env*` files during development. Production builds reject frontend-local environment files.

Frontend-specific commands and architecture are documented in the repository root [`README.md`](../README.md).

## Tests and verification

Playwright Test is the only frontend runner. `tests/isolated/` owns rules, adapters
and state machines (plus an owned development-ingress fixture);
`tests/http/` owns browser journeys with a mocked `/api`. Default HTTP tests use
the static export in `out/` through the test-only ASGI entry over production
`StaticSite` in [`backend/tests/static_export_server.py`](../backend/tests/static_export_server.py).
They need the locked backend Python dependencies to serve those assets, not a
running application API or Supabase stack. Unmocked `/api` requests return 500.
Build first: [`playwright.config.ts`](playwright.config.ts) refuses missing or stale
exports. `PLAYWRIGHT_HTTP_SERVER=dev` opts the same HTTP project into `next dev`
for a local debugging loop; it is not a separate project. Daily `npm run dev`
continues to proxy to the real local FastAPI process as described above.

Run these declared scripts from `frontend/`:

- `npm run check`: formatting, ESLint, strict types and theme contrast.
- `npm run build`: production static export; prerequisite for default HTTP tests.
- `npm test -- --project=isolated`: isolated project; no export prerequisite.
- `npm test -- --project=http <spec> -g "<title>"`: focused mocked HTTP browser case.
- `npm run test:section -- <section> --layer=http` and `npm run test:affected -- --base <base-ref> --layer=http`: existing scoped selectors in `scripts/run_tests.py`; both also accept `--layer=isolated`.
- `npm test`: all retained isolated and HTTP tests (the gate's native collection).
- `npm run test:full`: existing full selector over mapped sections, not a replacement for the gate's native collection.
- `npm run verify`: `check` → `build` → `test`; full frontend gate/repair, not the loop after every edit.
- `npm run sweep -- --credentials <absolute-path>`: on demand against the running dev stack, signs in, visits every sidebar route and tab, and fails on runtime errors; it saves nothing and is not part of the gate.

The lockfile pins Playwright and Chromium. Local tests use up to three workers;
CI runs a separate isolated job at its default one worker and six whole-file,
duration-balanced HTTP shards with two workers each. The HTTP shards share one
downloaded export. UTC, `en-US` and zero retries are configured. Use focused cases during
repair and one relevant batch once stable. Only right before a push, run the root
`python3 scripts/prepush.py --base <base-ref> --serial`: never overlap backend and
frontend heavy lanes or start another heavy check beside one. See
[Testing Architecture](../docs/architecture/16-testing-architecture.md) for
coverage, dedicated provider-reset acceptance and separate real-stack/release
boundaries. These commands describe the configured workflow, not current-tip
parity or hosted/deployment acceptance.

Workspace pages use `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`. `/profile` owns the signed-in person's identity, security and personal preferences. No route mounts a browser-local sample runtime.

The active workspace implementation lives in `src/components/systems/`.
The sidebar owns top-level section navigation for Sandbox, Boards, Access,
OpenView, Manage, and Platform; OpenComms remains a direct page link at the
bottom of the navigation area, above the footer divider. The
group labels expand or collapse their child links without navigating; choose a
child link to open a section. The selected section is encoded in each page's
existing `view` or `section` query parameter, including `section` on Sandbox and
Platform. Existing Platform account/notification hash links remain supported. The department File library uses `/platform?section=files&department=<uuid>` and the server-backed `library-files-api.ts`; it is distinct from record attachments.

Live features share authenticated SSE invalidations through `subscribeWorkspaceInvalidations` in the shared adapter; events ask for authorized refetches and contain no row snapshots. The shell holds one notification listener across signed-in routes, alongside OpenView Views/Dashboards/Charts/Reports and saved-chart editors, Boards, Manage audit/jobs/maintenance and branding, Platform Files, and open Help contacts. When the stream is unavailable, an explicit focus fallback refreshes only the unread count; global focus/reconnect reads remain disabled.

The bell uses the authoritative unread count and opens the latest ten notices. View all opens the cached, server-paged All/Unread inbox. Mark-one and read-all share a pending-command guard and explicitly refetch count/pages after confirmation. Displayed titles come from bounded authorized source reads, with safe retry or unavailable states; notification references retain no private content. Links open exact Board posts/events or `/openview?section=reports&report=<uuid>&run=<uuid>`, which reads the report and opens its module page's Reports view with that report and copy (`tab=reports&report=<uuid>&copy=<uuid>`). A run requires its Report. A missing or denied report opens the first readable module's Reports view with "This report is not available." and never a default output.

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
