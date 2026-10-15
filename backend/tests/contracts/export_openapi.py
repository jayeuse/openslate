"""Write the shared OpenAPI snapshot that the frontend adapter contract tests read.

Run from ``backend/``: ``uv run python -m tests.contracts.export_openapi``.
The document is built from ``create_app()`` with the synthetic isolated-test
settings, so it never depends on the caller's ``.env`` or a running server.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

from tests.config_support import settings_environment
from tests.repository import REPOSITORY_ROOT

SNAPSHOT_PATH = REPOSITORY_ROOT / "contracts" / "openapi.json"
REFRESH_COMMAND = "cd backend && uv run python -m tests.contracts.export_openapi"


def snapshot_environment() -> dict[str, str]:
    """The settings the snapshot is generated with; tests apply the same values."""

    return {**settings_environment(), "OPENSLATE_ENV_SOURCE": "process"}


def build_openapi_document() -> dict[str, Any]:
    """Build the OpenAPI document. The caller must apply ``snapshot_environment()`` first."""

    # Imported here: app.main builds its module-level app from the environment.
    from app.main import create_app

    return create_app().openapi()


def render_document(document: Mapping[str, Any]) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> None:
    os.environ.update(snapshot_environment())
    SNAPSHOT_PATH.write_text(render_document(build_openapi_document()), encoding="utf-8")
    print(f"Wrote {SNAPSHOT_PATH}")


if __name__ == "__main__":
    main()
