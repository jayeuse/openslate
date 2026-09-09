"""Read-only reset planning and postcondition contract tests."""
from __future__ import annotations

from contextlib import redirect_stdout
from dataclasses import replace
from io import StringIO

import pytest

from scripts import reset_application_data as reset

from .plan_support import (
    PROFILE_SNAPSHOT_FIELDS,
    ROLE_SNAPSHOT_FIELDS,
    _counts,
    _database,
    _plan,
    _rich_profile_snapshot,
    _rich_role_snapshot,
)
from .support import (
    ADMIN_ID,
    ADMIN_ROLE_ID,
    APPLICATION_TABLES,
    DATABASE_PASSWORD,
    DELETED_ADMIN_ID,
    DELETED_AT,
    DISABLED_ADMIN_ID,
    MEMBER_ROLE_ID,
    NON_PRESERVED_TABLES,
    OTHER_ID,
    PENDING_ADMIN_ID,
    _auth_user,
    _profile,
    _role,
)


def test_plan_requires_expected_head_and_exact_public_application_table_allowlist() -> None:
    valid = _database()
    plan = _plan(valid)
    assert set(plan.counts) >= NON_PRESERVED_TABLES
    assert plan.preserved_admin_id == ADMIN_ID
    assert plan.preserved_admin_role_id == ADMIN_ROLE_ID
    assert plan.preserved_member_role_id == MEMBER_ROLE_ID

    for changes in (
        {"head": "20260830_0013"},
        {"public_tables": APPLICATION_TABLES | {"unrelated_table"}},
        {"public_tables": APPLICATION_TABLES - {"records"}},
    ):
        database = _database(**changes)
        with pytest.raises(reset.ResetError):
            _plan(database)
        assert database.delete_tables == []


def test_plan_rejects_another_effective_admin_without_auth_liveness_guards() -> None:
    additional_admin = _profile(
        user_id=OTHER_ID,
        email="other@example.test",
        deleted_at=DELETED_AT,
    )
    database = _database(
        profiles=[_profile(), additional_admin],
        auth_users=[
            _auth_user(),
            _auth_user(
                user_id=OTHER_ID,
                email="other@example.test",
                confirmed=None,
                banned_until=DELETED_AT,
                deleted_at=DELETED_AT,
            ),
        ],
        counts=_counts(users=2),
    )

    with pytest.raises(reset.ResetError, match="administrator"):
        _plan(database)

    assert database.delete_tables == []


def test_plan_counts_inactive_admin_profiles_that_are_still_deleteable() -> None:
    pending_admin = _profile(
        user_id=PENDING_ADMIN_ID,
        status="pending",
        email="pending@example.test",
    )
    disabled_admin = _profile(
        user_id=DISABLED_ADMIN_ID,
        status="disabled",
        email="disabled@example.test",
    )
    soft_deleted_admin = _profile(
        user_id=DELETED_ADMIN_ID,
        is_deleted=True,
        deleted_at=DELETED_AT,
        email="deleted@example.test",
    )
    member = _profile(
        user_id=OTHER_ID,
        status="active",
        role_id=MEMBER_ROLE_ID,
        email="member@example.test",
    )
    database = _database(
        profiles=[_profile(), pending_admin, disabled_admin, soft_deleted_admin, member],
        auth_users=[
            _auth_user(),
            _auth_user(user_id=PENDING_ADMIN_ID, email="pending@example.test"),
            _auth_user(user_id=DISABLED_ADMIN_ID, email="disabled@example.test"),
            _auth_user(user_id=DELETED_ADMIN_ID, email="deleted@example.test"),
            _auth_user(user_id=OTHER_ID, email="member@example.test"),
        ],
        counts=_counts(users=5),
    )

    plan = _plan(database)

    assert plan.counts["profiles_to_delete"] == 4
    assert plan.counts["inactive_admin_profiles_to_delete"] == 3


