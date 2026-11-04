"""Installation-wide health samples, worker signals and the server error log (S5, S6).

None of these rows is an application change a person makes, so none is audited. Samples and
signals have no organization; a server error keeps the organization the request was bound to.
"""

from datetime import datetime
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PostgreSQLUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database.base import Base

PART_STATUSES = "('working','not_working','not_set_up')"
SIGNAL_KEYS = (
    "record_triggers",
    "report_scheduling",
    "comms_jobs",
    "provider_signout",
    "email_accepted",
    "email_failed",
)


class SystemHealthSample(Base):
    """One sample a minute for the whole installation: each part's word and check time."""

    __tablename__ = "system_health_samples"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "EXTRACT(SECOND FROM sampled_at) = 0", name="ck_system_health_samples_minute"
        ),
        CheckConstraint(
            f"data_status IN {PART_STATUSES} AND signing_in_status IN {PART_STATUSES} "
            f"AND files_status IN {PART_STATUSES}",
            name="ck_system_health_samples_part_status",
        ),
        CheckConstraint(
            "email_status IN ('working','not_working','set_up','not_set_up')",
            name="ck_system_health_samples_email_status",
        ),
        CheckConstraint(
            "(data_ms IS NULL OR data_ms >= 0) AND (signing_in_ms IS NULL OR signing_in_ms >= 0) "
            "AND (files_ms IS NULL OR files_ms >= 0)",
            name="ck_system_health_samples_ms",
        ),
        CheckConstraint(
            "database_bytes IS NULL OR database_bytes >= 0",
            name="ck_system_health_samples_database_bytes",
        ),
    )

    sampled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    data_status: Mapped[str] = mapped_column(Text, nullable=False)
    data_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    signing_in_status: Mapped[str] = mapped_column(Text, nullable=False)
    signing_in_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    files_status: Mapped[str] = mapped_column(Text, nullable=False)
    files_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    email_status: Mapped[str] = mapped_column(Text, nullable=False)
    database_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class SystemHealthSignal(Base):
    """When each in-app worker last ran, and when Auth last accepted or refused an email."""

    __tablename__ = "system_health_signals"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint(
            "key IN ('" + "','".join(SIGNAL_KEYS) + "')", name="ck_system_health_signals_key"
        ),
    )

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ServerError(Base):
    """A 5xx response: its reference, status, method and route template, never request data."""

    __tablename__ = "server_errors"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        CheckConstraint("status BETWEEN 500 AND 599", name="ck_server_errors_status"),
        CheckConstraint("method ~ '^[A-Z]{3,7}$'", name="ck_server_errors_method"),
        CheckConstraint("char_length(route) <= 200", name="ck_server_errors_route"),
        Index("ix_server_errors_occurred_at", "occurred_at"),
        Index("ix_server_errors_org_occurred_at", "org_id", "occurred_at"),
    )

    request_id: Mapped[UUID] = mapped_column(PostgreSQLUUID(as_uuid=True), primary_key=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    status: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    route: Mapped[str] = mapped_column(Text, nullable=False)
    org_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=True
    )
