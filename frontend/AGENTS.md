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

- Workspace screens currently use local sample business data and interaction state, as described in `frontend/README.md`. Preserve that data flow for UI work; do not reconnect business APIs or realtime merely because backend helpers exist. Existing-account sign-in, session validation/refresh, logout, and protected invitation acceptance remain connected.
- Authenticated pages live under `src/app/(app)/`, whose layout mounts `AppPage` (auth gate + shell) once for the group; do not wrap pages individually or implement a second cookie/auth gate. `proxy.ts` sets CSP and security headers only — it is not auth.
- When a feature uses authorized backend integration, domain requests go through `apiFetch()` to `/bff/[...path]`; the BFF converts cookies to a Bearer token and refreshes the Supabase session on a backend 401. Never call `BACKEND_URL` or Supabase directly from pages.
- Sessions use HttpOnly `openslate_access`/`openslate_refresh` cookies managed by the `/session/*` route handlers; the browser never sees tokens.
- For client-side backend fetches, use the established `useEffect` + local `useState` convention. Local sample screens use their existing state/provider and derive filtered results without adding fetch effects. TanStack Query and React Hook Form are not installed; do not add them without a demonstrated need.

## Features

- Current workspace routes are `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`; their screens live under `src/components/sample/`. Inspect the target screen and state provider before choosing a pattern.
- Legacy module, department, administration, and workspace routes redirect to the current workspace. Do not restore retired pages or components to satisfy an older example.
- For backend list integration, use `listQuery()` (`limit=100`, follow `has_more` via offset) and `listAllModuleFields()` when all fields are required; preserve the server's field-UUID, relationship, and lifecycle contracts.
- Workspace screens currently do not subscribe to realtime. Any explicitly requested integration must preserve private Broadcast invalidation without row snapshots and avoid discarding in-progress form state.

## Styling

- Tailwind CSS v4 is CSS-first: design tokens live in `src/app/globals.css` (no `tailwind.config.*`). Use semantic tokens (`bg-card`, `text-muted-foreground`, ...) and the `.dark`/`data-*` theme attributes.
- Use the local shadcn-style primitives in `src/components/ui/` and `cn()`; do not introduce a second styling system without a concrete use case.

## Tests and verification

- Follow the root non-negotiable test workflow: focused case, passing feature batch, affected HTTP/browser integration, then pre-push gates. Run full suites only when preparing to push; edits, commits, and routine handoffs use focused checks.
- Playwright is the only test runner, including pure-library tests, under `tests/isolated/`, `tests/http/`, and `tests/browser/`. In mocked browser tests, mock `**/session/status` (authenticated) and any `**/bff/**` requests the target actually makes. Use existing local fixtures for sample screens; do not add backend traffic solely to make a mock meaningful. Assert user-visible behavior with roles/labels/text and relevant failure and accessibility paths.
- Real-stack tests (`tests/fullstack/`) run through `npm run test:e2e:fullstack` with a disposable Supabase stack and generated identities; they are excluded from ordinary runs and `verify`.
- When preparing to push, use the root `python3 scripts/prepush.py --base <base-ref>` command. Its frontend lane runs the existing format, lint, typecheck, production build/E2E, container boundary, and coverage commands exactly once. Use `npm run verify` only to repair a failed frontend gate. Local npm commands generate `frontend/.env.local` from canonical root `.env`; never source the root `.env` into npm or Next.

## TDD and coverage

- Before creating/extending tests, changing behavior, fixing bugs, or refactoring, read and follow [tdd-workflow](../.agents/skills/tdd-workflow/SKILL.md). It owns test admission, sequencing, and exceptions; this guide owns project runners and coverage thresholds.
- Workers must report the skill path actually read and the focused failing/passing test evidence, or the applicable exception. A reference or announcement alone does not prove TDD execution.
- Require **90% overall executable production-line coverage** for `src/` and **90% changed executable production-line coverage** against the task's recorded base revision. Local pre-push validates the exact plan and fixed production smoke without replaying instrumented coverage. CI runs one isolated/HTTP part plus three duration-balanced desktop-Chromium parts, validates their exact union, and enforces the gate once. Full mobile runs on mobile-sensitive changes; Firefox, WebKit, broader mobile, and extended compatibility remain on `main` and nightly. `npm run test:coverage` remains available for focused coverage debugging. Missing, mixed, stale, partial, retried, or failed hosted measurement is **NOT READY TO MERGE**.
