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

- Keep TypeScript strict: no `any`; accept external data as `unknown` and narrow it at the boundary.
- Keep Server Components as the default. Add `"use client"` only for browser APIs, event handlers, or client-side state, and keep client boundaries as small as practical.
- Keep React Strict Mode enabled to expose unsafe side effects and lifecycle assumptions.
- Use `useMemo`, `useCallback`, and `memo` only when profiling or an established component contract justifies them, never by default.
- Provide loading, empty, error, and recovery states for data-dependent UI.
- Use App Router error boundaries (`error.tsx`) for render failures and keep user-facing error messages generic; do not expose secrets, tokens, stack traces, or internal response details.
- Preserve keyboard access, visible focus, sufficient color contrast, reduced-motion support, and deliberate focus management for dialogs and route transitions.

## Data access and auth

- Workspace systems use authorized FastAPI adapters, as described in `frontend/README.md`. Preserve those contracts and their loading, denial, conflict, and draft states.
- No production route runs on browser-local sample data. The in-memory Comms engine (`tests/support/comms-memory/`) and `systems/shared/runtime/sample-*` are test-only; do not import them into `src/` routes.
- Authenticated pages live under `src/app/(app)/`, whose layout mounts `AppPage` (auth gate and shell) once. Do not wrap pages individually or add a second cookie or auth gate. `AppPage` owns the per-account identity and query/theme providers.
- `(workspace)/comms/layout.tsx` mounts `CommsClientProvider`, which owns the one live Comms runtime for the verified account and organization. Shared session cleanup disposes that runtime and clears owned Comms drafts; unmounting the layout clears drafts only after a real organization change.
- When a feature uses authorized backend integration, domain requests go through `apiFetch()` to the same-origin `/api` gateway. It sends the CSRF header for cookie-authenticated mutations and performs the documented FastAPI refresh flow. Never bypass the same-origin API boundary from pages.
- Organization context: `src/lib/organization-context.ts` keeps the tab's organization in session storage; `apiFetch()` sends it as `X-Org`, and without it the server uses the session's active organization. SSE opens `/api/events?org=<id>`.
- Per-account caches key on user and organization; a switch must show no stale data from the previous organization. Roles come from the current membership, not the account. Signed-out pages read the look of the browser's last organization (`/api/workspace/appearance?org=`).
- Sessions use HttpOnly `slateops_access`/`slateops_refresh` cookies issued by FastAPI; the browser never sees tokens. Next has no proxy file, route handler, server action, request-header, or request-cookie boundary. Its development-only rewrite forwards same-origin `/api/*` to loopback FastAPI.
- Feature adapters own typed reads and confirmed commands through schema-required `apiFetch`. Keep ephemeral drafts local and await acceptance before clearing or navigating. Preserve loading/retry, last-good refresh data, cancellation, and pending guards.
- Add Comms reads and commands in `systems/comms/adapters/live-runtime.ts`, not in components.
- Cache server-backed reads that a revisit needs at once with TanStack Query (OpenView is the reference). Do not add another state or form library without demonstrated need.

## Features

