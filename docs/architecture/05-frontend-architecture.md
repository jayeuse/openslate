# Frontend Architecture

> **Scope:** The Next.js application, local workspace prototype, session handlers, BFF boundary, and build/proxy path.
> **Audience:** Frontend engineers, reviewers tracing browser requests, and operators running the frontend.
> **Related documents:** [API architecture](07-api-architecture.md), [Authentication and authorization](08-authentication-authorization.md), [Configuration](17-configuration.md), [Testing](16-testing-architecture.md)

## Runtime and route boundaries

The frontend uses Next.js App Router and React with strict TypeScript. Package
versions live in `frontend/package.json` and its lockfile. Pages and layouts are
Server Components by default; the interactive workspace features are client
components under `frontend/src/components/systems/`.

`src/app/layout.tsx:RootLayout` loads Geist fonts and `globals.css`, awaits
`connection()`, and applies the request nonce from `src/proxy.ts`. Its blocking
head script applies stored theme, accent, density, and radius preferences before
hydration. `ThemeProvider` synchronizes later storage changes. Base UI receives
the nonce through `CSPProvider`. The application runs as a Node server, not a
static export.

```text
RootLayout
├── public pages, login, invitation setup
└── (app)/layout.tsx → AppPage → AppShell
    ├── settings/appearance
    └── (workspace)/layout.tsx → SampleProvider
        └── Sandbox, Access, OpenView, Boards, Comms, Manage, Platform
```

Paths below are relative to `frontend/` unless stated otherwise.

| Area             | Routes and source                                                                                                  | Current behavior                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public           | `/`, `/setup`, `/access-restricted`                                                                                | Standalone pages. `/setup` describes the supported local setup and administrator bootstrap. `/access-restricted` is not an active domain-authorization redirect.    |
| Authentication   | `/login`, `/auth/setup`, `/auth/callback`                                                                          | Real sign-in, invitation password setup, and server callback exchange.                                                                                              |
| Workspace        | `/sandbox`, `/access`, `/openview`, `/boards`, `/comms`, `/manage`, `/platform` under `src/app/(app)/(workspace)/` | Interactive local sample features sharing one workspace provider.                                                                                                   |
| Appearance       | `/settings/appearance`                                                                                             | Browser-local preferences outside the sample provider.                                                                                                              |
| Legacy routes    | `/workspace`, `/onboarding`, `/settings/workspace`, department/module/administration routes                        | Redirects to the current workspace; retired CRUD pages and alias implementations are not active.                                                                    |
| Session handlers | `/session/login`, `/session/logout`, `/session/status`, `/session/password`, `/session/realtime-token`             | Server Route Handlers; tokens stay in HttpOnly cookies except the dedicated realtime-token response.                                                                |
| BFF              | `/bff/[...path]`                                                                                                   | Cookie-to-Bearer forwarding boundary for authorized future business integration. Current sample features do not call it for business data.                          |
| Recovery         | `src/app/error.tsx`, `global-error.tsx`, `not-found.tsx`                                                           | Descendant render recovery, independent root-layout recovery, and not-found UI. Feature resources own their loading states; there are no route `loading.tsx` files. |

`(app)/layout.tsx` mounts `AppPage` once, preserving the shell during client
navigation. The workspace layout similarly preserves `SampleProvider` across
its seven routes. The generic `[pillar]` entry is not a second implementation
of these seven feature screens.

`src/components/app-navigation.tsx` renders expandable sidebar groups for the
top-level sections of Sandbox, Boards, Access, OpenView, Manage, and Platform.
Each group label toggles its child links without navigation; selecting a child
navigates to that section. OpenComms stays a direct link above the sidebar footer.
`workspace-navigation.ts` owns the section URL mapping; the shell reads the URL
rather than feature state. Access and Manage
use `view`, while Boards, OpenView, Sandbox, and Platform use `section` query
parameters. Legacy Platform hash/file links and existing feature deep links
remain readable. The shell navigation guard lets active features block pending
commands or defer a link behind an unsaved-change confirmation.

## Local workspace authority

The frontend prototype defines the product behavior. Existing backend endpoint
shapes do not constrain its sample models. Authentication is connected; workspace
records, policy editing, conversations, reports, settings, local releases, and
account demonstrations remain local sample behavior. This separation is not a
claim of production persistence, server authorization, delivery, or scheduling.

