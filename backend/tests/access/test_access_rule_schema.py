"""Persistence contracts for Access rules and policy revision state."""

import os
from typing import cast
from uuid import UUID

import pytest
from sqlalchemy import CheckConstraint, ForeignKeyConstraint, Index, Table, UniqueConstraint, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import BaseModel
from app.systems.access.policy.models import AccessPolicyVersion, AccessRule

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


def _check_sql(table: Table) -> dict[str, str]:
    result: dict[str, str] = {}
    for constraint in table.constraints:
        if isinstance(constraint, CheckConstraint):
            assert constraint.name is not None
            result[str(constraint.name)] = str(constraint.sqltext)
    return result


def _foreign_keys(table: Table) -> set[tuple[str, str, str | None]]:
    return {
        (foreign_key.parent.name, foreign_key.target_fullname, foreign_key.ondelete)
        for constraint in table.constraints
        if isinstance(constraint, ForeignKeyConstraint)
        for foreign_key in constraint.elements
    }


def test_access_rule_metadata_is_generic_exact_and_fail_closed() -> None:
    assert issubclass(AccessRule, BaseModel)
    table = cast(Table, AccessRule.__table__)
    assert {
        "subject_kind",
        "subject_id",
        "scope_kind",
        "scope_id",
        "permission_id",
        "decision",
        "policy_version",
        "performed_by",
    } <= set(table.c.keys())

    checks = _check_sql(table)
    assert checks["ck_access_rules_subject_kind"] == (
        "subject_kind IN ('everyone','role','group','user','service')"
    )
    assert checks["ck_access_rules_scope_kind"] == (
        "scope_kind IN ('workspace','department','module','field')"
    )
    assert checks["ck_access_rules_decision"] == "decision IN ('inherit','allow','deny')"
    assert checks["ck_access_rules_permission_id"] == (
        "permission_id IN ('departments.read','departments.write','modules.read',"
        "'modules.write','fields.read','fields.write','records.read','records.write',"
        "'relationships.read','relationships.write')"
    )
    assert checks["ck_access_rules_subject_shape"] == (
        "(subject_kind = 'everyone' AND subject_id IS NULL) OR "
        "(subject_kind <> 'everyone' AND subject_id IS NOT NULL)"
    )
    assert checks["ck_access_rules_scope_shape"] == (
        "(scope_kind = 'workspace' AND scope_id IS NULL) OR "
        "(scope_kind <> 'workspace' AND scope_id IS NOT NULL)"
    )
    assert checks["ck_access_rules_window"] == (
        "starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at"
    )
    assert checks["ck_access_rules_policy_version_positive"] == "policy_version > 0"
    assert _foreign_keys(table) == {("performed_by", "users.id", "SET NULL")}
    assert not [
        foreign_key
        for foreign_key in table.foreign_keys
        if foreign_key.parent.name in {"subject_id", "scope_id"}
    ]


def test_access_rule_indexes_lock_active_lookup_and_workspace_uniqueness() -> None:
    indexes = {
        str(index.name): index
        for index in cast(Table, AccessRule.__table__).indexes
        if isinstance(index, Index)
    }
    expected_columns = {
        "ix_access_rules_permission_scope_active": (
            "permission_id",
            "scope_kind",
            "scope_id",
        ),
        "ix_access_rules_subject_active": ("subject_kind", "subject_id"),
        "ix_access_rules_scope_active": ("scope_kind", "scope_id"),
        "uq_access_rules_subject_active": (
            "subject_kind",
            "subject_id",
            "scope_kind",
            "scope_id",
            "permission_id",
        ),
        "uq_access_rules_everyone_active": (
            "scope_kind",
            "scope_id",
            "permission_id",
        ),
    }
    assert set(indexes) == set(expected_columns)
    for name, columns in expected_columns.items():
        assert tuple(column.name for column in indexes[name].columns) == columns

    for name in (
        "ix_access_rules_permission_scope_active",
        "ix_access_rules_subject_active",
        "ix_access_rules_scope_active",
    ):
        assert indexes[name].unique is False
        assert str(indexes[name].dialect_options["postgresql"]["where"]) == (
            "is_deleted = false"
        )

    subject_unique = indexes["uq_access_rules_subject_active"]
    everyone_unique = indexes["uq_access_rules_everyone_active"]
    assert subject_unique.unique is True
    assert everyone_unique.unique is True
    assert subject_unique.dialect_options["postgresql"]["nulls_not_distinct"] is True
    assert everyone_unique.dialect_options["postgresql"]["nulls_not_distinct"] is True
    assert str(subject_unique.dialect_options["postgresql"]["where"]) == (
        "is_deleted = false AND subject_kind <> 'everyone'"
    )
    assert str(everyone_unique.dialect_options["postgresql"]["where"]) == (
        "is_deleted = false AND subject_kind = 'everyone'"
    )


