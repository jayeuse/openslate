from uuid import UUID

from app.core.base_model import BaseModel
from app.systems.users.models import User


def test_user_inherits_universal_columns() -> None:
    columns = User.__table__.c

    assert issubclass(User, BaseModel)
    assert set(("id", "created_at", "deleted_at", "is_deleted", "updated_at", "performed_by")) <= {
        column.name for column in columns
    }
    assert columns.id.primary_key
    assert columns.deleted_at.nullable
    assert columns.performed_by.nullable


def test_base_model_generates_uuidv7_ids_and_audit_defaults() -> None:
    id_default = User.__table__.c.id.default
    generated_id = id_default.arg(None)

    assert isinstance(generated_id, UUID)
    assert generated_id.version == 7
    assert User.__table__.c.created_at.default is not None
    assert User.__table__.c.updated_at.default is not None
    assert User.__table__.c.is_deleted.default.arg is False


def test_base_model_uses_timezone_aware_timestamps() -> None:
    assert isinstance(User.__table__.c.created_at.type, type(User.__table__.c.updated_at.type))
    assert User.__table__.c.created_at.type.timezone
    assert User.__table__.c.updated_at.type.timezone
