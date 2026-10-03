from typing import TYPE_CHECKING, Any, ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.sandbox.modules.models import Module
    from app.systems.sandbox.relationships.models import RelationshipEdge


class Record(BaseModel):
    __tablename__ = "records"
    __table_args__ = (
        CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_records_lifecycle_close_provenance",
        ),
    )

    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"lifecycle_close_operation_id"}
    )
    lifecycle_close_operation_id: Mapped[UUID | None] = mapped_column(nullable=True)

    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    data: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB),
        default=dict,
        server_default=text("'{}'::jsonb"),
        nullable=False,
    )
    module: Mapped["Module"] = relationship(back_populates="records")
    source_relationship_edges: Mapped[list["RelationshipEdge"]] = relationship(
        foreign_keys="RelationshipEdge.source_record_id",
        back_populates="source_record",
    )
    target_relationship_edges: Mapped[list["RelationshipEdge"]] = relationship(
        foreign_keys="RelationshipEdge.target_record_id",
        back_populates="target_record",
    )