def test_policy_version_is_audited_workspace_singleton() -> None:
    assert issubclass(AccessPolicyVersion, BaseModel)
    table = cast(Table, AccessPolicyVersion.__table__)
    checks = _check_sql(table)
    assert checks == {
        "ck_access_policy_versions_workspace": "singleton_key = 'workspace'",
        "ck_access_policy_versions_revision_positive": "revision > 0",
    }
    unique = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert unique["uq_access_policy_versions_singleton_key"] == ("singleton_key",)
    assert str(getattr(table.c.singleton_key.server_default, "arg", None)) == "'workspace'"
    assert str(getattr(table.c.revision.server_default, "arg", None)) == "1"
    assert _foreign_keys(table) == {("performed_by", "users.id", "SET NULL")}


@pytest.mark.integration
def test_applied_baseline_installs_policy_seed_and_null_safe_uniqueness(
    integration_owner_db: Session,
) -> None:
    connection = integration_owner_db.connection()
    for table in ("access_policy_versions", "access_rules"):
        constraint = connection.execute(
            text(
                "SELECT referenced.relname, catalog_constraint.confdeltype "
                "FROM pg_constraint AS catalog_constraint "
                "JOIN pg_class AS referenced ON referenced.oid = catalog_constraint.confrelid "
                "WHERE catalog_constraint.conrelid = to_regclass(:table) "
                "AND catalog_constraint.conname = :constraint"
            ),
            {"table": f"public.{table}", "constraint": f"fk_{table}_performed_by_users"},
        ).one_or_none()
        assert constraint == ("users", "n")

    null_safe_indexes = dict(
        connection.execute(
            text(
                "SELECT index_class.relname, pg_index.indnullsnotdistinct "
                "FROM pg_index "
                "JOIN pg_class AS index_class ON index_class.oid = pg_index.indexrelid "
                "WHERE pg_index.indrelid = 'public.access_rules'::regclass "
                "AND pg_index.indexrelid IN "
                "(to_regclass('public.uq_access_rules_everyone_active'), "
                "to_regclass('public.uq_access_rules_subject_active'))"
            )
        ).all()
    )
    assert null_safe_indexes == {
        "uq_access_rules_everyone_active": True,
        "uq_access_rules_subject_active": True,
    }

    policy_seed = connection.execute(
        text(
            "SELECT singleton_key, revision, is_deleted "
            "FROM public.access_policy_versions WHERE singleton_key = 'workspace'"
        )
    ).one_or_none()
    assert policy_seed is not None
    assert policy_seed.singleton_key == "workspace"
    assert policy_seed.revision >= 1
    assert policy_seed.is_deleted is False


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)
@pytest.mark.parametrize(
    ("subject_kind", "subject_id"),
    [("everyone", None), ("group", UUID("00000000-0000-4000-8000-000000000010"))],
)
def test_workspace_rule_uniqueness_is_null_safe_and_allows_soft_deleted_replacement(
    integration_db: Session,
    subject_kind: str,
    subject_id: UUID | None,
) -> None:
    def rule() -> AccessRule:
        return AccessRule(
            id=uuid7(),
            subject_kind=subject_kind,
            subject_id=subject_id,
            scope_kind="workspace",
            scope_id=None,
            permission_id="records.read",
            decision="allow",
            locked=False,
            policy_version=1,
        )

    first = rule()
    integration_db.add(first)
    integration_db.flush()

    with pytest.raises(IntegrityError):
        with integration_db.begin_nested():
            integration_db.add(rule())
            integration_db.flush()

    first.is_deleted = True
    integration_db.flush()
    replacement = rule()
    integration_db.add(replacement)
    integration_db.flush()
    assert replacement.id is not None
