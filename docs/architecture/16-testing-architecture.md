# Testing Architecture

> **Scope:** Test ownership, execution layers, local selection, and CI gates.
> **Audience:** Developers deciding how to verify a change.
> **Related documents:** [Backend architecture](04-backend-architecture.md), [Frontend architecture](05-frontend-architecture.md), [Security](14-security-architecture.md), [Deployment](12-deployment-architecture.md)

## Verification order

1. Define the changed behavior and smallest proving layer.
2. During implementation, run the focused case and then its affected batch.
3. Before push, run the applicable project gate once.
4. If a gate fails, fix and rerun only that gate while its other evidence remains valid.

Frontend verification deliberately has no browser automation, full-stack browser
journey, or numerical coverage target. Deployment confidence comes from static
analysis, 181 isolated product/security tests, three HTTP boundary tests, and one
production build. Backend and infrastructure retain their existing database,
coverage, container, scanner, and runtime guarantees.

## Ownership and layers

Backend tests use pytest and live under `backend/tests/`. The `integration` marker
owns behavior that requires real PostgreSQL, including privileges, migrations,
transactions, locking, and concurrency. Disposable database guards and generated
credentials remain mandatory. Backend coverage continues to require 90% overall
and 90% changed executable production lines.

Frontend tests use Playwright Test as a lightweight Node/HTTP runner; CI does not
install or launch Playwright browsers.

| Frontend layer | Purpose                                                                                                 | Runtime                              |
| -------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `isolated`     | Pure rules, state transitions, security boundaries, serialization, and server helpers with replaced I/O | Node only                            |
| `http`         | Requests against actual Next.js session and BFF route handlers                                          | One local Next.js server; no browser |

Frontend sections are `public`, `security`, `shell`, `sample`, `sandbox`, and
`runtime`. Shared or unrecognized frontend changes select all retained sections.
No matching tests in a requested section is reported explicitly.

## Commands

From the repository root:

```sh
python3 scripts/test.py backend section security --layer isolated
python3 scripts/test.py backend section runtime --layer integration --interactive
python3 scripts/test.py backend affected --layer isolated
python3 scripts/test.py backend full
```

From `frontend/`:

```sh
npm run test:section -- security --layer isolated
npm run test:section -- security --layer http
npm run test:affected -- --layer isolated
npm run test:full
npm test
npm run verify
```

`--list` previews selected files without starting tests. `affected` includes
committed branch changes from an optional `--base`, plus staged, unstaged,
deleted, and untracked files. Section/affected runs accept `--match`; full mode
rejects local filters.

`npm test` runs all 184 retained frontend tests. `npm run verify` runs formatting,
ESLint, TypeScript, those tests, and one production build.

## Pre-push and CI

The canonical local command remains:

```sh
python3 scripts/prepush.py --base <revision>
```

For frontend changes it runs `npm run check`, `npm test`, and one production
build. If frontend container inputs changed, the container build replaces the
native build and the environment boundary is inspected. It does not run frontend
coverage, browser tests, full-stack browser acceptance, Supabase, or scanner work.

`.github/workflows/frontend.yml` exposes one stable required check, `Frontend /
verify`. It installs dependencies once and runs the same lean frontend gate in a
single job. Container validation is conditional. It uploads no artifacts.

Backend CI remains separately responsible for Ruff, mypy, disposable PostgreSQL
coverage, and its container. Infrastructure checks remain separately responsible
for deployment definitions. Frontend-only files and frontend workflow files do
not select backend or infrastructure gates.

## Maintenance rules

- Add isolated tests for meaningful rules, security behavior, state transitions,
  parsing, serialization, and failure handling.
- Add HTTP tests only when the real Next.js request boundary matters.
- Do not add browser, mobile, cross-browser, visual, or frontend full-stack suites.
- Do not add frontend line-coverage collection or artifact retention.
- Keep test outputs, caches, and local environment files outside version control.
- Preserve backend disposable-database, scanner, and coverage protections.
