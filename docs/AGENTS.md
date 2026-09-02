# Documentation Guide

`docs/architecture/README.md` is the verified architecture index: it maps the
checked-in manifests, routes, models, migrations, configuration, scripts,
workflows, and tests to 21 numbered documents.

- Treat the architecture README as the authoritative reference. Before
  explaining architecture, read the relevant numbered document and cite it.
- Keep the implemented/partial/planned/absent/unknown classifications honest:
  when documented behavior changes, update the smallest existing document that
  covers it (with source paths/symbols) and rerun the documented checks.
- Do not create a new documentation file when an existing document has the
  correct scope. Do not update documentation for internal refactors that leave
  documented behavior unchanged.
- Test plans (for example `dynamic-field-validation-test-plan.md`) are recorded
  evidence with explicit non-goals and known boundaries — they are not
  authorization to redesign the behavior they test.
- Target deployment is single-tenant per client instance (micro–medium SMB,
  on-premise first, hosted instances later). This is design intent, not an
  implemented hosted deployment — keep the README's implemented/partial/
  planned/absent/unknown classifications honest, and do not document
  multi-tenant SaaS designs as if they exist.
