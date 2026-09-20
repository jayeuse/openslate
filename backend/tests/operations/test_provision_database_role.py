from unittest.mock import MagicMock

import pytest

from operations import provision_database_role as provisioner

BOOTSTRAP_URL = "postgresql://postgres:bootstrap@127.0.0.1:55322/openslate"
OWNER_URL = "postgresql+psycopg://openslate_owner:owner@127.0.0.1:55322/openslate"
RUNTIME_URL = "postgresql+psycopg://openslate_runtime:runtime@127.0.0.1:55322/openslate"
INSPECTOR_URL = (
    "postgresql+psycopg://openslate_inspector:inspector@127.0.0.1:55322/openslate"
)


def _database() -> tuple[MagicMock, MagicMock]:
    connection = MagicMock()
    cursor = MagicMock()
    connection.__enter__.return_value = connection
    connection.cursor.return_value.__enter__.return_value = cursor
    cursor.fetchone.side_effect = [
        (False,),
        (False,),
        (False,),
        (False,),
        (True, False, False, False, False, False, False),
        (False, False, False, False, False, False, False),
        (True, True, False, False, False, False, False),
        (True, False, False, False, False, False, False),
        (False, True, False),
        (provisioner.OWNER_ROLE, False),
    ]
    cursor.fetchall.side_effect = [
        [("inherit_option",), ("set_option",)],
        [(provisioner.RUNTIME_ROLE, provisioner.PRIVILEGE_ROLE, False, True, False)],
    ]
    return connection, cursor


def _statements(cursor: MagicMock) -> str:
    return "\n".join(str(call.args[0]) for call in cursor.execute.call_args_list).casefold()


def test_provision_creates_safe_owner_app_and_runtime_roles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database()
    connect = MagicMock(return_value=connection)
    monkeypatch.setattr(provisioner, "connect", connect)

    provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL, INSPECTOR_URL)

    connect.assert_called_once_with(BOOTSTRAP_URL)
    statements = _statements(cursor)
    for role in (
        provisioner.OWNER_ROLE,
        provisioner.PRIVILEGE_ROLE,
        provisioner.RUNTIME_ROLE,
        provisioner.INSPECTOR_ROLE,
    ):
        assert role in statements
    assert "alter database" in statements
    assert "revoke all on database" in statements
    assert "grant connect on database" in statements
    assert "with inherit true, set false" in statements
    assert "grant select on all tables in schema" in statements
    assert "alter default privileges" in statements


def test_provision_rotates_existing_managed_login_role_passwords_after_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database()
    cursor.fetchone.side_effect = [
        (True,),
        (True,),
        (True,),
        (True,),
        (True, False, False, False, False, False, False),
        (False, False, False, False, False, False, False),
        (True, True, False, False, False, False, False),
        (True, False, False, False, False, False, False),
        (False, True, False),
        (provisioner.OWNER_ROLE, False),
    ]
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL, INSPECTOR_URL)

    statements = _statements(cursor)
    assert "alter role" in statements
    assert statements.count("password") == 3


@pytest.mark.parametrize(
    ("bootstrap", "owner", "runtime"),
    [
        (BOOTSTRAP_URL, OWNER_URL.replace("/openslate", "/other"), RUNTIME_URL),
        (BOOTSTRAP_URL.replace("127.0.0.1", "other-host"), OWNER_URL, RUNTIME_URL),
        (OWNER_URL, OWNER_URL, RUNTIME_URL),
    ],
)
def test_provision_rejects_mismatched_or_non_admin_bootstrap_urls(
    monkeypatch: pytest.MonkeyPatch, bootstrap: str, owner: str, runtime: str
) -> None:
    connect = MagicMock()
    monkeypatch.setattr(provisioner, "connect", connect)

    with pytest.raises(SystemExit):
        provisioner.provision(bootstrap, owner, runtime, INSPECTOR_URL)

    connect.assert_not_called()


def test_provision_fails_closed_for_existing_unsafe_runtime_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database()
    cursor.fetchone.side_effect = [
        (True,),
        (False,),
        (False,),
        (False,),
        (True, False, False, False, False, False, False),
        (False, False, False, False, False, False, False),
        (True, True, False, False, False, False, True),
    ]
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="openslate_runtime role has unsafe attributes"):
        provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL, INSPECTOR_URL)

    assert "alter database" not in _statements(cursor)


def test_provision_rejects_runtime_membership_in_owner_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database()
    cursor.fetchall.side_effect = [
        [("inherit_option",), ("set_option",)],
        [
            (provisioner.RUNTIME_ROLE, provisioner.OWNER_ROLE, False, True, False),
            (provisioner.RUNTIME_ROLE, provisioner.PRIVILEGE_ROLE, False, True, False),
        ],
    ]
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="unsafe membership"):
        provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL, INSPECTOR_URL)

    assert "alter database" not in _statements(cursor)
