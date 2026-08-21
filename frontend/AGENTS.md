<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Frontend Engineering Rules

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
- Test user-visible behavior rather than implementation details. Add component tests for reusable interactive logic and Playwright coverage for critical journeys, including failure and accessibility paths.
- Run `npm run verify` before handoff. New dependencies, client components, or architecture patterns require a concrete use case and a corresponding test strategy.
