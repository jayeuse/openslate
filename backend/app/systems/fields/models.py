from enum import StrEnum
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.modules.models import Module


class FieldType(StrEnum):
    TEXT = "text"
    NUMBER = "number"
    DECIMAL = "decimal"
    INTEGER = "int"
    BOOLEAN = "boolean"
    DATE = "date"
    DATETIME = "datetime"
    SELECT = "select"


class Field(BaseModel):
    __tablename__ = "fields"
    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_fields_position_nonnegative"),
        CheckConstraint(
            "type IN ('text', 'number', 'decimal', 'int', 'boolean', 'date', 'datetime', 'select')",
            name="ck_fields_type",
        ),
        Index(
            "uq_fields_module_name_active",
            "module_id",
            "name",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
        Index(
            "uq_fields_module_position_active",
            "module_id",
            "position",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    type: Mapped[FieldType] = mapped_column(String(20), nullable=False)
    required: Mapped[bool] = mapped_column(nullable=False, server_default=text("false"))
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB),
        default=dict,
        server_default=text("'{}'::jsonb"),
        nullable=False,
    )
    module: Mapped["Module"] = relationship(back_populates="fields")
