"""Audited persistence for the shared saved views of each module."""

from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class SavedView(BaseModel):
    """A shared view of one module. Module readers see it; managers change it.

    At most one active view of a module is its default.
    """

    __tablename__ = "saved_views"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"definition", "presentation"})
    __table_args__ = (
        CheckConstraint("revision > 0", name="ck_saved_views_revision"),
        UniqueConstraint("id", "module_id", name="uq_saved_views_id_module"),
        Index(
            "uq_saved_views_module_default",
            "module_id",
            unique=True,
            postgresql_where=text("is_default AND NOT is_deleted"),
        ),
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_default: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False
    )
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    presentation: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        default=lambda: {"version": 1},
        server_default=text("'{\"version\": 1}'::jsonb"),
        nullable=False,
    )
