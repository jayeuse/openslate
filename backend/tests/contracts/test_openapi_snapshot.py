"""The committed OpenAPI snapshot must match the application's generated document."""

from __future__ import annotations

import difflib

import pytest

from tests.contracts.export_openapi import (
    REFRESH_COMMAND,
    SNAPSHOT_PATH,
    build_openapi_document,
    render_document,
    snapshot_environment,
)

_DIFF_LINES = 80


def test_committed_openapi_snapshot_matches_the_application(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name, value in snapshot_environment().items():
        monkeypatch.setenv(name, value)
    generated = render_document(build_openapi_document())
    committed = SNAPSHOT_PATH.read_text(encoding="utf-8") if SNAPSHOT_PATH.is_file() else ""

    if committed != generated:
        diff = difflib.unified_diff(
            committed.splitlines(),
            generated.splitlines(),
            fromfile="contracts/openapi.json (committed)",
            tofile="contracts/openapi.json (generated)",
            lineterm="",
        )
        shown = "\n".join(line for _, line in zip(range(_DIFF_LINES), diff, strict=False))
        pytest.fail(
            "contracts/openapi.json is out of date with the FastAPI application. "
            f"Refresh it with `{REFRESH_COMMAND}` and review the diff.\n{shown}",
            pytrace=False,
        )