`systems/shared/runtime/sample-runtime.ts:createSampleRuntime` owns the current snapshot.
`systems/shared/runtime/sample-state.tsx:SampleProvider` creates one runtime and subscribes with
`useSyncExternalStore`. Legacy local setters and transactions use that same
runtime, so there is no second store competing with feature command adapters.
The provider decodes saved values before use and persists synthetic workspace
state in tab-scoped `sessionStorage` under an account-scoped key derived from
`openslate.sample.v1` and the verified user ID returned by `/session/status`.
The older unowned key is left untouched but is not loaded, because it cannot
be attributed to a signed-in account. A switch between accounts in the same
tab restores only the matching account's snapshot.

A synchronous transaction reads the latest owner values, stages related changes,
and publishes once. Touched values are copied so a rejected or throwing recipe
cannot mutate the published nested state. `draft.reject(result)` returns the
feature's rejection without publishing any staged owner. Async recipes are
rejected: awaited work belongs outside the atomic recipe.

`runtime.execute` and `runtime.load` expose promise boundaries without artificial
production delays. Commands validate against current state when accepted, rather
than returning a preview based on a previous React render. Abort signals and
runtime generations prevent cancelled or reset operations from publishing.
Full reset invalidates all operations; a feature reset invalidates operations
whose declared owner keys overlap. Cross-feature commands must declare every
owner they read or write.

Local `File` objects and object URLs stay in Comms' attachment registry, outside
the JSON snapshot. Sample reset releases local attachments. Sign-out removes
the verified account's snapshot even from a route outside the workspace
provider, and cancels pending work in a mounted provider. It leaves other
accounts' snapshots and the older unowned key untouched.

## Async resources, commands, and drafts

`systems/shared/runtime/sample-async-state.ts` contains the small resource and command state
machines. `systems/shared/runtime/sample-async.ts` connects them to React and runtime key
subscriptions. Feature adapters own their domain decoding, projections,
validation, conflicts, and command result types.

- A resource distinguishes initial loading, initial error with Retry, and ready
  data. Refresh keeps the last good data and reports a refresh failure beside it.
  New queries discard incompatible results; stale or aborted completions are
  ignored.
- Commands expose pending operation keys and reject immediate conflicting
  duplicate submissions. Callers await acceptance before closing dialogs,
  clearing drafts, navigating, or displaying success.
- Pending forms guard their conflicting actions and dismissals. The shared hook
  blocks ordinary navigation links and warns before unloading; feature-owned
  router/sidebar actions apply the same pending policy. Unmount cancels uncommitted
  work rather than installing a global browser-history trap.
- Failed saves retain the user's text, selections, and attachments. Ephemeral
  input and canvas gestures can stay synchronous; confirmed domain changes pass
  through the feature adapter.

The current boundaries are feature-specific, not a generic repository framework:

| Feature  | Adapter and ownership                                                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox  | `systems/sandbox/state/async.ts` coordinates the existing reducer, design history, versions, and local release simulation. Canvas interaction remains local.                                                                      |
| Access   | `systems/access/state/controller.tsx` projects current policy plus federated owners and runs policy commands atomically. Role/group editors preserve create versus edit intent and detect stale baselines.                        |
| OpenView | `systems/openview/adapters/controller.ts` owns view/report/dashboard operations and audience projection. Data-only `seeds.ts` is separate from rendered analytics, so Access does not import the analytics UI to obtain defaults. |
| Boards   | `systems/boards/state/controller.tsx` owns board, event, announcement, personal/reminder, and related notification changes using current Access policy.                                                                           |
| Comms    | `systems/comms/state/runtime.ts` coordinates conversation and configuration changes. `draft-text.ts` owns keyed text drafts independently of the message history snapshot.                                                        |
| Manage   | `systems/manage/state/state.ts` retains decoding, execution, and section drafts. Organization, Security, Backup, Updates, Licensing, and Audit have narrow presentation panels.                                                   |
| Platform | `systems/platform/` owns platform records and demonstrations and delegates shared-owner operations to their feature boundaries. Nullable selection is a normal empty state in record-dependent sections.                          |

