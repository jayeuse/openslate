from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class WorkspaceProfile(BaseModel):
    """The one configuration profile for this deployment."""

    __tablename__ = "workspace_profiles"
    __table_args__ = (
        CheckConstraint("singleton_key = true", name="ck_workspace_profiles_singleton_key"),
        CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL",
            name="ck_workspace_profiles_not_deleted",
        ),
        CheckConstraint(
            "invitation_expiry_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_invitation_expiry_days_range",
        ),
        CheckConstraint(
            "guest_duration_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_guest_duration_days_range",
        ),
        UniqueConstraint("singleton_key", name="uq_workspace_profiles_singleton_key"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"contact_email", "contact_phone", "postal_address"}
    )

    singleton_key: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        server_default=text("true"),
        nullable=False,
    )
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    legal_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    contact_email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    postal_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    logo_file_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="RESTRICT", use_alter=True),
        nullable=True,
    )
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    locale: Mapped[str] = mapped_column(String(35), nullable=False)
    invitation_expiry_days: Mapped[int] = mapped_column(
        Integer, default=7, server_default=text("7"), nullable=False
    )
    guest_duration_days: Mapped[int] = mapped_column(
        Integer, default=30, server_default=text("30"), nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer,
        default=1,
        server_default=text("1"),
        nullable=False,
    )
