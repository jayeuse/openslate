"""The ``remove`` command refuses to delete while the API runs and needs an exact digest."""

from __future__ import annotations

import json
from contextlib import nullcontext
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest

from operations import seed_sample_data as commands
from operations.reset.models import ResetError
from operations.sample import removal

VALUES = {
    "ENVIRONMENT": "development",
    "MIGRATION_DATABASE_URL": "postgresql+psycopg://openslate_owner:fixture-only@127.0.0.1:1/x",
    "ADMIN_EMAIL": "operator@example.test",
    "SUPABASE_URL": "http://127.0.0.1:58000",
    "SUPABASE_SECRET_KEY": "fixture-only",
    "BACKEND_BIND_HOST": "127.0.0.1",
    "BACKEND_PORT": "8000",
}


@pytest.fixture
def remove_events(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    events: list[Any] = []
    plan = SimpleNamespace(
        slugs=("sample-school", "sample-school-partner"), organization_ids=(),
        removable_user_ids=(), kept_member_ids=(), provider_account_ids=(),
        storage_object_keys=(), null_organization_deletions={}, retained={},
        target_counts={"organizations": 2}, impact_digest="digest-a",
    )  # fmt: skip
    monkeypatch.setattr(commands, "_environment_values", lambda: (VALUES, object()))
    monkeypatch.setattr(removal, "_validated_database_url", lambda *_args: "postgresql://x")
    monkeypatch.setattr(removal, "connect", lambda _url: nullcontext(Mock()))
    monkeypatch.setattr(removal, "assert_psycopg_target", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(removal, "list_domain_accounts", lambda *_args: ())

    def build(_connection: object, **kwargs: Any) -> object:
        events.append(("plan", kwargs["slugs"]))
        return plan

    def apply(_connection: object, _plan: object, **kwargs: Any) -> dict[str, float]:
        events.append(("apply", kwargs["confirmation"]))
        return {"delete_users": 0.5}

    monkeypatch.setattr(removal, "build_organization_removal_plan", build)
    monkeypatch.setattr(removal, "require_api_stopped", lambda *_args: events.append("stopped"))
    monkeypatch.setattr(removal, "apply_organization_removal", apply)
    return events


def test_remove_executes_only_after_the_api_is_confirmed_stopped(remove_events: list[Any]) -> None:
    status = commands.main(
        ["remove", "--organization", "school", "--execute", "--confirm-digest", "digest-a"]
    )

    assert status == 0
    assert remove_events == [
        ("plan", ("sample-school", "sample-school-partner")), "stopped", ("apply", "digest-a"),
    ]


def test_remove_dry_run_changes_nothing(
    remove_events: list[Any], capsys: pytest.CaptureFixture[str]
) -> None:
    assert commands.main(["remove", "--organization", "school"]) == 0
    assert remove_events == [("plan", ("sample-school", "sample-school-partner"))]
    assert "impact_digest=digest-a" in capsys.readouterr().out


def test_remove_refuses_a_digest_without_execute(
    remove_events: list[Any], capsys: pytest.CaptureFixture[str]
) -> None:
    assert commands.main(["remove", "--organization", "school", "--confirm-digest", "d"]) == 2
    assert "--confirm-digest requires --execute" in capsys.readouterr().err
    assert remove_events == []


def test_remove_lists_auth_accounts_of_the_pack_domains_only() -> None:
    accounts = [
        {"id": "0190a000-0000-7000-8000-000000000001", "email": "Admin@School.Test",
         "app_metadata": {"openslate_user_id": "0190a000-0000-7000-8000-0000000000aa"}},
        {"id": "0190a000-0000-7000-8000-000000000002", "email": "admin@harbor.test"},
    ]  # fmt: skip
    auth = Mock()
    auth._request.return_value = (200, json.dumps({"users": accounts}).encode())

    listed = removal.list_domain_accounts(auth, frozenset({"school.test"}))

    assert [(str(item.id), item.email, str(item.openslate_user_id)) for item in listed] == [
        ("0190a000-0000-7000-8000-000000000001", "admin@school.test",
         "0190a000-0000-7000-8000-0000000000aa"),
    ]  # fmt: skip
    auth._request.return_value = (200, b'{"users": [{"id": "not-a-uuid", "email": "a@b"}]}')
    with pytest.raises(ResetError, match="invalid"):
        removal.list_domain_accounts(auth, frozenset({"school.test"}))
