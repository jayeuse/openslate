from unittest.mock import MagicMock

import pytest

from operations import provision_database_role as provisioner

BOOTSTRAP_URL = "postgresql://postgres:bootstrap@127.0.0.1:55322/openslate"
OWNER_URL = "postgresql+psycopg://openslate_owner:owner@127.0.0.1:55322/openslate"
RUNTIME_URL = "postgresql+psycopg://openslate_runtime:runtime@127.0.0.1:55322/openslate"
# Realtime has created realtime.messages; the membership function does not exist yet.
REALTIME_FIRST_RUN = ((True, True), None)

def _database() -> tuple[MagicMock, MagicMock]:
    connection = MagicMock()
    cursor = MagicMock()
    connection.__enter__.return_value = connection
    connection.cursor.return_value.__enter__.return_value = cursor
    cursor.fetchone.side_effect = [
        (False,),
        (False,),
        (False,),
        (True, False, False, False, False, False, False),
        (False, False, False, False, False, False, False),
        (True, True, False, False, False, False, False),
        (False, True, False),
        None,  # No application-owned Auth liveness policy on first provisioning.
        *REALTIME_FIRST_RUN,
        (True,),  # The exact realtime.send overload exists.
        (True, True, True),
    ]
    cursor.fetchall.side_effect = [
        [("inherit_option",), ("set_option",)],
        [(provisioner.RUNTIME_ROLE, provisioner.PRIVILEGE_ROLE, False, True, False)],
        [],  # No realtime.messages policies yet.
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

    provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL)

    connect.assert_called_once_with(BOOTSTRAP_URL)
    statements = _statements(cursor)
    for role in (
        provisioner.OWNER_ROLE,
        provisioner.PRIVILEGE_ROLE,
        provisioner.RUNTIME_ROLE,
    ):
        assert role in statements
    assert "alter database" not in statements
    assert "revoke all on database" not in statements
    assert "grant connect on database" in statements
    assert "grant usage, create on schema public" in statements
    assert "grant select (id, user_id) on auth.sessions" in statements
    assert "with inherit true, set false" in statements
    assert "grant select on all tables in schema" not in statements
    assert "alter default privileges" not in statements
    assert "openslate_inspector" not in statements


def test_provision_rotates_existing_managed_login_role_passwords_after_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database()
    cursor.fetchone.side_effect = [
        (True,),
        (True,),
        (True,),
        (True, False, False, False, False, False, False),
        (False, False, False, False, False, False, False),
        (True, True, False, False, False, False, False),
        (False, True, False),
        None,  # No application-owned Auth liveness policy on first provisioning.
        *REALTIME_FIRST_RUN,
        (True,),  # The exact realtime.send overload exists.
        (True, True, True),
    ]
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL)

    statements = _statements(cursor)
    assert "alter role" in statements
    assert statements.count("password") == 2


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
        provisioner.provision(bootstrap, owner, runtime)

    connect.assert_not_called()


def test_provision_fails_closed_for_existing_unsafe_runtime_role(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection, cursor = _database()
    cursor.fetchone.side_effect = [
        (True,),
        (False,),
        (False,),
        (True, False, False, False, False, False, False),
        (False, False, False, False, False, False, False),
        (True, True, False, False, False, False, True),
    ]
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))

    with pytest.raises(RuntimeError, match="openslate_runtime role has unsafe attributes"):
        provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL)

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
        provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL)

    assert "alter database" not in _statements(cursor)


