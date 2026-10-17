from typing import TYPE_CHECKING, ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.sandbox.modules.models import Module


class Department(BaseModel):
    __tablename__ = "departments"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_departments_org_id_id"),
        CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_departments_lifecycle_close_provenance",
        ),
        Index(
            "uq_departments_name_active",
            "org_id",
            "department_name",
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
    department_name: Mapped[str] = mapped_column(String(150), nullable=False)
    modules: Mapped[list["Module"]] = relationship(back_populates="department")
