"""Per-process guard caches reuse a verdict only for the exact same inputs."""

import os
from pathlib import Path

import pytest

from tests import conftest, postgres_runtime

URL = "postgresql://openslate_runtime:synthetic@127.0.0.1:55432/postgres"


def _key(manifest: Path) -> tuple[object, ...]:
    values = {"OPENSLATE_TEST_DATABASE_MANIFEST": str(manifest)}
    return postgres_runtime._ownership_key(URL, "openslate_runtime", values)


def test_the_ownership_key_changes_with_the_manifest_file_not_only_its_contents(
    tmp_path: Path,
) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"run": "a"}')
    manifest.chmod(0o600)
    first = _key(manifest)
    assert _key(manifest) == first

    manifest.chmod(0o644)  # same bytes, different mode
    assert _key(manifest) != first
    manifest.chmod(0o600)
    assert _key(manifest) == first

    replacement = tmp_path / "replacement.json"
    replacement.write_text('{"run": "a"}')  # same bytes and mode, another file
    replacement.chmod(0o600)
    os.replace(replacement, manifest)
    assert _key(manifest) != first


def test_docker_answers_are_memoized_per_docker_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str | None, str | None]] = []

    def docker_json(_arguments):
        calls.append((os.environ.get("DOCKER_HOST"), os.environ.get("DOCKER_CONTEXT")))
        return [{"Id": "synthetic"}]

    monkeypatch.setattr(conftest, "_REAL_DOCKER_JSON", docker_json)
    monkeypatch.setattr(conftest, "_DOCKER_JSON_CACHE", {})
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)

    conftest._memoized_docker_json(["inspect", "synthetic"])
    conftest._memoized_docker_json(["inspect", "synthetic"])
    assert len(calls) == 1

    monkeypatch.setenv("DOCKER_CONTEXT", "other-context")
    conftest._memoized_docker_json(["inspect", "synthetic"])
    monkeypatch.setenv("DOCKER_HOST", "unix:///tmp/other-docker.sock")
    conftest._memoized_docker_json(["inspect", "synthetic"])
    assert calls == [
        (None, None),
        (None, "other-context"),
        ("unix:///tmp/other-docker.sock", "other-context"),
    ]
