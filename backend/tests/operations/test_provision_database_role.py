from secrets import token_urlsafe
from unittest.mock import MagicMock

import pytest

from scripts import provision_database_role as provisioner

OWNER_PASSWORD = token_urlsafe(32)
RUNTIME_PASSWORD = token_urlsafe(32)

MIGRATION_URL = f"postgresql://postgres:{OWNER_PASSWORD}@127.0.0.1:54322/postgres"


def _database(
    *,
    attributes: tuple[bool, ...] = (True, True, False, False, False, False, False),
    privilege_attributes: tuple[bool, ...] = (
        False,
        True,
        False,
        False,
        False,
        False,
        False,
    ),
    memberships: list[tuple[str]] | None = None,
    membership_columns: list[tuple[str]] | None = None,
    direct_membership: tuple[bool, ...] = (False, True, False),
) -> tuple[MagicMock, MagicMock]:
    connection = MagicMock()
    cursor = MagicMock()
    connection.__enter__.return_value = connection
    connection.cursor.return_value.__enter__.return_value = cursor
    cursor.fetchone.side_effect = [
        (True, False),
        attributes,
        privilege_attributes,
        direct_membership,
    ]
    cursor.fetchall.side_effect = [
        membership_columns
        if membership_columns is not None
        else [("inherit_option",), ("set_option",)],
        memberships or [(provisioner.PRIVILEGE_ROLE,)],
    ]
    return connection, cursor


def _executed_sql(cursor: MagicMock) -> str:
    return "\n".join(str(call.args[0]) for call in cursor.execute.call_args_list)


def test_provision_validates_the_owner_connection_and_expected_runtime_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database()
    connect = MagicMock(return_value=connection)
    monkeypatch.setattr(provisioner, "connect", connect)

    provisioner.provision(MIGRATION_URL, RUNTIME_PASSWORD)

    connect.assert_called_once_with(MIGRATION_URL)
    statements = _executed_sql(cursor).casefold()
    assert "grant" in statements
    assert provisioner.PRIVILEGE_ROLE.casefold() in statements
    assert "with inherit true, set false" in statements
    assert "revoke" not in statements


def test_provision_fails_closed_for_unexpected_inherited_membership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database(
        memberships=[(provisioner.PRIVILEGE_ROLE,), ("unexpected_role",)]
    )
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="unexpected role membership"):
        provisioner.provision(MIGRATION_URL, RUNTIME_PASSWORD)

    assert "revoke" not in _executed_sql(cursor).casefold()


def test_provision_fails_closed_for_unsafe_runtime_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database(attributes=(True, True, False, False, False, False, True))
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="unsafe runtime role attributes"):
        provisioner.provision(MIGRATION_URL, RUNTIME_PASSWORD)

    assert "revoke" not in _executed_sql(cursor).casefold()
