"""Audited installation policy, immutable request history, and release observations."""

from datetime import datetime
from typing import ClassVar
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BackupPolicy(BaseModel):
    __tablename__ = "backup_policies"
    __table_args__ = (
        CheckConstraint("singleton_key = true", name="ck_backup_policies_singleton"),
        CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_policies_live"),
        CheckConstraint("revision >= 1", name="ck_backup_policies_revision"),
        CheckConstraint(
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_policies_identity"
        ),
        CheckConstraint(
            "schedule IN ('disabled','daily','weekly')", name="ck_backup_policies_schedule"
        ),
        CheckConstraint("retention_days IN (7,30,90)", name="ck_backup_policies_retention"),
        CheckConstraint(
            "schedule <> 'disabled' OR next_due_at IS NULL", name="ck_backup_policies_disabled_due"
        ),
        UniqueConstraint("singleton_key", name="uq_backup_policies_singleton"),
    )

    singleton_key: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    installation_id: Mapped[str] = mapped_column(String(63), nullable=False)
    schedule: Mapped[str] = mapped_column(String(8), default="disabled", server_default="disabled")
    retention_days: Mapped[int] = mapped_column(Integer, default=30, server_default=text("30"))
    revision: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"))
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    next_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    runner_last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BackupRun(BaseModel):
    __tablename__ = "backup_runs"
    __table_args__ = (
        CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_runs_live"),
        CheckConstraint(
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_runs_identity"
        ),
        CheckConstraint(
            "length(name) BETWEEN 1 AND 120 AND name = btrim(name) AND name !~ '[[:cntrl:]]'",
            name="ck_backup_runs_name",
        ),
        CheckConstraint("provenance IN ('manual','scheduled')", name="ck_backup_runs_provenance"),
        CheckConstraint(
            "state IN ('queued','running','succeeded','failed','interrupted')",
            name="ck_backup_runs_state",
        ),
        CheckConstraint(
            "schedule IN ('disabled','daily','weekly')", name="ck_backup_runs_schedule"
        ),
        CheckConstraint("retention_days IN (7,30,90)", name="ck_backup_runs_retention"),
        CheckConstraint(
            "(provenance = 'manual' AND idempotency_hash IS NOT NULL AND scheduled_for IS NULL) "
            "OR (provenance = 'scheduled' AND idempotency_hash IS NULL "
            "AND requester_id IS NULL AND scheduled_for IS NOT NULL)",
            name="ck_backup_runs_request",
        ),
        CheckConstraint(
            "(started_at IS NULL AND claim_id IS NULL AND claimed_schedule IS NULL "
            "AND claimed_retention_days IS NULL AND state = 'queued' AND finished_at IS NULL "
            "AND reconciled_at IS NULL) OR (started_at IS NOT NULL AND claim_id IS NOT NULL "
            "AND claimed_schedule IS NOT NULL AND claimed_retention_days IS NOT NULL "
            "AND claimed_schedule IN ('disabled','daily','weekly') "
            "AND claimed_retention_days IN (7,30,90) AND state <> 'queued')",
            name="ck_backup_runs_claim",
        ),
        CheckConstraint(
            "(state IN ('queued','running') AND finished_at IS NULL AND failure_code IS NULL "
            "AND reconciled_at IS NULL) OR (state = 'succeeded' AND finished_at IS NOT NULL "
            "AND reconciled_at IS NOT NULL AND verified_at IS NOT NULL AND failure_code IS NULL) "
            "OR (state IN ('failed','interrupted') AND finished_at IS NOT NULL "
            "AND failure_code IS NOT NULL)",
            name="ck_backup_runs_outcome",
        ),
        CheckConstraint(
            "(snapshot_id IS NULL AND manifest_sha256 IS NULL AND verified_at IS NULL) "
            "OR (snapshot_id IS NOT NULL AND manifest_sha256 IS NOT NULL "
            "AND snapshot_id ~ '^[0-9a-f]{64}$' AND manifest_sha256 ~ '^[0-9a-f]{64}$' "
            "AND verified_at IS NOT NULL AND started_at IS NOT NULL)",
            name="ck_backup_runs_verification",
        ),
        CheckConstraint(
            "(started_at IS NULL OR started_at >= requested_at) "
            "AND (finished_at IS NULL OR finished_at >= started_at) "
            "AND (verified_at IS NULL OR verified_at BETWEEN started_at AND finished_at) "
            "AND (reconciled_at IS NULL OR reconciled_at >= finished_at) "
            "AND (expired_at IS NULL OR (verified_at IS NOT NULL AND reconciled_at IS NOT NULL "
            "AND expired_at >= verified_at))",
            name="ck_backup_runs_times",
        ),
        UniqueConstraint("claim_id", name="uq_backup_runs_claim_id"),
        CheckConstraint(
            "failure_code IS NULL OR failure_code IN ('backup_failed','backup_interrupted',"
            "'verification_failed','restart_failed','readiness_failed','result_unconfirmed',"
            "'retention_failed')",
            name="ck_backup_runs_failure_code",
        ),
        UniqueConstraint(
            "installation_id", "requester_id", "idempotency_hash", name="uq_backup_runs_idempotency"
        ),
        UniqueConstraint(
            "installation_id", "scheduled_for", name="uq_backup_runs_scheduled_occurrence"
        ),
        Index(
            "uq_backup_runs_unresolved",
            "installation_id",
            unique=True,
            postgresql_where=text("started_at IS NOT NULL AND reconciled_at IS NULL"),
        ),
        Index("ix_backup_runs_queue", "installation_id", "state", "requested_at"),
        Index("ix_backup_runs_requester_id", "requester_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"idempotency_hash"})

    installation_id: Mapped[str] = mapped_column(String(63), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    provenance: Mapped[str] = mapped_column(String(9), nullable=False)
    requester_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    idempotency_hash: Mapped[str | None] = mapped_column(String(64))
    schedule: Mapped[str] = mapped_column(String(8), nullable=False)
    retention_days: Mapped[int] = mapped_column(Integer, nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    state: Mapped[str] = mapped_column(String(11), default="queued", server_default="queued")
    claim_id: Mapped[UUID | None] = mapped_column()
    claimed_schedule: Mapped[str | None] = mapped_column(String(8))
    claimed_retention_days: Mapped[int | None] = mapped_column(Integer)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    snapshot_id: Mapped[str | None] = mapped_column(String(64))
    manifest_sha256: Mapped[str | None] = mapped_column(String(64))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(48))
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UpdateStatus(BaseModel):
    __tablename__ = "update_statuses"
    __table_args__ = (
        CheckConstraint("singleton_key = true", name="ck_update_statuses_singleton"),
        CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_update_statuses_live"),
        CheckConstraint(
            "(latest_version IS NULL AND release_url IS NULL AND observed_at IS NULL) "
            "OR (latest_version IS NOT NULL AND release_url IS NOT NULL "
            "AND observed_at IS NOT NULL)",
            name="ck_update_statuses_observation",
        ),
        CheckConstraint(
            "observed_at IS NULL OR (checked_at IS NOT NULL AND checked_at >= observed_at)",
            name="ck_update_statuses_times",
        ),
        CheckConstraint(
            "failure_code IS NULL OR failure_code IN "
            "('release_unavailable','release_invalid','release_timeout')",
            name="ck_update_statuses_failure_code",
        ),
        UniqueConstraint("singleton_key", name="uq_update_statuses_singleton"),
    )
    singleton_key: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    latest_version: Mapped[str | None] = mapped_column(String(40))
    release_url: Mapped[str | None] = mapped_column(String(160))
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(48))


class BackupExportOperation(BaseModel):
    """One installation-fenced encrypted export; no soft-delete lifecycle."""

    __tablename__ = "backup_export_operations"
    __table_args__ = (
        CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_exports_live"),
        CheckConstraint(
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_exports_identity"
        ),
        CheckConstraint(
            "idempotency_hash ~ '^[0-9a-f]{64}$' AND payload_hmac ~ '^[0-9a-f]{64}$'",
            name="ck_backup_exports_request",
        ),
        CheckConstraint(
            "state IN ('queued','preparing','ready','failed','interrupted')",
            name="ck_backup_exports_state",
        ),
        CheckConstraint(
            "(state = 'queued' AND claim_id IS NULL AND claimed_at IS NULL AND "
            "encrypted_passphrase IS NOT NULL) "
            "OR (state <> 'queued' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL "
            "AND encrypted_passphrase IS NULL)",
            name="ck_backup_exports_claim",
        ),
        CheckConstraint(
            "(state IN ('queued','preparing') AND finished_at IS NULL AND failure_code IS NULL) "
            "OR (state = 'ready' AND finished_at IS NOT NULL AND failure_code IS NULL) "
            "OR (state IN ('failed','interrupted') AND finished_at IS NOT NULL AND "
            "failure_code IS NOT NULL)",
            name="ck_backup_exports_outcome",
        ),
        CheckConstraint(
            "(state = 'ready' AND ready_at IS NOT NULL AND expires_at IS NOT NULL "
            "AND size_bytes IS NOT NULL AND size_bytes > 0 AND sha256 IS NOT NULL "
            "AND sha256 ~ '^[0-9a-f]{64}$' AND expires_at = ready_at + interval '24 hours') "
            "OR (state <> 'ready' AND ready_at IS NULL AND expires_at IS NULL AND "
            "size_bytes IS NULL AND sha256 IS NULL)",
            name="ck_backup_exports_artifact",
        ),
        CheckConstraint(
            "(admission_digest IS NULL AND admission_actor_id IS NULL AND "
            "admission_session_id IS NULL AND admission_expires_at IS NULL) "
            "OR (state = 'ready' AND artifact_deleted_at IS NULL AND admission_digest IS NOT NULL "
            "AND admission_digest ~ '^[0-9a-f]{64}$' AND admission_actor_id IS NOT NULL "
            "AND admission_session_id IS NOT NULL AND admission_expires_at IS NOT NULL "
            "AND admission_expires_at <= expires_at)",
            name="ck_backup_exports_admission",
        ),
        CheckConstraint(
            "artifact_deleted_at IS NULL OR (state = 'ready' AND artifact_deleted_at >= "
            "expires_at)",
            name="ck_backup_exports_deletion",
        ),
        CheckConstraint(
            "(claimed_at IS NULL OR claimed_at >= requested_at) "
            "AND (finished_at IS NULL OR finished_at >= claimed_at) "
            "AND (ready_at IS NULL OR ready_at >= claimed_at)",
            name="ck_backup_exports_times",
        ),
        CheckConstraint(
            "failure_code IS NULL OR failure_code IN "
            "('source_unavailable','source_unproven','copy_failed','verification_failed'"
            ",'export_interrupted','result_unconfirmed')",
            name="ck_backup_exports_failure_code",
        ),
        UniqueConstraint("claim_id", name="uq_backup_exports_claim_id"),
        UniqueConstraint(
            "installation_id",
            "requester_id",
            "idempotency_hash",
            name="uq_backup_exports_idempotency",
        ),
        Index(
            "uq_backup_exports_unresolved",
            "installation_id",
            unique=True,
            postgresql_where=text("state = 'preparing'"),
        ),
        Index("ix_backup_exports_queue", "installation_id", "state", "requested_at"),
        Index(
            "ix_backup_exports_cleanup",
            "installation_id",
            "expires_at",
            postgresql_where=text("state = 'ready' AND artifact_deleted_at IS NULL"),
        ),
        Index("ix_backup_exports_backup_run_id", "backup_run_id"),
        Index("ix_backup_exports_requester_id", "requester_id"),
    )
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {
            "encrypted_passphrase",
            "idempotency_hash",
            "payload_hmac",
            "admission_digest",
            "admission_session_id",
        }
    )

    installation_id: Mapped[str] = mapped_column(String(63), nullable=False)
    backup_run_id: Mapped[UUID] = mapped_column(
        ForeignKey("backup_runs.id", ondelete="RESTRICT"), nullable=False
    )
    requester_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    idempotency_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_hmac: Mapped[str] = mapped_column(String(64), nullable=False)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    state: Mapped[str] = mapped_column(String(11), default="queued", server_default="queued")
    claim_id: Mapped[UUID | None] = mapped_column()
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    encrypted_passphrase: Mapped[str | None] = mapped_column(String(2048))
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    sha256: Mapped[str | None] = mapped_column(String(64))
    failure_code: Mapped[str | None] = mapped_column(String(32))
    artifact_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    admission_digest: Mapped[str | None] = mapped_column(String(64))
    admission_actor_id: Mapped[UUID | None] = mapped_column()
    admission_session_id: Mapped[UUID | None] = mapped_column()
    admission_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
