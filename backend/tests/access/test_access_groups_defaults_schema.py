"""Metadata contracts for flat Access groups and policy defaults."""

from pathlib import Path

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, Index, UniqueConstraint, inspect

from app.systems.access.policy import models


def _foreign_keys(table):  # type: ignore[no-untyped-def]
    return {
        (foreign_key.parent.name, foreign_key.target_fullname, foreign_key.ondelete)
        for constraint in table.constraints
        if isinstance(constraint, ForeignKeyConstraint)
        for foreign_key in constraint.elements
    }


def test_access_groups_are_flat_audited_named_resources() -> None:
    group = models.AccessGroup.__table__

    assert {"name", "description", "revision", "performed_by"} <= set(group.c.keys())
    assert not {"parent_id", "parent_group_id", "nesting"} & set(group.c.keys())
    constraints = {
        constraint.name: str(constraint.sqltext)
        for constraint in group.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert "ck_access_groups_name_not_blank" in constraints
    assert "ck_access_groups_revision_positive" in constraints
    indexes = {index.name: index for index in group.indexes if isinstance(index, Index)}
    active_name = indexes["uq_access_groups_name_active_ci"]
    assert active_name.unique is True
    assert "lower(name)" in str(next(iter(active_name.expressions)))
    assert "is_deleted = false" in str(active_name.dialect_options["postgresql"]["where"])


def test_group_memberships_are_flat_audited_human_user_links() -> None:
    table = models.AccessGroupMember.__table__

    assert {"group_id", "user_id", "performed_by"} <= set(table.c.keys())
    assert _foreign_keys(table) >= {
        ("group_id", "access_groups.id", "RESTRICT"),
        ("user_id", "users.id", "RESTRICT"),
        ("performed_by", "users.id", "SET NULL"),
    }
    unique = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert unique["uq_access_group_members_group_user"] == ("group_id", "user_id")
    indexes = {index.name for index in table.indexes if isinstance(index, Index)}
    assert "ix_access_group_members_user_id" in indexes
    assert "ix_access_group_members_group_id" not in indexes
    assert not inspect(models.AccessGroupMember).relationships


def test_workspace_defaults_are_singleton_protected_and_seedable() -> None:
    table = models.AccessPolicyDefaults.__table__

    assert {
        "singleton_key",
        "default_role_id",
        "invitation_expiry_days",
        "guest_duration_days",
        "service_duration_days",
        "default_deny",
        "require_guest_sponsor",
        "require_service_owner",
        "revision",
        "performed_by",
    } <= set(table.c.keys())
    checks = {
        constraint.name: str(constraint.sqltext)
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    }
    expected_checks = {
        "ck_access_policy_defaults_workspace",
        "ck_access_policy_defaults_revision_positive",
    }
    assert expected_checks <= set(checks)
    assert {
        "ck_access_policy_defaults_invitation_expiry_days_range",
        "ck_access_policy_defaults_guest_duration_days_range",
        "ck_access_policy_defaults_service_duration_days_range",
        "ck_access_policy_defaults_protected_flags",
    } <= set(checks)
    assert _foreign_keys(table) >= {
        ("default_role_id", "roles.id", "RESTRICT"),
        ("performed_by", "users.id", "SET NULL"),
    }


def test_default_group_and_department_links_have_restricted_audited_pairs() -> None:
    for model, target in (
        (models.AccessDefaultGroup, "access_groups.id"),
        (models.AccessDefaultDepartment, "departments.id"),
    ):
        table = model.__table__
        assert {"policy_defaults_id", "performed_by"} <= set(table.c.keys())
        assert (
            "policy_defaults_id",
            "access_policy_defaults.id",
            "RESTRICT",
        ) in _foreign_keys(table)
        assert ("performed_by", "users.id", "SET NULL") in _foreign_keys(table)
        indexes = {index.name for index in table.indexes if isinstance(index, Index)}
        reverse_index = "group_id" if target == "access_groups.id" else "department_id"
        assert f"ix_{table.name}_{reverse_index}" in indexes
        assert f"ix_{table.name}_policy_defaults_id" not in indexes
        assert any(
            target == foreign_key.target_fullname and foreign_key.ondelete == "RESTRICT"
            for constraint in table.constraints
            if isinstance(constraint, ForeignKeyConstraint)
            for foreign_key in constraint.elements
        )


def test_migration_creates_every_deferred_performed_by_foreign_key() -> None:
    source = (
        Path(__file__).parents[2]
        / "migrations"
        / "versions"
        / "0f5520bd106d_add_access_groups_defaults.py"
    ).read_text()

    for table in (
        "access_groups",
        "access_group_members",
        "access_policy_defaults",
        "access_default_groups",
        "access_default_departments",
    ):
        assert (
            f'op.create_foreign_key(\n        op.f("fk_{table}_performed_by_users"),\n'
            f'        "{table}",\n        "users",\n        ["performed_by"],\n        ["id"],'
        ) in source
