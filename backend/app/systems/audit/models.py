from enum import StrEnum
from typing import Any, ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, Index, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class AuditAction(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"


class AuditLog(BaseModel):
    __tablename__ = "audit_logs"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "action IN ('create', 'update', 'delete')",
            name="ck_audit_logs_action",
        ),
        Index("ix_audit_logs_created_at_id", "created_at", "id"),
        Index("ix_audit_logs_record", "table_name", "record_id", "created_at"),
        Index("ix_audit_logs_actor", "performed_by", "created_at"),
        Index("ix_audit_logs_action", "action"),
    )

    action: Mapped[AuditAction] = mapped_column(String(16), nullable=False)
    table_name: Mapped[str] = mapped_column(String(255), nullable=False)
    record_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=False)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    request_id: Mapped[UUID | None] = mapped_column(PostgreSQLUUID(as_uuid=True), nullable=True)
    request_method: Mapped[str | None] = mapped_column(String(16), nullable=True)
    request_path: Mapped[str | None] = mapped_column(String(2048), nullable=True)
