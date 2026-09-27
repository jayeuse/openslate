from enum import StrEnum
from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class AudienceKind(StrEnum):
    PRIVATE = "private"
    EVERYONE = "everyone"
    USER = "user"


def _legacy_audience_default(context: Any) -> AudienceKind:
    """Keep older ORM callers compatible with the visibility projection."""

    visibility = context.get_current_parameters().get("visibility")
    return AudienceKind.EVERYONE if visibility == "workspace" else AudienceKind.PRIVATE


class SavedView(BaseModel):
    __tablename__ = "saved_views"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"definition", "presentation"})
    __table_args__ = (
        CheckConstraint("visibility IN ('private', 'workspace')", name="ck_saved_views_visibility"),
        CheckConstraint(
            "audience_kind IN ('private', 'everyone', 'user')",
            name="ck_saved_views_audience_kind",
        ),
        CheckConstraint("revision > 0", name="ck_saved_views_revision"),
        CheckConstraint(
            "(audience_kind = 'private' AND visibility = 'private' "
            "AND audience_user_id IS NULL) OR "
            "(audience_kind = 'everyone' AND visibility = 'workspace' "
            "AND audience_user_id IS NULL) OR "
            "(audience_kind = 'user' AND visibility = 'workspace' "
            "AND audience_user_id IS NOT NULL)",
            name="ck_saved_views_audience_reference",
        ),
        UniqueConstraint("id", "module_id", name="uq_saved_views_id_module"),
        Index("ix_saved_views_owner_module", "owner_id", "module_id"),
        Index(
            "ix_saved_views_everyone_module_active",
            "module_id",
            postgresql_where=text("audience_kind = 'everyone' AND is_deleted = false"),
        ),
        Index(
            "ix_saved_views_user_module_active",
            "audience_user_id",
            "module_id",
            postgresql_where=text("audience_kind = 'user' AND is_deleted = false"),
        ),
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    owner_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False)
    audience_kind: Mapped[AudienceKind] = mapped_column(
        String(20),
        default=_legacy_audience_default,
        server_default=text("'private'"),
        nullable=False,
    )
    audience_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
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


class SavedViewDefault(BaseModel):
    __tablename__ = "saved_view_defaults"
    __table_args__ = (
        UniqueConstraint("user_id", "module_id", name="uq_saved_view_defaults_user_module"),
        ForeignKeyConstraint(
            ["view_id", "module_id"],
            ["saved_views.id", "saved_views.module_id"],
            ondelete="CASCADE",
            name="fk_saved_view_defaults_view_module",
        ),
        Index("ix_saved_view_defaults_view_module", "view_id", "module_id"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("modules.id", ondelete="RESTRICT"), nullable=False
    )
    view_id: Mapped[UUID] = mapped_column(nullable=False)
