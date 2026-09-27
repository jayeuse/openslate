FROM node:24-alpine AS frontend-builder

WORKDIR /workspace/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
COPY contracts/ /workspace/contracts/
RUN npm run build


FROM python:3.14-slim AS backend-builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /uvx /bin/

WORKDIR /app

COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev

COPY backend/ ./

FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH" \
    OPENSLATE_ENV_SOURCE=process \
    WEB_ASSETS_ROOT=/app/web

WORKDIR /app

RUN useradd --create-home --uid 10001 appuser
COPY --from=backend-builder --chown=appuser:appuser /app /app
COPY --from=frontend-builder --chown=appuser:appuser /workspace/frontend/out /app/web
COPY --chown=appuser:appuser infra/supabase/templates/ /infra/supabase/templates/

USER appuser

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ['BACKEND_PORT'] + '/api/health', timeout=2).read()"]
CMD ["python", "-m", "app"]
