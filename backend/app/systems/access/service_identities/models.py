from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class ServiceIdentityStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class ServiceIdentity(BaseModel):
    __tablename__ = "service_identities"
    __table_args__ = (
        CheckConstraint("btrim(name) <> ''", name="ck_service_identities_name_not_blank"),
        CheckConstraint("btrim(purpose) <> ''", name="ck_service_identities_purpose_not_blank"),
        CheckConstraint("status IN ('active', 'disabled')", name="ck_service_identities_status"),
        Index("ix_service_identities_status_expires_at_id", "status", "expires_at", "id"),
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    role_id: Mapped[UUID] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20),
        default=ServiceIdentityStatus.ACTIVE.value,
        server_default=text("'active'"),
        nullable=False,
    )
