# Frontend Architecture

> **Scope:** Static Next.js interface, browser session behavior, and current persistence boundaries.

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
origin to FastAPI. Supabase Auth supplies the access JWT; FastAPI stores it in
the HttpOnly `openslate_access` cookie. The HttpOnly `openslate_refresh` cookie
contains an opaque application refresh handle, not the provider refresh token.
Production sets the `Secure` attribute; relaxed local HTTP development omits it.
FastAPI stores the handle's digest and the encrypted provider token pair in its
application session row. Browser mutations include the CSRF token, and the
client coordinates refresh attempts across tabs through [`refreshBrowserSession`](../../frontend/src/lib/api.ts).

[`signIn`](../../frontend/src/lib/auth-api.ts) sends email and password;
usernames are profile labels. Supabase Auth handles authentication and
invitation/recovery email, while FastAPI binds the provider subject to an
eligible application profile and enforces authorization. The [invitation
setup](../../frontend/src/app/auth/setup/page.tsx) and [recovery
page](../../frontend/src/app/auth/recovery/page.tsx) submit the provider's
one-time email-action token to FastAPI only after the user takes the
corresponding form action. Logout reports server failure rather than silently
discarding browser state. See [authentication and authorization](08-authentication-authorization.md)
for session admission and account eligibility.

Some workspace surfaces remain browser-local sample state. Sandbox is an
exception: its Build, Automations, Test, History, and Review & Publish workflow
uses authenticated FastAPI contracts and PostgreSQL. Its temporary Test inputs
never create operational records. Authorized API adapters preserve loading,
retry, revision-conflict, and unsaved-draft protection. SSE consumers treat
events as cache invalidations and never as row data.
