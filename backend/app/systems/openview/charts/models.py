"""Audited owner-private persistence for the current live Chart settings."""

from typing import ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class UserChartPreference(BaseModel):
    """One versioned live Chart configuration owned by one current user."""

    __tablename__ = "openview_chart_preferences"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"config"})
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_openview_chart_preferences_user_id"),
        CheckConstraint(
            "jsonb_typeof(config) = 'object' AND config->>'version' = '1'",
            name="ck_openview_chart_preferences_config_version",
        ),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    config: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
