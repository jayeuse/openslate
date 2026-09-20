# Testing Architecture

> **Scope:** Required repository checks and unverified deployment evidence.

Backend changes use focused pytest cases while repairing, then the affected batch. The backend coverage gate uses the disposable PostgreSQL runner at the current Alembic head, Ruff, mypy, and the configured changed-line/overall coverage thresholds. Database behavior is never substituted with SQLite.

Frontend changes use formatting, ESLint, TypeScript, retained isolated tests, and a production build at the frontend gate. Browser rendering is not a configured frontend coverage gate; run a targeted browser acceptance check when a runnable UI change needs visual or interaction evidence. Add an HTTP test only when a real Next.js request boundary exists.

The root `python3 scripts/prepush.py --base <base-ref>` command selects the applicable final gate. Documentation-only edits require a final diff review, exact terminology search where relevant, and `git diff --check`; they do not require application tests.

Native Windows/macOS installation, Caddy runtime validation where the binary is absent, production TLS, bundled database restart, backup/restore, and LAN/PWA matrix evidence remain unverified until their specific acceptance environment exists.
