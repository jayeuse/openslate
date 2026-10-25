<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Frontend Engineering Rules

## Maintainability and file size

- Use approximately 500 lines as a review signal for logic-heavy modules, not a hard limit or CI failure. TSX presentation, cohesive forms and tables may remain longer.
- Extract a module only when it separates a real responsibility: domain rules, transport, lifecycle coordination, or a focused editor/view. Do not replace a large component with a large hook or context containing the entire feature.
- Keep one owner for each draft, selection, pending operation, subscription, and transaction. Preserve component keys, provider placement, mount behavior, effect cleanup, and existing contracts during extraction.
- Organize tests by observable behavior and fixtures/templates/CSS by ownership and purpose; do not split them solely for length. Generated files, dependencies, build output, and lockfiles are outside this guidance.
- Measure refactoring success through clearer dependencies and verified behavior, not line-count reductions. Do not remove functionality, compress formatting, or add forwarding layers merely to shorten files.

## Core React rules

- Keep TypeScript strict: no `any`; accept external data as `unknown` and narrow/validate at the boundary.
- Define explicit prop types for every component. Prefer discriminated unions for mutually exclusive UI states instead of several optional boolean flags.
- Keep components focused; separate fetching, stateful behavior, formatting, and complex presentation as responsibilities accumulate.
- Prefer composition and `children` over passing props through components that do not use them. Extract repeated stateful behavior into custom hooks.
- Follow the Rules of Hooks and keep effect dependencies accurate. Do not use effects to derive renderable state; derive it during render instead.
- Keep state local and minimal. Do not duplicate values that can be derived from props or existing state, and do not add a state library without a demonstrated cross-cutting need.
- Keep Server Components as the default. Add `"use client"` only for browser APIs, event handlers, or client-side state, and keep client boundaries as small as practical.
- Keep React Strict Mode enabled to expose unsafe side effects and lifecycle assumptions.
- Use `useMemo`, `useCallback`, and `memo` only when profiling or an established component contract justifies them, never by default.
- Use stable domain identifiers for dynamic list keys, never array indexes. Lazy-load or virtualize only when bundle or rendering measurements show a need.
- Keep side effects out of render. Handle async failures explicitly and provide loading, empty, error, and recovery states for data-dependent UI.
- Use App Router error boundaries (`error.tsx`) for render failures and keep user-facing error messages generic; do not expose secrets, tokens, stack traces, or internal response details.
- Prefer semantic HTML and native controls before ARIA. Preserve keyboard access, visible focus, sufficient color contrast, reduced-motion support, and deliberate focus management for dialogs or route transitions.

## Data access and auth

- Sandbox, Boards, Access, OpenView, Manage, Platform, and OpenComms use authorized FastAPI adapters for their implemented data and actions, as described in `frontend/README.md`. Preserve those server contracts and their loading, denial, conflict, and draft states. No production route runs on browser-local sample data: the in-memory Comms engine is a test-only fake under `tests/support/comms-memory/`, and the remaining `systems/shared/runtime/sample-*` modules are imported only by tests. Do not import either into `src/` routes.
- Authenticated pages live under `src/app/(app)/`, whose layout mounts `AppPage` (auth gate + shell) once for the group; do not wrap pages individually or implement a second cookie/auth gate. `AppPage` owns the per-account identity and query/theme providers. `(workspace)/comms/layout.tsx` mounts `CommsClientProvider` (`systems/comms/state/client-context.tsx`), which owns the one live Comms runtime for the verified account and organization. Shared session cleanup disposes that runtime and clears owned Comms drafts; unmounting the layout clears drafts only after a real organization change.
- When a feature uses authorized backend integration, domain requests go through `apiFetch()` to the same-origin `/api` gateway. It sends the CSRF header for cookie-authenticated mutations and performs the documented FastAPI refresh flow. Never bypass the same-origin API boundary from pages.
- Organization context: one installation holds several organizations. `src/lib/organization-context.ts` keeps the tab's organization in session storage; `apiFetch()` sends it as `X-Org`, and without it the server uses the session's active organization. SSE opens `/api/events?org=<id>`. Per-account caches key on user and organization; a switch must show no stale data from the previous organization. Roles come from the current membership, not the account. Signed-out pages read the look of the browser's last organization (`/api/workspace/appearance?org=`).
- Sessions use HttpOnly `openslate_access`/`openslate_refresh` cookies issued by FastAPI; the browser never sees tokens. Next has no proxy file, route handler, server action, request-header, or request-cookie boundary. Its development-only rewrite forwards same-origin `/api/*` to loopback FastAPI.
- Feature adapters own typed reads and confirmed commands through schema-required `apiFetch`. Keep ephemeral drafts local and await acceptance before clearing or navigating. Preserve loading/retry, last-good refresh data, cancellation, and pending guards. OpenComms composes its HTTP adapters, TanStack Query scope with read-refusal latch, Realtime cache bridge and send outbox in `systems/comms/adapters/live-runtime.ts`; add Comms reads and commands there, not in components. Server-backed reads that a revisit needs at once are cached with TanStack Query per `.agents/skills/query-cache-patterns/SKILL.md` (OpenView is the reference); do not add another state or form library without demonstrated need.

