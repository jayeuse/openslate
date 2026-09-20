# Frontend Architecture

> **Scope:** Next.js interface, browser session behavior, and current sample-data boundary.

Next.js 16 and React 19 render the OpenSlate interface. Authenticated routes live under `src/app/(app)/`; `AppPage` owns the one application authentication gate and shell. `proxy.ts` sets browser security headers and is not an authorization layer.

`apiFetch()` calls the same-origin `/api` path. FastAPI issues and refreshes HttpOnly `openslate_access` and `openslate_refresh` cookies. Browser mutations include the CSRF token, and the client coordinates refresh attempts across tabs. Next.js has no server-side proxy or session route handlers.

Login accepts email or username. Invitation tokens are consumed by the FastAPI setup flow; temporary-password users are kept in setup-only state until activation succeeds. Logout reports server failure rather than silently discarding browser state.

Most workspace business data and interactions remain browser-local sample state. Authorized API adapters must preserve the existing feature contract, loading/retry behavior, and unsaved-draft protection. An eventual SSE consumer must treat events as cache invalidations and never as row data.
