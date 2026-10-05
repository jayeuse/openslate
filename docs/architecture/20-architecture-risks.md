# Architecture Risks

> **Scope:** Active engineering and operating risks with concrete mitigations.

| Risk | Current state | Mitigation required |
| --- | --- | --- |
| Workspace features are largely sample state | Visible UI behavior can differ from durable backend behavior | Connect features deliberately and verify their API authority and persistence contracts |
| Static UI and API must ship together | FastAPI serves the generated frontend export from the server image | Build the export into the matching server artifact and fail startup when `WEB_ASSETS_ROOT` is missing or invalid |
| Single-organization trust boundary | Each Compose installation serves one client; shared multi-tenant isolation is not implemented | Keep mutually untrusted organizations in separate deployments |
| Provider identity can be confused with application access | Supabase Auth authenticates; it does not assign OpenSlate roles or resource access | Require an explicit provider-subject/profile binding and evaluate current application eligibility and authorization in FastAPI on each request |
| Provider and application schema ownership can overlap | Supabase owns provider schemas; Alembic owns OpenSlate application schema | Keep migration scope and bootstrap/runtime grants explicit; test migrations against the pinned provider release without changing provider-owned objects |
| Storage and PostgreSQL updates are not atomic | File bytes live in provider Storage while metadata and file state live in PostgreSQL | Preserve immutable private ready objects, verify bytes and digests, fail closed on uncertainty, and reconcile split operations |
| Uploaded files are not checked for malware | Type validation proves a file is a real document or image, not that it is safe; a member can share a harmful file with others | Keep the type allowlist, bounded parsing, authorization, and attachment downloads with `nosniff`; rely on antivirus on each user's device |
| Installation recovery is only partially accepted | A guarded five-volume Restic restore with a separate target exercised database-only session finalization and post-restore application/file access using Linux containers on macOS Docker Desktop; native Linux host boot/reboot and Windows restore behavior remain pending | Verify host startup, restart, and restore on native Linux and Windows targets; retain off-host encrypted repository copies and document retention/key recovery |
| Windows operation is pending | The intended server path is Docker Desktop/WSL2 with Linux containers; no Windows host has completed acceptance | Verify startup, reboot, persistent volumes, ingress, and restore on a Windows host before claiming support as accepted |
| Readiness signals can overstate installation health | `/api/ready` reports database, Auth, Storage, and SMTP-configuration component states. A disposable production Compose rehearsal exercised bounded Auth and Storage failure/recovery paths, but SMTP presence is not delivery | Keep schema, mail-delivery, customer-specific TLS, host-platform, and release acceptance checks separate; verify the target installation before relying on readiness |
| Studio has broad operator authority | Supabase Studio replaces pgweb and is more privileged than the retired read-only inspector | Keep its access loopback-bound and authenticated; do not expose it as a public application surface |
| Email actions depend on provider SMTP | Invitations and recovery are delivered through Supabase Auth; OpenSlate has no local delivery outbox | Configure and monitor an installation-owned SMTP service and test failure/retry behavior |
| SSE events can be missed | PostgreSQL notifications are opaque invalidations, not durable client delivery | Treat authorized refetch/resynchronization as normal and recheck access on reconnect |
| Future Realtime use has unresolved access design | Supabase Realtime is not started; the current app uses authenticated SSE | Before adding it, decide how channel membership, role/group changes, revocation, and protected payloads stay consistent with FastAPI authorization |
| Hosted deployment is a separate product target | Current topology is one self-hosted Compose installation per client | Make explicit hosting, tenancy, operations, secret delivery, backup, and release decisions before implementing a hosted service |

These are current engineering risks, not evidence that a hosted product or fully
accepted client release is available.