@pytest.mark.parametrize(
    ("creator", "inherit", "set_role", "accepted"),
    [("postgres", False, False, True), ("other", False, False, False),
     ("postgres", True, False, False), ("postgres", False, True, False)],
)
def test_provision_admits_only_bootstrap_non_inheriting_creator_grants(
    monkeypatch: pytest.MonkeyPatch, creator: str, inherit: bool,
    set_role: bool, accepted: bool,
) -> None:
    connection, cursor = _database()
    cursor.fetchall.side_effect = [
        [("inherit_option",), ("set_option",)],
        [(provisioner.RUNTIME_ROLE, provisioner.PRIVILEGE_ROLE, False, True, False)]
        + [(creator, role, True, inherit, set_role) for role in (
            provisioner.OWNER_ROLE, provisioner.PRIVILEGE_ROLE, provisioner.RUNTIME_ROLE,
        )],
        [],
    ]
    monkeypatch.setattr(provisioner, "connect", MagicMock(return_value=connection))
    if accepted:
        provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL)
    else:
        with pytest.raises(RuntimeError, match="unsafe membership"):
            provisioner.provision(BOOTSTRAP_URL, OWNER_URL, RUNTIME_URL)


def _realtime_cursor(fetchone: list[object], policies: list[tuple[object, ...]]) -> MagicMock:
    cursor = MagicMock()
    cursor.fetchone.side_effect = fetchone
    cursor.fetchall.return_value = policies
    return cursor


EXPECTED_POLICIES = [
    ("openslate_realtime_member_read", "r", True, True,
     provisioner.REALTIME_JOIN_EXPRESSION, None),
    ("openslate_realtime_member_write", "a", True, True,
     None, provisioner.REALTIME_JOIN_EXPRESSION),
]


def test_realtime_policies_call_a_deny_all_function_until_alembic_replaces_it() -> None:
    cursor = _realtime_cursor([*REALTIME_FIRST_RUN], [])

    provisioner._provision_realtime_channel_policies(cursor)

    statements = _statements(cursor)
    assert "create function public.can_join_realtime_topic(topic text)" in statements
    assert "select false" in statements
    assert "security definer" not in statements
    assert "alter function public.can_join_realtime_topic(text) owner to openslate_owner" in (
        statements
    )
    assert "from public, anon, service_role, postgres" in statements
    assert "grant execute on function public.can_join_realtime_topic(text) to authenticated" in (
        statements
    )
    assert (
        "create policy openslate_realtime_member_read on realtime.messages for select "
        "to authenticated using (public.can_join_realtime_topic(realtime.topic()))"
    ) in statements
    assert (
        "create policy openslate_realtime_member_write on realtime.messages for insert "
        "to authenticated with check (public.can_join_realtime_topic(realtime.topic()))"
    ) in statements


def test_realtime_provisioning_keeps_exact_existing_objects() -> None:
    cursor = _realtime_cursor([(True, True), (provisioner.OWNER_ROLE,)], EXPECTED_POLICIES)

    provisioner._provision_realtime_channel_policies(cursor)

    statements = _statements(cursor)
    assert "create function" not in statements
    assert "create policy" not in statements
    assert "grant execute on function public.can_join_realtime_topic(text) to authenticated" in (
        statements
    )


@pytest.mark.parametrize(
    ("fetchone", "policies", "message"),
    [
        pytest.param([None], [], "realtime.messages", id="realtime-not-started"),
        pytest.param([(False, True)], [], "realtime.messages", id="rls-disabled"),
        pytest.param([(True, True), ("postgres",)], [], "unexpected owner", id="foreign-owner"),
        pytest.param(
            [(True, True), (provisioner.OWNER_ROLE,)],
            [*EXPECTED_POLICIES, ("allow_all", "r", True, True, "true", None)],
            "does not manage", id="widening-policy",
        ),
        pytest.param(
            [(True, True), (provisioner.OWNER_ROLE,)],
            [("openslate_realtime_member_read", "r", True, True, "true", None)],
            "unsafe", id="altered-policy",
        ),
    ],
)
def test_realtime_provisioning_refuses_unsafe_state(
    fetchone: list[object], policies: list[tuple[object, ...]], message: str
) -> None:
    cursor = _realtime_cursor(fetchone, policies)

    with pytest.raises(RuntimeError, match=message):
        provisioner._provision_realtime_channel_policies(cursor)

    assert "create policy" not in _statements(cursor)
