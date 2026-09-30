from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from operations.sample_population import (
    SamplePopulationError,
    create_private_run_directory,
    read_admin_password,
)


def test_private_run_directory_is_owner_only_and_never_reuses_a_run(tmp_path: Path) -> None:
    root = tmp_path / "sample-runs"
    run_id = "a" * 32

    run_directory = create_private_run_directory(root, run_id)

    assert run_directory == root / run_id
    if os.name != "nt":
        assert stat.S_IMODE(root.stat().st_mode) == 0o700
        assert stat.S_IMODE(run_directory.stat().st_mode) == 0o700
    with pytest.raises(SamplePopulationError, match="already exists"):
        create_private_run_directory(root, run_id)


def test_private_run_directory_rejects_path_traversal_and_symlink_roots(tmp_path: Path) -> None:
    with pytest.raises(SamplePopulationError, match="run ID"):
        create_private_run_directory(tmp_path / "runs", "../escape")
    outside = tmp_path / "outside"
    outside.mkdir()
    root_link = tmp_path / "linked-runs"
    root_link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(SamplePopulationError, match="owner-only"):
        create_private_run_directory(root_link, "b" * 32)


def test_admin_password_reader_requires_private_file_and_expected_identity(tmp_path: Path) -> None:
    path = tmp_path / "admin.json"
    path.write_text(
        json.dumps(
            {"email": "admin@example.test", "password": "secret-password", "state": "active"}
        ),
        encoding="utf-8",
    )
    if os.name != "nt":
        path.chmod(0o600)

    assert read_admin_password(path, "admin@example.test") == "secret-password"
    with pytest.raises(SamplePopulationError, match="does not match") as error:
        read_admin_password(path, "different@example.test")
    assert "secret-password" not in str(error.value)
    if os.name != "nt":
        path.chmod(0o644)
        with pytest.raises(SamplePopulationError, match="owner-only"):
            read_admin_password(path, "admin@example.test")
