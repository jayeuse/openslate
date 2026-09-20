# Frontend Architecture

> **Scope:** Static Next.js interface, browser session behavior, and current sample-data boundary.

Next.js 16 and React 19 build the OpenSlate interface as a static export. In
daily development, `next dev` is the direct browser origin and its
development-only `/api` proxy reaches loopback FastAPI. Production uses neither
a Next.js server nor Node.js runtime. The exported browser application contains
no Route Handlers, Server Actions, request-time cookie/header access, runtime
rewrites, standalone output, or production server-side proxy. FastAPI serves
its exact generated routes, assets, and 404 page from `WEB_ASSETS_ROOT`.

Retired `/workspace`, `/departments`, `/modules`, `/administration`, `/onboarding`, and `/settings/workspace` paths have no compatibility redirect or alias. They resolve through the exported 404 page.

Authenticated routes live under `src/app/(app)/`; `AppPage` owns the one browser-side application gate and shell. Browser security headers, route/asset cache policy, and static-content delivery belong to FastAPI and Caddy, never the frontend runtime.

`apiFetch()` calls the same-origin `/api` path. In daily development, Next's
proxy forwards that path to FastAPI; production Caddy forwards the production
origin to FastAPI. FastAPI issues and refreshes HttpOnly `openslate_access` and
`openslate_refresh` cookies. Browser mutations include the CSRF token, and the
client coordinates refresh attempts across tabs.

Login accepts email or username. Invitation tokens are consumed by the FastAPI setup flow; temporary-password users are kept in setup-only state until activation succeeds. Logout reports server failure rather than silently discarding browser state.

Most workspace business data and interactions remain browser-local sample state. Authorized API adapters must preserve the existing feature contract, loading/retry behavior, and unsaved-draft protection. An eventual SSE consumer must treat events as cache invalidations and never as row data.