## Features

- Current workspace routes are `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`; their screens live under `src/components/systems/`. `/profile` is the read-only Profile view (own, or another member's with `?person=<id>`) under `src/components/profile/`; `/settings` (Account settings) holds the signed-in person's editing under `src/components/settings/`. Inspect the target screen and state provider before choosing a pattern.
- Retired module, department, administration, workspace, onboarding, workspace-settings, and `/access-restricted` routes are absent and return the exported 404 page. Do not restore them as redirects or aliases.
- Use explicit `CompleteCollection` and `PageResult` boundaries. Filter/sort before paging; complete exports and aggregates cannot use a visible page. Render a prepared page without a second table slice. Backend pagination must preserve the frontend feature contract; retired list helpers are not an integration template.
- Authenticated SSE invalidations use `subscribeWorkspaceInvalidations` in `systems/shared/adapters/invalidation-events.ts`. One shell notification subscriber keeps the scalar unread count current on signed-in routes; OpenView Views/Dashboards/Charts/Reports and saved-chart editors, Boards widgets/record links, Manage audit/jobs/maintenance and workspace branding, Platform Files, and open Help contacts retain their feature-local listeners on the same singleton. Preserve opaque invalidations, last-listener cleanup and in-progress forms. Global focus/reconnect refetch stays disabled; only the unread count explicitly refreshes on focus while that stream is unavailable. Notification pages and bounded, current-authorized title metadata live in the existing account QueryClient. The SSE singleton and the Comms Realtime connection both belong to `systems/shared/adapters/connection-set.ts`, one set per account and organization with a leader tab where Web Locks exist; Comms subscribes through `subscribeSharedRealtime`. Do not add another stream, socket or provider.

## Styling

- Tailwind CSS v4 is CSS-first: design tokens live in `src/app/globals.css` (no `tailwind.config.*`). Use semantic tokens (`bg-card`, `text-muted-foreground`, ...) and the `.dark`/`data-*` theme attributes.
- Use the local shadcn-style primitives in `src/components/ui/` and `cn()`; do not introduce a second styling system without a concrete use case.

## Tests and verification

- Follow the root test workflow: focused cases during repair, one relevant batch when the work unit stabilizes, and the canonical gate only right before a push. Reuse valid passing evidence until relevant inputs change.
- Playwright Test runs `tests/isolated/` (rules, adapters, wire mapping and state machines, plus an owned development-ingress fixture) and `tests/http/` (browser journeys with a mocked `/api`). Put each behavior at the lowest faithful layer under `tdd-workflow`: logic in isolated tests, and in http specs one journey plus one example per error class, never a matrix that an isolated test can own.
- HTTP specs default to the static export through the test-only ASGI entry over production `StaticSite` (`../backend/tests/static_export_server.py`), not the FastAPI application or a live Supabase stack. Run `npm run build` first; missing/stale exports are refused. `PLAYWRIGHT_HTTP_SERVER=dev` opts the same HTTP project into `next dev` for local debugging; there is no separate dev project. Daily `npm run dev` remains distinct and proxies to the real local API. The lockfile-pinned Chromium project uses up to three local workers; CI uses six duration-balanced whole-file HTTP shards with two workers each, while its isolated job uses the configured default one worker. Wall-clock measurements (`comms-timeline-performance.spec.ts`) run in the one-worker `measure` project after every other project, and in their own CI job; run them alone with `--project=measure --no-deps`. Preserve UTC, `en-US` and zero retries.
- Playwright is the only frontend runner. Adding a second runner (for example Vitest for mutation testing) needs a recorded decision in `../docs/plans/test-suite-tier-2-5.md`.
- When preparing to push, use the root `python3 scripts/prepush.py --base <base-ref> --serial` command. Its frontend lane runs formatting, lint, type checking, all retained isolated and HTTP tests, and one native-or-container production build. Use `npm run verify` to repair a failed frontend gate. Production contains only FastAPI and static frontend assets; Node is a development and build-time dependency.
- `tooling/` contains frontend-owned Node launchers. Developers invoke them through `npm` scripts; repository-wide automation remains in the root `scripts/` directory.

## TDD and acceptance

- Before creating/extending tests, changing behavior, fixing bugs, or refactoring, read and follow [tdd-workflow](../.agents/skills/tdd-workflow/SKILL.md). It owns test admission, sequencing, and exceptions; this guide owns project runners.
- Workers must report the skill path actually read and the focused failing/passing test evidence, or the applicable exception. A reference or announcement alone does not prove TDD execution.
- The frontend gate owns formatting, ESLint, TypeScript, all retained isolated and HTTP browser tests, and one production build. Run only scoped cases and batches during implementation, as the root guide requires. There is no frontend numerical line-coverage requirement; backend coverage policy is unchanged.
- `next.config.ts` must keep `output: "export"` and `images.unoptimized`. A development-only `/api/:path*` rewrite may proxy to loopback FastAPI; production must have no rewrites, headers, redirects, proxy, route handlers, server actions, request-time `cookies`/`headers`, or `next start` command.
