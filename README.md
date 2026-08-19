# OpenSlate

OpenSlate is a self-hosted foundation for configurable business operations. This repository is a full-stack scaffold with a Next.js frontend, FastAPI API, PostgreSQL persistence, local file storage, and a Caddy edge proxy.

## Stack

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui foundations, Zod
- Backend: Python 3.12+, FastAPI, Pydantic, SQLAlchemy, Alembic
- Data: PostgreSQL with JSONB support, local filesystem storage
- Security: local username/password authentication with Argon2, JWT bearer tokens, RBAC foundations
- Auditing: transactional ORM CRUD audit logs with minimal before/after JSONB diffs and sensitive-value redaction
- Operations: Docker Compose and Caddy
- Tests: Pytest and Playwright

## Quick Start

1. Create local configuration:

   ```bash
   cp .env.example .env
   ```

2. Replace `POSTGRES_PASSWORD` and `SECRET_KEY` in `.env`. Generate a secret with `openssl rand -hex 32`.

3. Build and start the stack:

   ```bash
   docker compose up --build
   ```

4. Open the application at <http://localhost:8080>, API documentation at <http://localhost:8080/docs>, and Adminer at <http://localhost:8081>.

The backend applies Alembic migrations before starting. PostgreSQL data uses a named volume; uploaded files belong under the host `storage/` directory.

For Adminer, select `PostgreSQL`, use `postgres` as the server, and enter the `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` values from `.env`. Adminer is bound to the local machine only and is not routed through Caddy.

## Local Development

Start PostgreSQL and Adminer only:

```bash
docker compose up -d postgres adminer
```

Run the backend from `backend/`:

```bash
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

Run the frontend from `frontend/` in another terminal:

```bash
npm ci
npm run dev
```

Next.js proxies browser requests under `/api/*` to `BACKEND_URL`, which defaults to `http://localhost:8000`.

## Audit Logs

Application ORM creates, updates, hard deletes, and soft deletes are recorded in PostgreSQL `audit_logs` rows in the same transaction as the business change. Update `before` and `after` values contain only changed fields; nested JSON objects are diffed recursively. Passwords, tokens, secrets, credentials, and private keys are always represented as `[REDACTED]`.

Audit logs are queryable by administrators through `GET /api/audit-logs` and `GET /api/audit-logs/{id}`. The list endpoint supports action, entity type, entity ID, actor UUID, request, date, and cursor filters. `performed_by` is a nullable foreign key to `users.id`; it becomes null when the actor is deleted so historical audit rows remain available.

The selected boundary is application ORM writes only. Adminer, direct SQL, Alembic, and external database clients are not audited. Bulk and raw ORM mutation statements are rejected because they cannot produce reliable per-record before/after snapshots.

To run the PostgreSQL audit integration tests:

```bash
TEST_DATABASE_URL=postgresql+psycopg://openslate:password@localhost:5432/openslate \
  uv run pytest tests/test_audit_integration.py
```

## Verification

Backend, from `backend/`:

```bash
uv run ruff check .
uv run mypy app
uv run pytest
```

Frontend, from `frontend/`:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

Run one backend test with `uv run pytest tests/test_health.py`. Run one browser test with `npm run test:e2e -- tests/home.spec.ts --project=chromium`.

## Architecture

- `backend/app/core/` owns configuration, database wiring, security primitives, and middleware.
- `backend/app/common/` contains shared dependencies, exceptions, and utilities.
- `backend/app/systems/` is organized by business capability. `auth`, `users`, `departments`, `modules`, `fields`, and `records` provide the persistence layer; CRUD routers for the configurable-data entities are intentionally deferred.
- `backend/migrations/` is the only supported path for schema changes.
- Domain SQLAlchemy models inherit `backend/app/core/base_model.py`, which provides UUIDv7 IDs and shared lifecycle/audit columns. `AuditLog` is the immutable exception because its schema is exact and has no mutable lifecycle columns.
- `backend/app/systems/audit/` owns transactional ORM listeners, JSONB before/after diffing/redaction, and admin-only audit-log queries. `AuditLog` is append-only and excluded from its own audit stream.
- `frontend/src/app/` contains App Router routes; reusable shadcn-style primitives live under `frontend/src/components/ui/`.
- `infra/` owns deploy images and Caddy/PostgreSQL configuration. Root `docker-compose.yml` is the local deployment entrypoint.
