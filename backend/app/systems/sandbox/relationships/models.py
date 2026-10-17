from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.sandbox.fields.models import Field
    from app.systems.sandbox.records.models import Record


class RelationshipEdge(BaseModel):
    """A directed, soft-deletable link between two records."""

    __tablename__ = "relationship_edges"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_relationship_edges_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "field_id"], ["fields.org_id", "fields.id"],
            name="fk_relationship_edges_field_id_fields", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "source_record_id"], ["records.org_id", "records.id"],
            name="fk_relationship_edges_source_record_id_records", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "target_record_id"], ["records.org_id", "records.id"],
            name="fk_relationship_edges_target_record_id_records", ondelete="RESTRICT",
        ),
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

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    field_id: Mapped[UUID] = mapped_column(nullable=False)
    source_record_id: Mapped[UUID] = mapped_column(nullable=False)
    target_record_id: Mapped[UUID] = mapped_column(nullable=False)

    field: Mapped["Field"] = relationship(back_populates="relationship_edges")
    source_record: Mapped["Record"] = relationship(
        foreign_keys=[source_record_id],
        back_populates="source_relationship_edges",
    )
    target_record: Mapped["Record"] = relationship(
        foreign_keys=[target_record_id],
        back_populates="target_relationship_edges",
    )
