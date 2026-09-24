"""Schema contract for metadata-only service identities."""

from sqlalchemy import CheckConstraint, ForeignKeyConstraint, Index

from app.core.base_model import BaseModel
from app.systems.access.service_identities.models import ServiceIdentity


def test_service_identities_are_audited_metadata_with_explicit_database_invariants() -> None:
    assert issubclass(ServiceIdentity, BaseModel)

    table = ServiceIdentity.__table__
    columns = table.c
    assert {
        "name",
        "purpose",
        "owner_id",
        "role_id",
        "expires_at",
        "status",
        "performed_by",
    } <= set(columns.keys())
    assert columns.name.type.length == 200
    assert all(
        columns[column].nullable is False
        for column in columns.keys()
        if column
        in {
            "name",
            "purpose",
            "owner_id",
            "role_id",
            "expires_at",
            "status",
        }
    )
    assert columns.status.server_default is not None

    checks = {
        constraint.name: str(constraint.sqltext)
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert checks["ck_service_identities_name_not_blank"] == "btrim(name) <> ''"
    assert checks["ck_service_identities_purpose_not_blank"] == "btrim(purpose) <> ''"
    assert checks["ck_service_identities_status"] == "status IN ('active', 'disabled')"

    foreign_keys = {
        (foreign_key.parent.name, foreign_key.target_fullname, foreign_key.ondelete)
        for constraint in table.constraints
        if isinstance(constraint, ForeignKeyConstraint)
        for foreign_key in constraint.elements
    }
    assert ("owner_id", "users.id", "RESTRICT") in foreign_keys
    assert ("role_id", "roles.id", "RESTRICT") in foreign_keys
    assert ("performed_by", "users.id", "SET NULL") in foreign_keys
    assert {parent for parent, _, _ in foreign_keys} == {"owner_id", "role_id", "performed_by"}

    indexes = {index.name: index for index in table.indexes if isinstance(index, Index)}
    assert {"ix_service_identities_owner_id", "ix_service_identities_role_id"} <= set(indexes)
    expiry_index = indexes["ix_service_identities_status_expires_at_id"]
    assert tuple(column.name for column in expiry_index.columns) == (
        "status",
        "expires_at",
        "id",
    )