Comms text drafts are keyed by verified account and composer destination and
persist independently of conversation history. Submit clears only the accepted
submitted draft, preserving newer edits; attachment objects remain in the
existing local registry. Legacy drafts in the matching account's workspace
snapshot can be migrated; older unowned dedicated draft keys remain inaccessible.
Workspace reset and sign-out clear only the active account's draft persistence.
Draft persistence failure is exposed to the user rather than silently claiming
that typing was saved.

## Collections and presentation

`systems/shared/helpers/sample-collections.ts` distinguishes `CompleteCollection<T>` from
`PageResult<T>`. A complete collection declares the full result for its query;
a page carries items, total, offset, and limit. Filtering and stable sorting run
before paging. Empty and shortened result sets clamp to a valid page.

Aggregates and all-results exports consume complete results, never the currently
visible page. A table receiving a prepared page renders those rows without a
second local slice. `PaginationControls` supplies accessible page actions while
feature-owned mobile cards consume the same visible result. Local sample
collections are complete in memory; connecting a server later must preserve
these explicit completeness guarantees.

OpenView grouping uses one pass to accumulate rows in insertion order. Its
analytics defaults are data-only; the specialized Recharts and X6 interfaces
remain feature dependencies. No general query cache, generated business client,
new form library, or speculative virtualization layer is introduced.

## Session validity and availability

`src/components/app-page.tsx:AppPage` checks `/session/status` after hydration
and on pathname changes. Only an exact authenticated response opens the shell.
Definitively invalid sessions redirect to login. An initial unavailable check
shows Retry; a later outage retains the mounted workspace and its drafts with a
retryable warning. Checks are serialized and stale results cannot replace the
latest requested state.

This is a client session gate, not a server-side domain authorization boundary.
Supabase session validity does not prove a local backend role or profile status.
Any future business integration must still enforce authorization on the server.

`src/lib/supabase/server.ts` creates a server-side Supabase client without
browser session persistence or automatic refresh. `src/lib/auth-cookies.ts`
owns `openslate_access` and `openslate_refresh`: HttpOnly, SameSite=Lax, path `/`,
and Secure in production. Browser JavaScript cannot read these cookies.

`src/lib/supabase/session.ts` distinguishes valid, confirmed-invalid, and
unavailable establishment. Missing required credentials and recognized revoked
or expired-session errors are invalid. Transport errors, provider failures, and
ambiguous results are unavailable. Session handlers preserve cookies on an
outage or deadline; a successful refresh preserves rotated cookies even if a
later upstream step fails.

| Handler        | Behavior                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login          | Same-origin, strict input schema, real password sign-in, safe failure response, and cookie establishment.                                                                                                                                                                                 |
| Status         | Authenticated result on success; unauthenticated result plus clearing for confirmed invalidity; 503/504 without clearing for unavailable/timeout.                                                                                                                                         |
| Logout         | Same-origin, best-effort provider sign-out, browser cookie clearing even during provider outage.                                                                                                                                                                                          |
| Realtime token | Same-origin, confirmed session establishment, short-lived token and no-store response; unavailable/timeout does not erase credentials.                                                                                                                                                    |
| Password setup | Validates matching passwords, establishes the session, updates the password, then calls the private invitation-acceptance path once. Policy rejection permits corrected input. A potentially completed mutation produces explicit uncertain-outcome guidance and is not silently retried. |
| Auth callback  | Exchanges a code or invite token, sets cookies, and redirects to setup; invalid input returns to login.                                                                                                                                                                                   |

Password setup retains entered values on recoverable pre-mutation failure. If the
password or acceptance outcome is uncertain, the UI directs the user to sign in
to confirm rather than submitting the mutation again. The generic BFF denies
`auth/invitations/accept`; setup is its dedicated browser-facing entry point.

## BFF and validated API client

`src/app/bff/[...path]/route.ts` exports GET, HEAD, POST, PATCH, PUT, DELETE, and
OPTIONS. It maps paths and query strings to `${BACKEND_URL}/api/`, forwards an
allowlist of headers, converts the access cookie to a Bearer header, and disables
upstream fetch caching. Unsafe methods require the same-origin check. Request
and response sizes, deadlines, request IDs, and file-transfer capacity are
controlled by the existing reliability helpers.

