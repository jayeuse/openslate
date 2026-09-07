import os
from unittest.mock import MagicMock

import pytest
from psycopg import connect

from scripts import provision_database_role as provisioner

MIGRATION_URL = "postgresql://postgres:owner-password@127.0.0.1:54322/postgres"


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

    provisioner.provision(MIGRATION_URL, "runtime-password")

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
        provisioner.provision(MIGRATION_URL, "runtime-password")

    assert "revoke" not in _executed_sql(cursor).casefold()


def test_provision_fails_closed_for_unsafe_runtime_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database(attributes=(True, True, False, False, False, False, True))
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="unsafe runtime role attributes"):
        provisioner.provision(MIGRATION_URL, "runtime-password")

    assert "revoke" not in _executed_sql(cursor).casefold()


def test_provision_fails_closed_for_unsafe_privilege_role_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database(
        privilege_attributes=(False, True, False, False, False, False, True)
    )
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="unsafe privilege role attributes"):
        provisioner.provision(MIGRATION_URL, "runtime-password")

    assert "revoke" not in _executed_sql(cursor).casefold()


def test_provision_fails_closed_for_delegated_direct_membership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database(direct_membership=(True, True, False))
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="administrative role membership"):
        provisioner.provision(MIGRATION_URL, "runtime-password")

    statements = _executed_sql(cursor).casefold()
    assert "revoke" not in statements
    assert "admin false" not in statements


def test_provision_fails_closed_for_unsafe_membership_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database(direct_membership=(False, False, True))
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="unsafe membership options"):
        provisioner.provision(MIGRATION_URL, "runtime-password")

    assert "revoke" not in _executed_sql(cursor).casefold()


def test_provision_supports_catalogs_without_membership_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database(
        membership_columns=[],
        direct_membership=(False,),
    )
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    provisioner.provision(MIGRATION_URL, "runtime-password")

    statements = _executed_sql(cursor).casefold()
    assert "grant" in statements
    assert "with inherit true" not in statements


@pytest.mark.integration
def test_provision_verifies_a_local_postgresql_role() -> None:
    migration_url = os.getenv("MIGRATION_DATABASE_URL")
    password = os.getenv("OPENSLATE_DATABASE_PASSWORD")
    if not migration_url or not password:
        pytest.skip(
            "Set MIGRATION_DATABASE_URL and OPENSLATE_DATABASE_PASSWORD for local owner integration"
        )

    try:
        from tests.conftest import _guard_integration_database

        _guard_integration_database(migration_url)
    except RuntimeError:
        pytest.skip("MIGRATION_DATABASE_URL must target the local Supabase PostgreSQL database")

    provisioner.provision(migration_url, password)

    with connect(provisioner._psycopg_url(migration_url)) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT membership.admin_option,
                       membership.inherit_option,
                       membership.set_option
                  FROM pg_catalog.pg_auth_members AS membership
                  JOIN pg_catalog.pg_roles AS member_role
                    ON member_role.oid = membership.member
                  JOIN pg_catalog.pg_roles AS granted_role
                    ON granted_role.oid = membership.roleid
                 WHERE member_role.rolname = %s
                   AND granted_role.rolname = %s
                """,
                (provisioner.RUNTIME_ROLE, provisioner.PRIVILEGE_ROLE),
            )
            assert cursor.fetchone() == (False, True, False)
