# Current state and remaining gaps

## Current implementation

This is the consolidated current-state document for Access, Boards/OpenView and
the Supabase installation. It replaces the seven historical review documents;
their checkpoint findings and execution history remain in Git, not as present
product requirements. No historical Pass/Fail count or stopped run is a release
verdict for the current code.

- Access has Overview, People, Groups and Security. Fixed account roles and
  department/module group levels replace custom roles, detailed rules and
  service identities. See [Access contracts](../plans/access-functionality-plan.md)
  and [authorization](../architecture/08-authentication-authorization.md).
- Boards has server-backed company/department/project scopes, posts and
  published revisions, events/reminders, widgets, links and private attachments.
  OpenView has shared Views/Charts, department Dashboards, Reports/runs/schedules
  and live record actions. See [Boards/OpenView contracts](../plans/boards-openview-functionality-plan.md).
- Supabase owns Auth and Storage. FastAPI owns application admission,
  revocable sessions, authorization, private-file delivery and SSE; Alembic owns
  only application schema. Files become ready in the validated upload request;
  there is no antivirus scanner or local filesystem adapter. See
  [data architecture](../architecture/06-data-architecture.md) and
  [infrastructure](../architecture/11-infrastructure.md).

## Acceptance gaps

These are current acceptance obligations, not authorization to repair another
slice or weaken a gate. Test-source links identify the affected contracts;
runtime evidence belongs in the run records.

### KI01 — authenticated sign-out fixtures

Some self-signout HTTP fixtures expect `/login` while their subsequent session
response still says authenticated. The affected Access cases are
`self committed recovery signs out even when read-back fails` and
`known self revocation signs out after a partial email outcome` in
[`access-person-security.spec.ts`](../../frontend/tests/http/access-person-security.spec.ts#L457),
with the default session response in
[`helpers/access-api.ts`](../../frontend/tests/http/helpers/access-api.ts#L391).
Platform's [current-session sign-out/cleanup tests](../../frontend/tests/http/platform-account-controls.spec.ts#L512)
also retain authenticated fixture responses. Reconcile the intended
post-revocation unauthenticated fixture and run the affected journeys at final
acceptance. This is test evidence debt, not an established product authorization
vulnerability or a claim that native logout failed. Do not change auth policy
to make an authenticated mock satisfy a sign-in URL assertion.

### KI02 — frontend dependency advisories

Frontend dependency-advisory remediation remains pending in the unchanged
[`package-lock.json`](../../frontend/package-lock.json). Resolve the relevant
advisories with compatible, scoped dependency changes and verify the affected
integration before release. This document performs no audit, proposes no
speculative version upgrade, and claims no fresh advisory inventory.

### KI03 — switch geometry at large text

The appearance switch at 125% text with spacious density has an unresolved
thumb/track mismatch (20 px thumb versus 19.1875 px track). The contract is
[`appearance switches keep their thumbs inside the track and a 44 pixel hit area at density extremes`](../../frontend/tests/http/user-theme-preferences.spec.ts#L1234).
Final acceptance must resolve containment without reducing the hit area,
disabling large text or weakening the geometry assertion.

### KI04 — recovery tests need the independent audit database boundary

Two [`test_auth_recovery_contracts.py`](../../backend/tests/auth/test_auth_recovery_contracts.py)
cases require a database for their independently committed security/audit events
even when selected outside integration:
`test_recovery_completes_with_provider_password_update_without_app_session` and
`test_recovery_request_has_identical_response_for_known_and_unknown_emails`.
Reconcile their fixture/selection boundary while preserving the actual commit
contract and non-enumerating response. This is not permission to suppress audit
or reinterpret a missing database as a product recovery failure.

## Deployment and recovery acceptance

The target remains one self-hosted Compose stack per client. A guarded
Linux-container backup/restore and bounded dependency-failure rehearsal on macOS
Docker Desktop establishes that Compose path, not native server certification.
Native Linux host boot/reboot and Windows Docker Desktop/WSL2 startup, reboot,
persistent-volume and restore acceptance remain pending. macOS is a development
workstation, not a supported server target. Follow the
[version 3 restore procedure](../../infra/supabase/RESTORE.md),
[deployment state map](../architecture/12-deployment-architecture.md#deployment-state-map)
and [recovery compatibility](../plans/access-recovery-compatibility.md).

Canonical release checks and whole-branch acceptance remain distinct from
completed feature slices. Real populated browser→API→database/provider journeys,
required coverage, static/build checks and target-host acceptance cannot be
replaced by synthetic HTTP fixtures, screenshots, readiness responses or old
review summaries. See [testing architecture](../architecture/16-testing-architecture.md).

## Deliberate product and operating limits

OpenComms remains an example-only browser runtime; wider trigger actions,
record/field-level access, formula fields and additional sample packs remain
outside delivered scope. Hosted multitenancy and Supabase Realtime are not
implemented. Storage and PostgreSQL are separate failure boundaries; uploaded
documents receive type validation, not malware certification. These are
documented limits, not newly discovered defects or new implementation promises.
See [architecture risks](../architecture/20-architecture-risks.md),
[the glossary](../architecture/21-glossary.md), and
[sample-pack limits](../plans/sample-organization-packs.md#product-gaps-found-by-the-research).
