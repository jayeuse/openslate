from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class SavedView(BaseModel):
    __tablename__ = "saved_views"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"definition"})
    __table_args__ = (
        CheckConstraint("visibility IN ('private', 'workspace')", name="ck_saved_views_visibility"),
        CheckConstraint("revision > 0", name="ck_saved_views_revision"),
        Index("ix_saved_views_owner_module", "owner_id", "module_id"),
        Index(
            "ix_saved_views_shared_module",
            "module_id",
            postgresql_where=text("visibility = 'workspace'"),
        ),
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), index=True
    )
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    name: Mapped[str] = mapped_column(String(200))
    visibility: Mapped[str] = mapped_column(String(20))
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB)
