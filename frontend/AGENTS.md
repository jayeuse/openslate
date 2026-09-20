<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Frontend Engineering Rules

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

- Workspace screens currently use local sample business data and interaction state, as described in `frontend/README.md`. Preserve that data flow for UI work; do not reconnect business APIs or server events merely because backend helpers exist. Existing-account sign-in, session validation/refresh, logout, and protected invitation acceptance remain connected.
- Authenticated pages live under `src/app/(app)/`, whose layout mounts `AppPage` (auth gate + shell) once for the group; do not wrap pages individually or implement a second cookie/auth gate.
- When a feature uses authorized backend integration, domain requests go through `apiFetch()` to the same-origin `/api` gateway. It sends the CSRF header for cookie-authenticated mutations and performs the documented FastAPI refresh flow. Never bypass the same-origin API boundary from pages.
- Sessions use HttpOnly `openslate_access`/`openslate_refresh` cookies issued by FastAPI; the browser never sees tokens. Next has no proxy file, route handler, server action, request-header, or request-cookie boundary. Its development-only rewrite forwards same-origin `/api/*` to loopback FastAPI.
- Feature adapters own typed reads and confirmed commands. Local sample screens use the shared runtime, `useSampleResource`, and `useSampleCommands`; keep ephemeral drafts local and await acceptance before clearing or navigating. Preserve loading/retry, last-good refresh data, cancellation, and pending guards. Future authorized backend adapters use schema-required `apiFetch`; do not add a second state or form library without demonstrated need.

## Features

- Current workspace routes are `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`; their screens live under `src/components/systems/`. Inspect the target screen and state provider before choosing a pattern.
- Retired module, department, administration, workspace, onboarding, and workspace-settings routes are absent and return the exported 404 page. Do not restore them as redirects or aliases.
- Use explicit `CompleteCollection` and `PageResult` boundaries. Filter/sort before paging; complete exports and aggregates cannot use a visible page. Render a prepared page without a second table slice. Future backend pagination must preserve the frontend feature contract; retired list helpers are not an integration template.
- Workspace screens currently do not subscribe to server events. Any explicitly requested integration must preserve authenticated SSE invalidation without row snapshots and avoid discarding in-progress form state.

## Styling

- Tailwind CSS v4 is CSS-first: design tokens live in `src/app/globals.css` (no `tailwind.config.*`). Use semantic tokens (`bg-card`, `text-muted-foreground`, ...) and the `.dark`/`data-*` theme attributes.
- Use the local shadcn-style primitives in `src/components/ui/` and `cn()`; do not introduce a second styling system without a concrete use case.

## Tests and verification

- Follow the root test workflow: focused case, passing feature batch, then the lean frontend gate. Run all retained frontend tests only when the work unit stabilizes or before push.
- Playwright Test is the lightweight runner for `tests/isolated/`; add isolated tests for rules and state. Targeted `tests/http/` contracts may use the pinned Chromium project against the loopback `next dev` HMR server without generated frontend runtime configuration.
- When preparing to push, use the root `python3 scripts/prepush.py --base <base-ref>` command. Its frontend lane runs formatting, lint, type checking, the retained isolated tests, and one native-or-container production build. Use `npm run verify` to repair a failed frontend gate. Production contains only FastAPI and static frontend assets; Node is a development and build-time dependency.
- `tooling/` contains frontend-owned Node launchers. Developers invoke them through `npm` scripts; repository-wide automation remains in the root `scripts/` directory.

## TDD and acceptance

- Before creating/extending tests, changing behavior, fixing bugs, or refactoring, read and follow [tdd-workflow](../.agents/skills/tdd-workflow/SKILL.md). It owns test admission, sequencing, and exceptions; this guide owns project runners.
- Workers must report the skill path actually read and the focused failing/passing test evidence, or the applicable exception. A reference or announcement alone does not prove TDD execution.
- Frontend acceptance is formatting, ESLint, TypeScript, the retained isolated and targeted HTTP route-contract tests, and one production build. There is no broad browser suite or numerical line-coverage requirement. Backend coverage policy is unchanged.
- `next.config.ts` must keep `output: "export"` and `images.unoptimized`. A development-only `/api/:path*` rewrite may proxy to loopback FastAPI; production must have no rewrites, headers, redirects, proxy, route handlers, server actions, request-time `cookies`/`headers`, or `next start` command.
