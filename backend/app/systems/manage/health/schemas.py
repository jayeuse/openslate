"""The plain system status that every signed-in person may read."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.common.listing.schemas import PaginationMetadata

PartKey = Literal["data", "signing_in", "files", "email"]
PartStatus = Literal["working", "slow", "not_working", "not_set_up", "set_up"]
PeriodKind = Literal["not_working", "slow"]
BackupState = Literal["on_time", "late", "no_schedule", "never_backed_up", "unknown"]
BackupResult = Literal["verified", "failed", "interrupted"]
WorkerKey = Literal[
    "record_triggers", "report_scheduling", "comms_jobs", "provider_signout", "backup_runner"
]
WorkerState = Literal["running", "not_seen", "never_seen"]


class SystemPart(BaseModel):
    key: PartKey
    status: PartStatus


class OrganizationBackups(BaseModel):
    state: BackupState
    last_success_at: datetime | None
    last_result: BackupResult | None


class OrganizationStatus(BaseModel):
    """Freshness and counts for an admin of the bound organization; never sizes or run lists."""

    since: datetime
    backups: OrganizationBackups
    failed_jobs: int | None
    failed_sign_ins: int
    lockouts: int
    # Bytes of the organization's stored files; null when the server cannot read them.
    storage_used_bytes: int | None


class InstallationWorker(BaseModel):
    key: WorkerKey
    state: WorkerState
    last_seen_at: datetime | None


class InstallationStatus(BaseModel):
    """Installation-wide values for the installation owner only (R4)."""

    database_bytes: int | None
    database_measured_at: datetime | None
    workers: list[InstallationWorker]


class SystemStatusResponse(BaseModel):
    parts: list[SystemPart]
    version: str
    checked_at: datetime
    # Always present; null for everyone but an admin of the bound organization.
    organization: OrganizationStatus | None
    # Always present; null for everyone but the installation owner.
    installation: InstallationStatus | None


class HealthPeriod(BaseModel):
    part: PartKey
    kind: PeriodKind
    started_at: datetime
    # Null while the period still goes on.
    ended_at: datetime | None


class HealthPeriodListResponse(BaseModel):
    items: list[HealthPeriod]
    pagination: PaginationMetadata
    # The oldest kept sample, so the page does not claim days that were not checked.
    oldest_sample_at: datetime | None
