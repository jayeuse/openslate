"""Supported FastAPI process entrypoint with explicit server configuration."""

from __future__ import annotations

import argparse

import uvicorn

from app.core.config import get_settings


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the OpenSlate API")
    parser.add_argument(
        "--reload", action="store_true", help="reload source changes for local development"
    )
    options = parser.parse_args(argv)
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.backend_bind_host,
        port=settings.backend_port,
        limit_concurrency=settings.server_max_concurrency,
        timeout_keep_alive=settings.server_keep_alive_seconds,
        reload=options.reload,
        access_log=False,
    )


if __name__ == "__main__":
    main()
