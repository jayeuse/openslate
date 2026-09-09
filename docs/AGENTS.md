# Documentation Guide

- `docs/architecture/README.md` is the authoritative verified architecture index, mapping checked-in manifests, routes, models, migrations, configuration, scripts, workflows, and tests to 21 numbered documents.
- Before explaining architecture, read and cite the relevant numbered document.
- Keep implemented/partial/planned/absent/unknown classifications honest. When documented behavior changes, update the smallest existing document with source paths/symbols and rerun its documented checks.
- Do not create a document when an existing one has the right scope; do not update documentation for internal refactors that preserve documented behavior.
- Docs explain system architecture, behavior, contracts, and workflows. Do not add test-run results, review findings, dated verification snapshots, task handoffs, or task-specific waivers. Test plans describe how testing works and its boundaries; they are not execution logs.
- Target deployment is single-tenant per client (micro–medium SMB, on-premise first, hosted later). This is design intent, not implemented hosted deployment; never describe multi-tenant SaaS as existing.