An upstream 401 permits one refresh and one replay of the original request.
Confirmed invalidity or a second 401 clears credentials; refresh unavailability
returns 503/504 without replay or clearing. Rotated cookies are retained if the
retried request later fails. Ordinary 403 responses do not trigger refresh.
There is no direct Next `/api` or API-documentation rewrite.

`src/lib/api.ts:apiFetch(path, schema, init)` requires a runtime Zod schema and
returns its inferred output. Every successful body is parsed and validated;
malformed JSON or a schema mismatch yields a safe `ApiContractError`, without
raw payloads or parser internals. A 204 supplies `null` to the caller's explicit
schema. Abort and transport failures retain their identities. Non-success
responses use the existing `ApiError` contract; a confirmed 401 navigates to
login. This prepares a reusable transport boundary without inventing future
business DTOs or endpoint shapes.

## UI, errors, and realtime

`src/components/app-shell.tsx` owns desktop navigation, a mobile Sheet, account
controls, the skip link, and the main content region. Feature controls use the
existing semantic tokens and local shadcn/Base UI wrappers. Neutral shared
workspace compositions live in `systems/shared/components/ui.tsx`; features do not import another
feature's presentation merely to obtain a button or field wrapper.

Forms keep validation and pending state with their feature. Associated labels,
inline errors, keyboard focus, dialog dismissal, and focus restoration remain
part of the control contract. The shared discard guard records a destination,
clears it on cancellation, and continues it once on acceptance. It is separate
from pending command guards.

`src/app/error.tsx` handles descendant render failures. `global-error.tsx`
provides its own html/body, native Retry, and home link, avoiding dependencies
on a failed root layout, providers, or styles. Error messages do not expose
exception details. `SampleRecovery` offers an explicit reset for incompatible
saved workspace content.

`globals.css` owns Tailwind 4 semantic colors, typography, surfaces, status,
spacing, density, and corner preferences in light and dark themes. Preferences
are browser-local rather than account data. Desktop tables and feature-owned
mobile presentations share domain results while retaining appropriate layouts.

Workspace routes do not mount `RealtimeProvider` or remount the shell on
invalidation events. The retained realtime infrastructure is not active business
synchronization for sample features. Any later integration must preserve private
Broadcast invalidation without row snapshots and retain in-progress drafts.

## Build, environment, and verification

`next.config.ts` enables standalone output, React Strict Mode, and typed routes.
`src/proxy.ts` applies CSP and security headers; it is not authentication
middleware. Page requests receive a nonce. The matcher excludes BFF/session,
auth callback, Next assets, and prefetch traffic. Development allows inline
styles for HMR; production keeps nonce-based CSP.

Local npm launchers generate allowlisted frontend settings from the canonical
root `.env`; root credentials are never sourced into the Next process. The
supported local stack is Supabase CLI plus host-run FastAPI and Next.js.
`infra/docker/frontend.Dockerfile` supplies a Node 24 standalone image with
public build configuration and runtime-only `BACKEND_URL`. It is an image recipe,
not a second local orchestration system. See [configuration](17-configuration.md).

The frontend gate owns formatting, lint, type checks, retained isolated and HTTP
tests, and one production build. Playwright Test runs these tests without browser
projects. Manual browser acceptance proves rendered interactions where needed;
there is no frontend numerical coverage or browser-suite gate. The root
`python3 scripts/prepush.py --base <base-ref>` selects the applicable checks.
See [testing architecture](16-testing-architecture.md) for runner ownership.

## Capability boundaries

| Capability                                                                                                       | Status                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Interactive seven-feature workspace, shared local persistence and async boundaries                               | Implemented with sample data.                          |
| Real sign-in, invitation setup, cookie sessions and BFF forwarding                                               | Implemented server boundaries.                         |
| Runtime-validated browser API helper                                                                             | Implemented; business integration remains future work. |
| Real workspace business persistence, server-backed reports, chat delivery, scheduling and account administration | Not implemented by the sample frontend.                |
| Client session gate as domain authorization                                                                      | Insufficient; backend authorization remains required.  |
| Active sample workspace realtime synchronization                                                                 | Absent.                                                |
| Browser-local appearance and local attachment objects                                                            | Implemented with local-only lifetime.                  |

This document describes current frontend ownership. It does not redefine backend
schemas, authorization, audit guarantees, deployment ownership, or test policy.
