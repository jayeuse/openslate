from typing import TYPE_CHECKING

from sqlalchemy import Index, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.sandbox.modules.models import Module


class Department(BaseModel):
    __tablename__ = "departments"
    __table_args__ = (
        Index(
            "uq_departments_name_active",
            "department_name",
            unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    department_name: Mapped[str] = mapped_column(String(150), nullable=False)
    modules: Mapped[list["Module"]] = relationship(back_populates="department")