def test_profile_delete_categories_change_the_digest_even_when_total_counts_match() -> None:
    auth_users = [
        _auth_user(),
        _auth_user(user_id=OTHER_ID, email="other@example.test"),
    ]
    pending_admin = _database(
        profiles=[
            _profile(),
            _profile(
                user_id=OTHER_ID,
                status="pending",
                email="other@example.test",
            ),
        ],
        auth_users=auth_users,
        counts=_counts(users=2),
    )
    active_member = _database(
        profiles=[
            _profile(),
            _profile(
                user_id=OTHER_ID,
                status="active",
                role_id=MEMBER_ROLE_ID,
                email="other@example.test",
            ),
        ],
        auth_users=auth_users,
        counts=_counts(users=2),
    )

    pending_plan = _plan(pending_admin)
    member_plan = _plan(active_member)

    assert pending_plan.counts["profiles_to_delete"] == member_plan.counts[
        "profiles_to_delete"
    ] == 1
    assert pending_plan.counts["inactive_admin_profiles_to_delete"] == 1
    assert member_plan.counts["inactive_admin_profiles_to_delete"] == 0
    assert pending_plan.impact_digest != member_plan.impact_digest


def test_printed_plan_exposes_profile_delete_categories() -> None:
    database = _database(
        profiles=[
            _profile(),
            _profile(
                user_id=OTHER_ID,
                status="pending",
                email="other@example.test",
            ),
        ],
        auth_users=[
            _auth_user(),
            _auth_user(user_id=OTHER_ID, email="other@example.test"),
        ],
        counts=_counts(users=2),
    )
    plan = _plan(database)
    output = StringIO()

    with redirect_stdout(output):
        reset._print_plan(plan)

    printed = output.getvalue()
    assert "profiles_to_delete=1" in printed
    assert "inactive_admin_profiles_to_delete=1" in printed


def test_plan_snapshots_include_all_retained_profile_and_role_columns() -> None:
    profile = _profile(
        username="preserved-admin",
        deleted_at=DELETED_AT,
        performed_by=ADMIN_ID,
    )
    admin_role = _role(
        ADMIN_ROLE_ID,
        "admin",
        permissions={"scope": "all"},
        deleted_at=DELETED_AT,
        performed_by=ADMIN_ID,
    )
    member_role = _role(
        MEMBER_ROLE_ID,
        "member",
        permissions={"scope": "limited"},
        performed_by=ADMIN_ID,
    )
    database = _database(profile=profile, roles=[admin_role, member_role])

    plan = _plan(database)

    assert {
        field: getattr(plan.profile_snapshot, field, object())
        for field in PROFILE_SNAPSHOT_FIELDS
    } == {field: profile[field] for field in PROFILE_SNAPSHOT_FIELDS}
    assert {
        field: getattr(plan.admin_role_snapshot, field, object())
        for field in ROLE_SNAPSHOT_FIELDS
    } == {field: admin_role[field] for field in ROLE_SNAPSHOT_FIELDS}
    assert {
        field: getattr(plan.member_role_snapshot, field, object())
        for field in ROLE_SNAPSHOT_FIELDS
    } == {field: member_role[field] for field in ROLE_SNAPSHOT_FIELDS}


def test_digest_changes_when_a_retained_performed_by_actor_changes() -> None:
    with_deleted_actor = _database(
        profile=_profile(performed_by=OTHER_ID),
        roles=[
            _role(ADMIN_ROLE_ID, "admin", performed_by=OTHER_ID),
            _role(MEMBER_ROLE_ID, "member"),
        ],
    )
    without_deleted_actor = _database(
        profile=_profile(performed_by=None),
        roles=[
            _role(ADMIN_ROLE_ID, "admin", performed_by=None),
            _role(MEMBER_ROLE_ID, "member"),
        ],
    )

    assert _plan(with_deleted_actor).impact_digest != _plan(without_deleted_actor).impact_digest


def test_postconditions_allow_only_expected_performed_by_set_nulling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    retained = _profile(performed_by=OTHER_ID)
    deleted_profile = _profile(
        user_id=OTHER_ID,
        role_id=MEMBER_ROLE_ID,
        email="deleted@example.test",
    )
    admin_role = _role(ADMIN_ROLE_ID, "admin", performed_by=ADMIN_ID)
    member_role = _role(MEMBER_ROLE_ID, "member", performed_by=OTHER_ID)
    database = _database(
        profiles=[retained, deleted_profile],
        roles=[admin_role, member_role],
        auth_users=[
            _auth_user(),
            _auth_user(user_id=OTHER_ID, email="deleted@example.test"),
        ],
        counts={table: 0 for table in NON_PRESERVED_TABLES}
        | {"users": 2, "roles": 2},
    )
    expected_profile = _rich_profile_snapshot(retained)
    expected_roles = (
        _rich_role_snapshot(admin_role),
        _rich_role_snapshot(member_role),
    )
    monkeypatch.setattr(
        reset,
        "_read_profile",
        lambda *_: _rich_profile_snapshot(database.profiles[0]),
    )
    monkeypatch.setattr(
        reset,
        "_read_roles",
        lambda *_: tuple(_rich_role_snapshot(role) for role in database.roles),
    )

    plan = _plan(database)
    assert plan.profile_snapshot == expected_profile
    assert plan.admin_role_snapshot == expected_roles[0]
    assert plan.member_role_snapshot == expected_roles[1]

    reset.apply_reset(
        database,
        plan,
        execute=True,
        stdin_is_tty=True,
        confirmation=plan.impact_digest,
    )

    assert database.profiles[0]["performed_by"] is None
    assert database.roles[0]["performed_by"] == ADMIN_ID
    assert database.roles[1]["performed_by"] is None


