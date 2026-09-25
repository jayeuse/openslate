"""Metadata contracts for the additive Access identity expand migration."""

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, Index, UniqueConstraint

from app.systems.access.users import models


def test_identity_expand_columns_and_constraints_are_declared() -> None:
    role_columns = models.Role.__table__.c
    user_table = models.User.__table__
    user_columns = user_table.c

    assert "description" in role_columns
    assert role_columns.description.nullable is True
    assert {"display_name", "identity_kind", "job_title", "sponsor_user_id", "expires_at"} <= set(
        user_columns.keys()
    )
    assert user_columns.display_name.nullable is True
    assert user_columns.identity_kind.nullable is False
    assert user_columns.identity_kind.server_default is not None
    assert user_columns.job_title.nullable is True
    assert user_columns.sponsor_user_id.nullable is True
    assert user_columns.expires_at.nullable is True

    check_constraints = {
        constraint.name: str(constraint.sqltext)
        for constraint in user_table.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert "ck_users_identity_kind" in check_constraints
    assert "ck_users_identity_kind_subject" in check_constraints
    assert "identity_kind" in check_constraints["ck_users_identity_kind"]
    assert "sponsor_user_id" in check_constraints["ck_users_identity_kind_subject"]
    assert "expires_at" in check_constraints["ck_users_identity_kind_subject"]


def test_user_departments_are_audited_memberships_with_explicit_delete_semantics() -> None:
    membership_model = getattr(models, "UserDepartment", None)
    assert membership_model is not None
    assert issubclass(membership_model, models.BaseModel)

    table = membership_model.__table__
    assert {"user_id", "department_id", "is_primary"} <= set(table.c.keys())
    assert table.c.user_id.nullable is False
    assert table.c.department_id.nullable is False
    assert table.c.is_primary.nullable is False

    foreign_keys = {
        (foreign_key.parent.name, foreign_key.target_fullname, foreign_key.ondelete)
        for constraint in table.constraints
        if isinstance(constraint, ForeignKeyConstraint)
        for foreign_key in constraint.elements
    }
    # Membership cleanup is application-owned: parent physical deletion is restricted,
    # while soft-delete workflows continue to update audited rows explicitly.
    assert ("user_id", "users.id", "RESTRICT") in foreign_keys
    assert ("department_id", "departments.id", "RESTRICT") in foreign_keys

    unique_constraints = {
        constraint.name: tuple(column.name for column in constraint.columns)
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert unique_constraints["uq_user_departments_user_department"] == ("user_id", "department_id")

    indexes = {index.name: index for index in table.indexes if isinstance(index, Index)}
    assert indexes["ix_user_departments_user_id"] is not None
    assert indexes["ix_user_departments_department_id"] is not None
    primary_index = indexes["uq_user_departments_primary_user"]
    assert primary_index.unique is True
    assert "is_primary = true" in str(primary_index.dialect_options["postgresql"]["where"])
