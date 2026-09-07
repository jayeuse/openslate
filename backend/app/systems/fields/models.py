from enum import StrEnum
from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.modules.models import Module
    from app.systems.relationships.models import RelationshipEdge


class FieldType(StrEnum):
    TEXT = "text"
    NUMBER = "number"
    DECIMAL = "decimal"
    INTEGER = "int"
    BOOLEAN = "boolean"
    DATE = "date"
    DATETIME = "datetime"
    SELECT = "select"
    RELATIONSHIP = "relationship"


class Field(BaseModel):
    __tablename__ = "fields"
    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_fields_position_nonnegative"),
        CheckConstraint(
            "type IN ('text', 'number', 'decimal', 'int', 'boolean', 'date', 'datetime', "
            "'select', 'relationship')",
            name="ck_fields_type",
        ),
        CheckConstraint(
            "(type = 'relationship' AND relationship_target_module_id IS NOT NULL "
            "AND relationship_multiple_targets IS NOT NULL "
            "AND relationship_multiple_sources IS NOT NULL AND required = false "
            "AND config = '{}'::jsonb) OR (type <> 'relationship' "
            "AND relationship_target_module_id IS NULL "
            "AND relationship_multiple_targets IS NULL "
            "AND relationship_multiple_sources IS NULL)",
            name="ck_fields_relationship_metadata",
        ),
        Index(
            "uq_fields_module_name_active",
            "module_id",
            "name",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
        Index("ix_fields_relationship_target_module_id", "relationship_target_module_id"),
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
    audit_redacted: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default=text("false"),
        nullable=False,
    )
    config: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB),
        default=dict,
        server_default=text("'{}'::jsonb"),
        nullable=False,
    )
    relationship_target_module_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"),
        nullable=True,
    )
    relationship_multiple_targets: Mapped[bool | None] = mapped_column(nullable=True)
    relationship_multiple_sources: Mapped[bool | None] = mapped_column(nullable=True)
    module: Mapped["Module"] = relationship(
        foreign_keys=[module_id],
        back_populates="fields",
    )
    relationship_target_module: Mapped["Module | None"] = relationship(
        foreign_keys=[relationship_target_module_id],
        back_populates="relationship_target_fields",
    )
    relationship_edges: Mapped[list["RelationshipEdge"]] = relationship(
        back_populates="field",
    )
