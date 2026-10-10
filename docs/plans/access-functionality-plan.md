# Access page contracts and implementation status

## Authority and historical scope

The former Draft 5 plan described a seven-view rollout with custom roles,
detailed rules and metadata-only service identities. That proposal and its
CTRL-01–28 inventory are historical, not current implementation authority.
The [schema redesign](schema-redesign-plan.md) replaced those resources with
three account roles and group access. [Tier 1](system-completion-tier-1.md) and
[Tier 2](system-completion-tier-2.md) extend the delivered People and Security
controls. This document describes the present surface; it grants no new
implementation, migration, deployment or database access.

## Current views

The [`AccessPage`](../../frontend/src/components/systems/access/page.tsx)
recognizes four `view` values: `overview`, `people`, `groups`, and `security`.
Administrators see all four. A non-guest department manager sees only Groups
and only groups inside the server's delegated scope. People are accounts, not
services. Roles are the fixed values `admin`, `member`, and `guest`; there is
no custom-role editor, rules grid or service-identity view.

| View | Implemented controls | Source and observable contract |
|---|---|---|
| Overview | Account/access summary and attention findings | [Overview](../../frontend/src/components/systems/access/components/overview-view.tsx) and [user API](../../backend/app/systems/access/users/router.py) derive counts from current eligible accounts. Summary cutoffs and People drilldowns use the same filters, not the visible page. Null recorded sign-in/activity does not prove a person has never signed in. |
| People | Server-paged directory, search/filter/sort, invitations, Account/Access/Sessions/Security person panel | [People](../../frontend/src/components/systems/access/components/people-view.tsx), [person panel](../../frontend/src/components/systems/access/components/person-panel.tsx), and [typed API](../../frontend/src/components/systems/access/state/api.ts) retain explicit loading, retry, denied, draft and pending states. Invitation settings govern new invitations, not existing accounts. |
| Groups | Group name/description, membership, department/module access rows | [Groups](../../frontend/src/components/systems/access/components/groups-view.tsx) and [configuration routes](../../backend/app/systems/access/policy/configuration_router.py) use conditional writes. Administrators change group metadata/access; an eligible manager may replace members only where every live access row falls inside departments they manage. A group with no access rows remains administrator-only. |
| Security | Organization sign-in policy, session inventory/revocation, link to security events in Manage › Audit | [Security](../../frontend/src/components/systems/access/components/security-view.tsx) connects the existing server policy, MFA and session controls. Its “View security events in Audit” link opens the administrator-only feed in Manage, separate from application ORM audit. |

The [access function](../../backend/app/systems/access/policy/scope.py) is the
single authority: the most specific row per group wins, then the highest level
across groups; no row means no access, and a guest is capped at read.
Board scope/group checks and captured Report-run eligibility remain additional
boundaries; posts and events have no separate content audience.
See [authentication and authorization](../architecture/08-authentication-authorization.md).

## Preserved safety and interaction contracts

- [Account coordination](../../backend/app/systems/access/users/coordination.py)
  preserves last-usable-administrator protection, including expiry and
  concurrent account removals. Provider identity alone grants no app role.
- Group member/access replacement and metadata edits use server `If-Match`
  preconditions. Draft 5's rule-targeted group-delete decision is superseded:
  its rule resource no longer exists; current deletion follows the current
  group service and its real dependencies, never an implicit policy-rule purge.
- [Draft navigation](../../frontend/src/components/systems/access/state/draft-navigation.tsx)
  and the page's workspace guard own unfinished current editors. Keep pending
  commands serialized, retain rejected drafts, and never auto-apply an edit
  after navigation or session verification. The retired five-editor journal
  proposal is not a claim that those removed editors still exist.
- Person Sessions/Security uses bound account and target identities; a denied
  fresh read cannot keep another person's previous security data visible.
- People data is server-paged. Counts, filtering, summaries and exports cannot
  be inferred from a single loaded page.
- No browser control changes provider credentials directly. Self-service
  recovery and administrator recovery use the documented server paths.

## Schema, recovery and acceptance limits

The historical Access revisions belong to the archived migration history, not
the active graph. Fresh installations start at
[`089c54b88aa6`](../../backend/migrations/versions/089c54b88aa6_schema_redesign_fresh_root.py)
and apply forward revisions. See [data architecture](../architecture/06-data-architecture.md)
and [recovery compatibility](access-recovery-compatibility.md). Neither stamping
an old installation onto that root nor a destructive downgrade is recovery.

Checks must use owned disposable Supabase/PostgreSQL resources and the
[testing architecture](../architecture/16-testing-architecture.md). Browser
HTTP fixtures prove frontend behavior only; database safety and provider
admission require their real boundaries. The [known gaps](../reviews/known-gaps.md)
retain unresolved fixture, dependency and acceptance work. Native Linux/Windows
operation and release approval remain separate; this status is not a release
sign-off.
