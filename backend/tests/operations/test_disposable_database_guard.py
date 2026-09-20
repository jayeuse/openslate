import json
import os
from secrets import token_urlsafe

import pytest

from tests.conftest import _guard_integration_database


@pytest.fixture
def disposable_target(tmp_path, monkeypatch):
    url = f"postgresql+psycopg://openslate_runtime:{token_urlsafe(32)}@127.0.0.1:49152/openslate"
    manifest = tmp_path / "database.json"
    manifest.write_text(json.dumps({"run_id": "a" * 32, "urls": [url]}))
    manifest.chmod(0o600)
    monkeypatch.setenv("OPENSLATE_TEST_DATABASE_MANIFEST", str(manifest))
    monkeypatch.setenv("E2E_ALLOW_MUTATIONS", "true")
    monkeypatch.setenv("OPENSLATE_FULLSTACK_RUN_ID", "a" * 32)
    return url


def test_only_run_owned_exact_disposable_target_is_accepted(disposable_target):
    _guard_integration_database(disposable_target)
    for unsafe in (
        disposable_target.replace("127.0.0.1", "localhost"),
        disposable_target.replace("127.0.0.1", "production.example"),
        disposable_target.replace("49152", "54322"),
        disposable_target.replace("/openslate", "/production"),
        disposable_target.replace("openslate_runtime", "other_role"),
        disposable_target.replace(":49152/openslate", ":49152/openslate?host=production.example"),
    ):
        with pytest.raises(RuntimeError):
            _guard_integration_database(unsafe)


@pytest.mark.parametrize(
    "missing",
    [
        "E2E_ALLOW_MUTATIONS",
        "OPENSLATE_FULLSTACK_RUN_ID",
        "OPENSLATE_TEST_DATABASE_MANIFEST",
    ],
)
def test_missing_run_authorization_refuses_before_connection(
    disposable_target, monkeypatch, missing
):
    monkeypatch.delenv(missing)
    with pytest.raises(RuntimeError):
        _guard_integration_database(disposable_target)


def test_changed_credentials_and_run_identity_are_rejected(disposable_target, monkeypatch):
    with pytest.raises(RuntimeError):
        _guard_integration_database(disposable_target.replace("@", "changed@"))
    monkeypatch.setenv("OPENSLATE_FULLSTACK_RUN_ID", "b" * 32)
    with pytest.raises(RuntimeError):
        _guard_integration_database(disposable_target)


@pytest.mark.parametrize("fixture_name", ["integration_db", "integration_owner_db"])
def test_swapped_authorized_roles_are_refused_before_connect(
    disposable_target, monkeypatch, fixture_name
):
    from pathlib import Path
    from unittest.mock import MagicMock

    from tests import conftest

    owner_url = disposable_target.replace("openslate_runtime", "postgres")
    manifest = Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"])
    manifest.write_text(json.dumps({"run_id": "a" * 32, "urls": [disposable_target, owner_url]}))
    monkeypatch.setenv("TEST_DATABASE_URL", owner_url)
    monkeypatch.setenv("MIGRATION_DATABASE_URL", disposable_target)
    engine = MagicMock(side_effect=AssertionError("Guard allowed a swapped role to connect"))
    monkeypatch.setattr(conftest, "create_engine", engine)
    fixture = getattr(conftest, fixture_name).__wrapped__()
    with pytest.raises(RuntimeError, match="runner-owned"):
        next(fixture)
    engine.assert_not_called()
