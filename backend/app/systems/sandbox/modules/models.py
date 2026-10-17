from typing import TYPE_CHECKING, ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.sandbox.departments.models import Department
    from app.systems.sandbox.fields.models import Field
    from app.systems.sandbox.records.models import Record


class Module(BaseModel):
    __tablename__ = "modules"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_modules_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "department_id"], ["departments.org_id", "departments.id"],
            name="fk_modules_department_id_departments", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "title_field_id"], ["fields.org_id", "fields.id"],
            name="fk_modules_title_field_id_fields", ondelete="RESTRICT", use_alter=True,
        ),
        CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_modules_lifecycle_close_provenance",
        ),
        Index(
            "uq_modules_department_name_active",
            "department_id",
            "module_name",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"lifecycle_close_operation_id"}
    )
    lifecycle_close_operation_id: Mapped[UUID | None] = mapped_column(nullable=True)

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    department_id: Mapped[UUID] = mapped_column(nullable=False, index=True)
    module_name: Mapped[str] = mapped_column(String(150), nullable=False)
    title_field_id: Mapped[UUID | None] = mapped_column(nullable=True, index=True)
    department: Mapped["Department"] = relationship(back_populates="modules")
    fields: Mapped[list["Field"]] = relationship(
        foreign_keys="Field.module_id",
        back_populates="module",
    )
    records: Mapped[list["Record"]] = relationship(back_populates="module")
    relationship_target_fields: Mapped[list["Field"]] = relationship(
        foreign_keys="Field.relationship_target_module_id",
        back_populates="relationship_target_module",
    )