- Current workspace routes are `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`; their screens live under `src/components/systems/`. `/profile` is the read-only Profile view (own, or another member's with `?person=<id>`) under `src/components/profile/`; `/settings` (Account settings) holds the signed-in person's editing under `src/components/settings/`. Inspect the target screen and state provider before choosing a pattern.
- Retired module, department, administration, workspace, onboarding, workspace-settings, and `/access-restricted` routes are absent and return the exported 404 page. Do not restore them as redirects or aliases.
- Use explicit `CompleteCollection` and `PageResult` boundaries. Filter/sort before paging; complete exports and aggregates cannot use a visible page. Render a prepared page without a second table slice. Backend pagination must preserve the frontend feature contract; retired list helpers are not an integration template.
- Authenticated SSE invalidations use `subscribeWorkspaceInvalidations` in `systems/shared/adapters/invalidation-events.ts`. Preserve opaque invalidations, last-listener cleanup, and in-progress forms. The subscriber list is in `frontend/README.md`.
- Global focus/reconnect refetch stays disabled; only the unread count refreshes on focus while the stream is unavailable.
- The SSE singleton and the Comms Realtime connection both belong to `systems/shared/adapters/connection-set.ts`, one set per account and organization; Comms subscribes through `subscribeSharedRealtime`. Do not add another stream, socket, or provider.

## Styling

- Tailwind CSS v4 is CSS-first: design tokens live in `src/app/globals.css` (no `tailwind.config.*`). Use semantic tokens (`bg-card`, `text-muted-foreground`, ...) and the `.dark`/`data-*` theme attributes.
- Use the local shadcn-style primitives in `src/components/ui/` and `cn()`; do not introduce a second styling system without a concrete use case.

## Tests and verification

- Follow the root testing rules. This guide owns only the frontend runners; runner and shard detail is in `../docs/architecture/16-testing-architecture.md`.
- Playwright Test runs `tests/isolated/` (rules, adapters, wire mapping and state machines, plus an owned development-ingress fixture) and `tests/http/` (browser journeys with a mocked `/api`). Put each behavior at the lowest faithful layer under `tdd-workflow`: logic in isolated tests, and in http specs one journey plus one example per error class, never a matrix that an isolated test can own.
- HTTP specs default to the static export through the test-only ASGI entry (`../backend/tests/static_export_server.py`), not the FastAPI application or a live Supabase stack. Run `npm run build` first; missing or stale exports are refused. `PLAYWRIGHT_HTTP_SERVER=dev` opts the HTTP project into `next dev` for local debugging.
- Run wall-clock measurements alone with `--project=measure --no-deps`. Preserve UTC and `en-US`.
- CI allows one retry and local runs none. A test that passes only on its retry needs a current entry in `tests/flaky.json` (`docs/plans/ci-stability.md` D1).
- `playwright.fullstack.config.ts` runs `tests/fullstack/` through `../backend/tests/fullstack_runner.py`.
- Playwright is the only frontend runner. Adding a second runner (for example Vitest for mutation testing) needs a recorded decision in `../docs/plans/test-suite-tier-2-5.md`.
- Use `npm run verify` to repair a failed frontend gate. Production contains only FastAPI and static frontend assets; Node is a development and build-time dependency.
- `tooling/` contains frontend-owned Node launchers. Developers invoke them through `npm` scripts; repository-wide automation remains in the root `scripts/` directory.

## TDD and acceptance

- Before creating/extending tests, changing behavior, fixing bugs, or refactoring, read and follow [tdd-workflow](../.agents/skills/tdd-workflow/SKILL.md). It owns test admission, sequencing, and exceptions; this guide owns project runners.
- Workers must report the skill path actually read and the focused failing/passing test evidence, or the applicable exception. A reference or announcement alone does not prove TDD execution.
- There is no frontend numerical line-coverage requirement.
- `next.config.ts` must keep `output: "export"` and `images.unoptimized`. A development-only `/api/:path*` rewrite may proxy to loopback FastAPI; production must have no rewrites, headers, redirects, proxy, route handlers, server actions, request-time `cookies`/`headers`, or `next start` command.

## Skills

- Screens, forms, and validation: [`react-frontend-patterns`](../.agents/skills/react-frontend-patterns/SKILL.md). Use it for each change under `src/app/` and `src/components/`.
- Cached server reads: [`query-cache-patterns`](../.agents/skills/query-cache-patterns/SKILL.md). Use it for TanStack Query reads: query keys, SSE invalidation, load-more pages, and prefetch.
- Playwright tests: [`playwright-e2e-testing`](../.agents/skills/playwright-e2e-testing/SKILL.md). Use it to write, fix, or review a spec, fixture, mock, or config, and to diagnose a flaky test.
- UI/UX and visual design: [`ui-ux-pro-max`](../.agents/skills/ui-ux-pro-max/SKILL.md) and [`impeccable`](../.agents/skills/impeccable/SKILL.md). Read [DESIGN-RULES.md](../DESIGN-RULES.md) for what each one owns and their order.
