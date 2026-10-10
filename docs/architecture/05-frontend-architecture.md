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

## Routes and shared help

Workspace pages are `/sandbox`, `/boards`, `/comms`, `/access`, `/openview`, `/manage`, and `/platform`. [`/profile`](../../frontend/src/app/(app)/profile/page.tsx) is the signed-in person's private profile, outside the workspace navigation groups. [`Profile`](../../frontend/src/components/profile/page.tsx) groups Identity, Sign-in & security, Look & behavior, and Regional settings; shared organization settings remain in Manage. Identity and regional drafts use the workspace navigation guard, and section anchors do not discard them. Personal regional preferences change display only, not the workspace day, schedules, or stored values.

The public [`/` page](../../frontend/src/app/page.tsx) checks session status before showing sign-in actions. A signed-in person is sent through [`workspaceStartRoute`](../../frontend/src/components/workspace-start.ts), which honors a confirmed, accessible start-page preference. Automatic selects OpenView when published sources exist, otherwise Sandbox when the person can open it; failed checks fall back to OpenView. This is a client-side static-page redirect, not a second application authorization gate.

[`AppHeaderActions`](../../frontend/src/components/app-shell.tsx) mounts the common [`HelpPanel`](../../frontend/src/components/help/help-panel.tsx) Sheet. It contains This page, Keyboard shortcuts, and Contact your administrator. [`PAGE_GUIDES`](../../frontend/src/components/help/page-guides.ts) covers the seven workspace pages plus Profile, including OpenComms' example-only boundary. [`SANDBOX_SHORTCUTS`](../../frontend/src/lib/shortcuts.ts) supplies both Help's list and the existing Sandbox Build owners: `?`, `0`, Delete and F2 require a confirmed enabled preference; standard undo/redo and essential keyboard activation remain available. Help's Profile link uses the existing dirty-draft guard.

Administrator contacts are a fresh account-scoped projection from `/api/workspace` only while Help is open and interaction is not suspended. [`helpWorkspaceContactsOptions`](../../frontend/src/components/systems/manage/adapters/manage-queries.ts) bypasses Manage's revision fallback and retains no contact cache after close. Rereads/refusals hide previous contacts, guests receive the invitation-person guidance, and final 401 handling still hands off globally to login. Branding never supplies contacts.

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
OpenView Views, Dashboards, Charts, saved-chart management/source editors, and Reports consume invalidations; Boards widgets/record
links, Manage audit/jobs/maintenance and workspace branding, Platform Files, and open Help contacts also use the
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

## Server-backed administration and files

Manage's [`Jobs`](../../frontend/src/components/systems/manage/components/jobs.tsx) view (`/manage?view=jobs`) lists report runs, post publications, event reminders, and backups from [`/api/jobs`](../../backend/app/systems/manage/jobs/router.py). Only administrators are admitted; Retry is an explicit state-guarded command, not automatic request replay. Manage [`Audit`](../../frontend/src/components/systems/manage/components/audit.tsx) separates Activity from Security events (`/manage?view=audit&audit=security-events`). Activity preserves the department-manager list boundary; the security-event feed is administrator-only. Access › Security links to this Manage view rather than rendering the feed itself.

Platform [`Files`](../../frontend/src/components/systems/platform/components/files.tsx) (`/platform?section=files&department=<uuid>`) is the real department library: authorized department selection, server paging/search/sort, upload/download, archive and reopen. Its [`library-files-api`](../../frontend/src/components/systems/platform/adapters/library-files-api.ts) uses the shared `/api/files` contract and `library_document` purpose; private bytes still pass through FastAPI. Record attachments stay in the live inspector rather than this library.

[`PersonCardPopover`](../../frontend/src/components/person-card.tsx) discloses a read-only card for a person already identified by an authorized source. Account/target-bound reads and avatar delivery hide refused or suspended data; it is not a global people directory. Guests receive only the public display-name, job-title and avatar projection, without contact details or biography.
