"""Private file inventory; provider objects never define authorization."""

from datetime import datetime
from typing import ClassVar
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, SmallInteger, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class File(BaseModel):
    __tablename__ = "files"
    __table_args__ = (
        CheckConstraint(
            "(purpose = 'record_attachment' AND record_id IS NOT NULL "
            "AND board_id IS NULL AND department_id IS NULL) OR "
            "(purpose = 'board_attachment' AND board_id IS NOT NULL "
            "AND record_id IS NULL AND department_id IS NULL) OR "
            "(purpose = 'library_document' AND department_id IS NOT NULL "
            "AND record_id IS NULL AND board_id IS NULL) OR "
            "(purpose = 'workspace_logo' AND record_id IS NULL "
            "AND board_id IS NULL AND department_id IS NULL)",
            name="ck_files_purpose_parent",
        ),
        CheckConstraint(
            "state IN ('awaiting_upload','uploading','ready','rejected','deleting','purged')",
            name="ck_files_state",
        ),
        CheckConstraint(
            "expected_size > 0 AND expected_size <= 26214400", name="ck_files_expected_size"
        ),
        CheckConstraint(
            "actual_size IS NULL OR (actual_size > 0 AND actual_size <= 26214400)",
            name="ck_files_actual_size",
        ),
        CheckConstraint(
            "purpose != 'workspace_logo' OR expected_size <= 2097152", name="ck_files_logo_size"
        ),
        CheckConstraint(
            "state != 'ready' OR (digest IS NOT NULL AND actual_size IS NOT NULL)",
            name="ck_files_ready_verdict",
        ),
        CheckConstraint("enc_version IS NULL OR enc_version > 0", name="ck_files_enc_version"),
        CheckConstraint(
            "deletion_origin IS NULL OR (deletion_origin = 'logo_replacement' "
            "AND purpose = 'workspace_logo' AND is_deleted = true "
            "AND state = 'deleting' AND operation_id IS NOT NULL)",
            name="ck_files_deletion_origin",
        ),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {
            "filename",
            "object_key",
            "digest",
            "operation_id",
        }
    )
    purpose: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    record_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("records.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    board_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("boards.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    department_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("departments.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    creator_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    expected_size: Mapped[int] = mapped_column(Integer, nullable=False)
    actual_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    enc_version: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    object_key: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    state: Mapped[str] = mapped_column(String(30), nullable=False, default="awaiting_upload")
    operation_id: Mapped[UUID | None] = mapped_column(nullable=True)
    operation_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(60))
    deletion_origin: Mapped[str | None] = mapped_column(String(30), nullable=True)
