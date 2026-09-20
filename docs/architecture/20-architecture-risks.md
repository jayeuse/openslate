# Architecture Risks

> **Scope:** Active risks and concrete mitigations.

| Risk | Current state | Mitigation required |
| --- | --- | --- |
| Workspace features are largely sample state | Visible UI behavior can differ from durable backend behavior | Connect features deliberately and test their API contract |
| Native customer deployment is unproven | No signed installer, service management, or LAN matrix | Complete Windows/macOS packaged acceptance gates |
| Static UI and API must ship together | The FastAPI-only payload needs the matching generated frontend export | Build the export into the server artifact and fail startup when `WEB_ASSETS_ROOT` is missing or invalid |
| Recovery is only partially proven | Guarded encrypted backup creation exists, but real-tool full database/private-file recovery and Windows controls are unverified | Test restore on clean Windows/macOS targets and document key recovery |
| SMTP delivery depends on customer infrastructure | The optional encrypted outbox and worker are implemented; delivery is disabled by default and SMTP is at least once | Validate the selected SMTP service and make duplicate one-time-link delivery harmless |
| Filesystem and database backup must stay consistent | File bytes do not share a transaction with metadata | Snapshot/restore both stores together and verify representative files |
| Single organization trust domain | No shared-tenant isolation promise | Keep mutually untrusted organizations in separate deployments |
| SSE is invalidation only | Clients can miss an event | Treat resync/refetch as required normal behavior |
| Scanner availability is operationally sensitive | New files must not become readable on uncertainty | Keep quarantine and worker recovery fail closed |

These are current engineering risks, not evidence that a hosted product or installer is available.
