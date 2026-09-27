"""Preserved file inventory constraints independent of the storage provider."""

from sqlalchemy import CheckConstraint, SmallInteger

from app.systems.platform.files.models import File


def test_file_inventory_reserves_a_nullable_positive_encryption_version() -> None:
    column = File.__table__.c.enc_version
    checks = {
        str(constraint.sqltext)
        for constraint in File.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }

    assert column.nullable is True
    assert isinstance(column.type, SmallInteger)
    assert "enc_version IS NULL OR enc_version > 0" in checks
