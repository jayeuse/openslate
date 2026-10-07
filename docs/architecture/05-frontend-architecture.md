# Frontend Architecture

> **Scope:** Static Next.js interface, browser session behavior, and current persistence boundaries.

Next.js 16 and React 19 build the OpenSlate interface as a static export. In
daily development, `next dev` is the direct browser origin and its
development-only `/api` proxy reaches loopback FastAPI. Production uses neither
a Next.js server nor Node.js runtime. The exported browser application contains
no Route Handlers, Server Actions, request-time cookie/header access, runtime
rewrites, standalone output, or production server-side proxy. FastAPI serves
its exact generated routes, assets, and 404 page from `WEB_ASSETS_ROOT`.

Retired `/workspace`, `/departments`, `/modules`, `/administration`, `/onboarding`, `/settings/workspace`, and `/access-restricted` paths have no compatibility redirect or alias. They resolve through the exported 404 page.

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

Sandbox, Boards, Access, OpenView, Manage, and Platform use authenticated
FastAPI adapters for their implemented data and actions. Sandbox's Build,
Triggers, Test, History, and Review & Publish workflow uses PostgreSQL; temporary
Test inputs never create operational records. API adapters preserve loading,
retry, denial, revision-conflict, and unsaved-draft protection.

OpenComms alone uses browser-local sample data. Its [route layout](../../frontend/src/app/(app)/(workspace)/comms/layout.tsx)
mounts `SampleProvider`; live routes do not inherit sample snapshot recovery or
storage state. The authenticated [application gate](../../frontend/src/components/app-page.tsx)
retains the verified-account identity and [query/theme providers](../../frontend/src/components/query-provider.tsx)
across route changes. Account-owned Comms snapshots and drafts are cleared by
[shared session cleanup](../../frontend/src/components/systems/shared/runtime/workspace-identity.tsx),
including when the Comms layout is unmounted. Comms sample roles, permissions,
and messages are not authoritative application authorization or durable data.

SSE consumers treat events as cache invalidations and never as row data.
OpenView Views, Charts, and Reports use the cache bridge; Boards widgets/record
links, Manage maintenance, and Platform connected notifications also use the
[shared authenticated stream](../../frontend/src/components/systems/shared/adapters/invalidation-events.ts).
The persistent shell's [notification bell](../../frontend/src/components/systems/platform/components/notification-bell.tsx)
subscribes to unread-count invalidations and reads server-backed notifications;
the server rechecks recipient and source access before returning them.

OpenView's live Record inspector displays field values read-only until an
authorized writer opens Edit. Its Details, linked-record, and Files actions
enforce current permissions, including attachment upload and archive
([`live-record-inspector.tsx`](../../frontend/src/components/systems/openview/components/live-record-inspector.tsx)).
Sandbox Test evaluates temporary values against the draft; it does not create or
change live Records.
