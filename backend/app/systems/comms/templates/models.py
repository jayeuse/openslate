"""Template content is private configuration, not a second settings authority."""

from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Integer, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class CommsTemplate(BaseModel):
    __tablename__ = "comms_templates"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"document"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_templates_org_id_id"),
        CheckConstraint("jsonb_typeof(document) = 'object'", name="ck_comms_templates_document"),
        CheckConstraint("revision BETWEEN 1 AND 2147483647", name="ck_comms_templates_revision"),
    )
    org_id: Mapped[UUID] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"))
    document: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))
