"""Fixed release lookup remains bounded, cached and honest on unavailable metadata."""

import json
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError

import pytest

from operations.backup_runner import release_observation
from tests.operations.test_backup_runner import NOW, SyntheticCommands, execute, runner_config

SOURCE = "https://api.github.com/repos/jayeuse/openslate/releases/latest"
URL = "https://github.com/jayeuse/openslate/releases/tag/v0.2.0"


class ReleaseHTTP:
    def __init__(self, payload: Any = None, error: Exception | None = None) -> None:
        self.payload = (
            {"draft": False, "prerelease": False, "tag_name": "v0.2.0", "html_url": URL}
            if payload is None
            else payload
        )
        self.error = error
        self.requests: list[tuple[str, int]] = []
        self.bounds: list[int] = []

    def open(self, request: Any, *, timeout: int) -> "ReleaseHTTP":
        self.requests.append((request.full_url, timeout))
        if self.error:
            raise self.error
        return self

    def __enter__(self) -> "ReleaseHTTP":
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def read(self, size: int) -> bytes:
        self.bounds.append(size)
        return json.dumps(self.payload).encode()[:size]


def test_release_lookup_validates_stable_source_and_bounds_response() -> None:
    http = ReleaseHTTP()
    assert release_observation(opener=http) == {
        "version": "0.2.0",
        "release_url": URL,
        "failure_code": None,
    }
    assert http.requests == [(SOURCE, 10)]
    assert http.bounds == [65537]


@pytest.mark.parametrize(
    "change",
    [
        {"draft": True},
        {"prerelease": True},
        {"tag_name": "v0.2.0-beta"},
        {"html_url": "https://other.invalid/release"},
        {"tag_name": "v01.2.0"},
    ],
)
def test_invalid_release_cannot_become_current(change: dict[str, Any]) -> None:
    http = ReleaseHTTP()
    http.payload.update(change)
    assert release_observation(opener=http) == {
        "version": None,
        "release_url": None,
        "failure_code": "release_invalid",
    }


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (HTTPError(SOURCE, 404, "unavailable", None, None), "release_unavailable"),
        (TimeoutError("synthetic network timeout"), "release_timeout"),
    ],
)
def test_missing_or_timed_out_source_does_not_claim_current(error: Exception, code: str) -> None:
    assert release_observation(opener=ReleaseHTTP(error=error)) == {
        "version": None,
        "release_url": None,
        "failure_code": code,
    }


def test_failed_release_observation_is_checked_once_per_six_hours(tmp_path: Path) -> None:
    config, state = runner_config(tmp_path)
    commands = SyntheticCommands(config)
    commands.queue = False
    commands.last_release_checked_at = (NOW - timedelta(hours=7)).isoformat()
    loads: list[bool] = []

    def observe() -> dict[str, Any]:
        loads.append(True)
        return {"version": None, "release_url": None, "failure_code": "release_unavailable"}

    execute(config, state, commands, release_loader=observe)
    execute(config, state, commands, release_loader=observe)
    assert loads == [True]
    release = [item for item in commands.operations if item["op"] == "release"]
    assert len(release) == 1 and release[0]["version"] is None
    assert release[0]["failure_code"] == "release_unavailable"
