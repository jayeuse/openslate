from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ForeignKey, Index, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.sandbox.departments.models import Department
    from app.systems.sandbox.fields.models import Field
    from app.systems.sandbox.records.models import Record


class Module(BaseModel):
    __tablename__ = "modules"
    __table_args__ = (
        Index(
            "uq_modules_department_name_active",
            "department_id",
            "module_name",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    department_id: Mapped[UUID] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    module_name: Mapped[str] = mapped_column(String(150), nullable=False)
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
