<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Frontend Engineering Rules

## Core React rules

- Keep TypeScript strict: do not introduce `any`; accept external data as `unknown` and narrow or validate it at the boundary.
- Define explicit prop types for every component. Prefer discriminated unions for mutually exclusive UI states instead of several optional boolean flags.
- Keep components focused. Separate data fetching, stateful behavior, formatting, and complex presentation when a component starts accumulating responsibilities.
- Prefer composition and `children` over passing props through components that do not use them. Extract repeated stateful behavior into custom hooks.
- Follow the Rules of Hooks and keep effect dependencies accurate. Do not use effects to derive renderable state; derive it during render instead.
- Keep state local and minimal. Do not duplicate values that can be derived from props or existing state, and do not add a state library without a demonstrated cross-cutting need.
- Keep Server Components as the default. Add `"use client"` only for browser APIs, event handlers, or client-side state, and keep client boundaries as small as practical.
- Keep React Strict Mode enabled so development exposes unsafe side effects and lifecycle assumptions early.
- Use `useMemo`, `useCallback`, and `memo` only when profiling or an established component contract justifies them. Never use them by default.
- Use stable domain identifiers for dynamic list keys, never array indexes. Lazy-load or virtualize only when bundle or rendering measurements show a need.
- Keep side effects out of render. Handle async failures explicitly and provide loading, empty, error, and recovery states for data-dependent UI.
- Use App Router error boundaries (`error.tsx`) for render failures and keep user-facing error messages generic; do not expose secrets, tokens, stack traces, or internal response details.
- Prefer semantic HTML and native controls before ARIA. Preserve keyboard access, visible focus, sufficient color contrast, reduced-motion support, and deliberate focus management for dialogs or route transitions.

## Data access and auth

- Authenticated pages render inside `AppPage` (auth gate + shell); do not implement a second cookie/auth gate. `proxy.ts` sets CSP and security headers only — it is not auth.
- All domain requests go through `apiFetch()` to `/bff/[...path]`; the BFF converts cookies to a Bearer token and refreshes the Supabase session on a backend 401. Never call `BACKEND_URL` or Supabase directly from pages.
- Sessions use HttpOnly `openslate_access`/`openslate_refresh` cookies managed by the `/session/*` route handlers; the browser never sees tokens.
- Fetch with `useEffect` + local `useState` — the app-wide convention. TanStack Query and React Hook Form are not installed; do not add them without a demonstrated need.

## Features

- Use `listQuery()` for list parameters (`limit=100`, follow `has_more` via offset); use `listAllModuleFields()` when every field is needed.
- Record `data` is keyed by field UUID and validated with the dynamic Zod schemas in `lib/field-schema.ts`; relationships are managed by `RelationshipManager` and never stored inside primitive record data.
- Close/reopen/purge flows use the `LifecycleAction` dialog (`components/lifecycle-dialog.tsx`), not ordinary CRUD controls.
- Canonical routes live under `modules/[moduleId]`; department-scoped aliases (`departments/[departmentId]/modules/...`) are thin re-export pages — keep them that way.
- Realtime is private Broadcast invalidation only: `RealtimeProvider` → `/session/realtime-token` → `openslate:invalidation`; pass `preserveStateOnInvalidation` to keep in-progress form state.

## Styling

- Tailwind CSS v4 is CSS-first: design tokens live in `src/app/globals.css` (no `tailwind.config.*`). Use semantic tokens (`bg-card`, `text-muted-foreground`, ...) and the `.dark`/`data-*` theme attributes.
- Use the local shadcn-style primitives in `src/components/ui/` and `cn()`; do not introduce a second styling system without a concrete use case.

## Tests and verification

- Playwright is the only test runner — including pure-library tests — under `tests/`. Mock `**/session/status` (authenticated) and `**/bff/**` (JSON fixtures); assert user-visible behavior with roles/labels/text, including failure and accessibility paths.
- Live tests (`tests/live/`) are opt-in via `npm run test:e2e:live`, serial, loopback-only, and excluded from ordinary runs and `verify`.
- Run `npm run verify` (format, lint, typecheck, build, production E2E) before handoff. Copy `frontend/.env.local` from `.env.example`; never source the root `.env` into npm or Next.