def test_postconditions_reject_an_unexpected_retained_snapshot_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = _database(
        counts={table: 0 for table in NON_PRESERVED_TABLES}
        | {"users": 1, "roles": 2},
    )
    plan = _plan(database)
    expected_profile = _rich_profile_snapshot(_profile())
    changed_profile = _rich_profile_snapshot(_profile(status="disabled"))
    roles = tuple(_rich_role_snapshot(role) for role in database.roles)
    plan = replace(
        plan,
        profile_snapshot=expected_profile,
        admin_role_snapshot=roles[0],
        member_role_snapshot=roles[1],
    )
    monkeypatch.setattr(reset, "_read_profile", lambda *_: changed_profile)
    monkeypatch.setattr(reset, "_read_roles", lambda *_: roles)

    with pytest.raises(reset.ResetError, match="profile"):
        reset._validate_postconditions(database, plan)


@pytest.mark.parametrize(
    "changes",
    [
        pytest.param({"auth_users": []}, id="no-matching-identity"),
        pytest.param(
            {"auth_users": [_auth_user(), _auth_user(user_id=OTHER_ID)]},
            id="multiple-matching-identities",
        ),
        pytest.param(
            {"auth_users": [_auth_user(confirmed=None)]},
            id="unconfirmed-identity",
        ),
        pytest.param(
            {"auth_users": [_auth_user(banned_until="2026-08-30T01:00:00+00:00")]},
            id="disabled-identity",
        ),
        pytest.param({"profile": None}, id="missing-profile"),
        pytest.param(
            {"profile": _profile(user_id=OTHER_ID)},
            id="profile-uuid-mismatch",
        ),
        pytest.param({"profile": _profile(status="pending")}, id="inactive-profile"),
        pytest.param(
            {"profile": _profile(is_deleted=True)},
            id="deleted-profile",
        ),
        pytest.param(
            {"profile": _profile(email="different@example.test")},
            id="profile-email-mismatch",
        ),
    ],
)
def test_plan_rejects_invalid_auth_identity_or_profile(changes: dict[str, object]) -> None:
    database = _database(**changes)
    with pytest.raises(reset.ResetError) as error:
        _plan(database)

    assert DATABASE_PASSWORD not in str(error.value)
    assert database.delete_tables == []


@pytest.mark.parametrize(
    "roles",
    [
        [_role(ADMIN_ROLE_ID, "Admin"), _role(MEMBER_ROLE_ID, "member")],
        [_role(ADMIN_ROLE_ID, "admin", is_deleted=True), _role(MEMBER_ROLE_ID, "member")],
        [_role(ADMIN_ROLE_ID, "admin")],
        [
            _role(ADMIN_ROLE_ID, "admin"),
            _role(MEMBER_ROLE_ID, "member"),
            _role(OTHER_ID, "member"),
        ],
    ],
)
def test_plan_rejects_nonliteral_admin_or_invalid_member_role_count(
    roles: list[dict[str, object]],
) -> None:
    database = _database(roles=roles)
    with pytest.raises(reset.ResetError):
        _plan(database)
    assert database.delete_tables == []


def test_zero_count_plan_is_read_only_and_idempotent() -> None:
    database = _database(
        counts={"users": 1, "roles": 2}
        | {table: 0 for table in NON_PRESERVED_TABLES}
    )
    plan = _plan(database)

    assert all(plan.counts[table] == 0 for table in NON_PRESERVED_TABLES)
    reset.apply_reset(database, plan)
    assert database.delete_tables == []
    assert database.committed is False
