from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.fields.models import Field
    from app.systems.records.models import Record


class RelationshipEdge(BaseModel):
    """A directed, soft-deletable link between two records."""

    __tablename__ = "relationship_edges"
    __table_args__ = (
        CheckConstraint(
            "source_record_id <> target_record_id",
            name="ck_relationship_edges_distinct_records",
        ),
        Index(
            "uq_relationship_edges_active",
            "field_id",
            "source_record_id",
            "target_record_id",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
        Index(
            "ix_relationship_edges_active_source",
            "field_id",
            "source_record_id",
            postgresql_where=text("is_deleted = false"),
        ),
        Index(
            "ix_relationship_edges_active_target",
            "field_id",
            "target_record_id",
            postgresql_where=text("is_deleted = false"),
        ),
    )

    field_id: Mapped[UUID] = mapped_column(
        ForeignKey("fields.id", ondelete="RESTRICT"),
        nullable=False,
    )
    source_record_id: Mapped[UUID] = mapped_column(
        ForeignKey("records.id", ondelete="RESTRICT"),
        nullable=False,
    )
    target_record_id: Mapped[UUID] = mapped_column(
        ForeignKey("records.id", ondelete="RESTRICT"),
        nullable=False,
    )

    field: Mapped["Field"] = relationship(back_populates="relationship_edges")
    source_record: Mapped["Record"] = relationship(
        foreign_keys=[source_record_id],
        back_populates="source_relationship_edges",
    )
    target_record: Mapped["Record"] = relationship(
        foreign_keys=[target_record_id],
        back_populates="target_relationship_edges",
    )
