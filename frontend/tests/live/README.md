# Local live integrity suite

This opt-in suite mutates only a disposable, loopback OpenSlate environment. It
is excluded from `npm run verify` and cannot run in CI or against non-loopback
origins.

## Prerequisites

1. Start local Supabase and the FastAPI backend, with Alembic at head.
2. Start the backend with `LIFECYCLE_PURGE_ENABLED=true` only when domain purge
   teardown is intended. The suite never enables purge itself.
3. Leave the frontend port free. The live Playwright config starts a fresh
   Next.js development server bound to `127.0.0.1`; it never reuses an existing
   process or a production build.
4. Use an existing active administrator. The suite never creates users or
   roles.

After sourcing the root `.env`, configure the live-only values without placing
secrets on the command line:

```sh
export LIVE_BASE_URL=http://127.0.0.1:3000
export LIVE_API_BASE_URL=http://127.0.0.1:8000
export BACKEND_URL="$LIVE_API_BASE_URL"
export LIVE_ADMIN_EMAIL='<local-admin-email>'
export LIVE_ADMIN_PASSWORD='<local-admin-password>'
export LIVE_RUN_ID="run-$(date -u +%Y%m%dt%H%M%Sz)-$(openssl rand -hex 16)"
export LIVE_SCALE=standard # standard or extended
```

`NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` must also be present. Only a modern
publishable key or a legacy JWT with the `anon` role is accepted; secret and
service-role keys are rejected.

## Execute

Run the department-first seed, integrity checks, and support tests without
purge:

```sh
unset LIVE_TEARDOWN
npm run test:e2e:live
```

The mutation phases are serialized by their numbered spec names:

1. `01-seed-schema.spec.ts` — one department-first pass for schema, UI/API
   records, and relationship edges
2. `03-relationship-integrity.spec.ts` — UI/API integrity and audit checks
3. `04-teardown.spec.ts` — skipped unless purge is explicitly enabled below

Within the seed phase, each department is completed before the next starts:
create the department, all modules, primitive and relationship fields, accept
the module schemas, create UI records 1–2, create API volume records 3..target,
create representative UI relationship edges, create remaining API relationship
edges, then continue to the next department. Departments without relationship
definitions skip relationship-field creation and both relationship-edge steps.

To perform manifest-exact domain teardown after a successful run:

```sh
export LIVE_TEARDOWN=domain-purge
export LIFECYCLE_PURGE_ENABLED=true
npm run test:e2e:live -- tests/live/04-teardown.spec.ts
```

Teardown aborts on incomplete journals, catalog drift, unexpected rows or
relationships, actor changes, lifecycle blockers, or mismatched purge audit
evidence. It removes only manifest-owned domain rows. Immutable audit history
is intentionally retained, so this is not a full environment reset.

## Artifacts

Private, ignored artifacts are written to:

```text
test-results/live/<run-id>/manifest.json
test-results/live/<run-id>/report-state.json
test-results/live/<run-id>/test-report.md
```

Playwright's auto-cleaned runner output is kept separately under
`test-results/live-playwright/`, so a later teardown-only command cannot erase
the persistent manifest.

Credentials, cookies, access tokens, and full record payloads must never be
added to these artifacts. If a mutation remains `running`, do not retry it or
edit the manifest; dispose of/reset the local target instead.
