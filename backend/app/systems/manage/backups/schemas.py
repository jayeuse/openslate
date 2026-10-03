"""Public metadata and bounded private host commands, without execution routes."""

import re
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.listing import SortOrder, StandardListRequest

Schedule = Literal["disabled", "daily", "weekly"]
RunState = Literal["queued", "running", "succeeded", "failed", "interrupted"]
RetentionDays = Literal[7, 30, 90]
FailureCode = Literal[
    "backup_failed",
    "backup_interrupted",
    "verification_failed",
    "restart_failed",
    "readiness_failed",
    "result_unconfirmed",
    "retention_failed",
]
VERSION_PATTERN = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
RELEASE_PREFIX = "https://github.com/jayeuse/openslate/releases/tag/"


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BackupPolicyUpdate(StrictRequest):
    revision: int = Field(strict=True, ge=1)
    schedule: Schedule | None = None
    retention_days: RetentionDays | None = None

    @field_validator("retention_days", mode="before")
    @classmethod
    def strict_retention(cls, value: Any) -> Any:
        if type(value) is not int:
            raise ValueError("Retention must be 7, 30 or 90 days")
        return value

    @model_validator(mode="after")
    def require_change(self) -> "BackupPolicyUpdate":
        changes = self.model_fields_set - {"revision"}
        if not changes or any(getattr(self, field) is None for field in changes):
            raise ValueError("At least one non-null backup policy field is required")
        return self


class BackupCreate(StrictRequest):
    name: str = Field(min_length=1, max_length=120)

    @field_validator("name", mode="before")
    @classmethod
    def clean_name(cls, value: Any) -> Any:
        if isinstance(value, str):
            value = value.strip()
            if any(not char.isprintable() for char in value):
                raise ValueError("Name must be printable text")
        return value


class BackupPolicyResponse(BaseModel):
    schedule: Schedule
    retention_days: RetentionDays
    revision: int
    timezone: str
    next_due_at: datetime | None
    adopted: bool


class BackupRunResponse(BaseModel):
    id: UUID
    name: str
    provenance: Literal["manual", "scheduled"]
    installation: Literal["current", "previous"]
    state: RunState
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    reconciled_at: datetime | None
    schedule: Schedule
    retention_days: RetentionDays
    snapshot_id: str | None
    manifest_sha256: str | None
    verified_at: datetime | None
    failure_code: str | None
    expired_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class RunnerResponse(BaseModel):
    state: Literal["unknown", "available", "stale", "recovery_required", "adoption_required"]
    last_seen_at: datetime | None


class BackupStatusResponse(BaseModel):
    policy: BackupPolicyResponse
    runner: RunnerResponse
    active_run: BackupRunResponse | None
    queued_count: int


class VersionResponse(BaseModel):
    current_version: str
    status: Literal["unknown", "available", "current", "unavailable", "stale"]
    latest_version: str | None
    observed_at: datetime | None
    checked_at: datetime | None
    failure_code: str | None
    release_url: str | None


class BackupSort(StrEnum):
    REQUESTED_AT = "requested_at"
    NAME = "name"
    STATE = "state"
    PROVENANCE = "provenance"
    FINISHED_AT = "finished_at"


class BackupListRequest(StandardListRequest[BackupSort]):
    sort_order: SortOrder = SortOrder.DESC
    state: RunState | None = None
    provenance: Literal["manual", "scheduled"] | None = None
    installation: Literal["current", "previous"] | None = None
    run_id: UUID | None = None


class BridgeCommand(StrictRequest):
    installation_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,62}$")
    project: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,62}$")


class InspectCommand(BridgeCommand):
    op: Literal["inspect"]
    run_id: UUID | None = None
    claim_id: UUID | None = None

    @model_validator(mode="after")
    def require_claim(self) -> "InspectCommand":
        if self.run_id is not None and self.claim_id is None:
            raise ValueError("An exact run lookup requires a claim identity")
        return self


class ClaimCommand(BridgeCommand):
    op: Literal["claim"]
    claim_id: UUID


class HeartbeatCommand(BridgeCommand):
    """The runner is still working on this claim (sent after services resume)."""

    op: Literal["heartbeat"]
    claim_id: UUID


class OutcomeCommand(BridgeCommand):
    op: Literal["outcome"]
    run_id: UUID
    claim_id: UUID
    state: Literal["succeeded", "failed", "interrupted"]
    finished_at: AwareDatetime
    reconciled_at: AwareDatetime | None
    snapshot_id: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    manifest_sha256: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    verified_at: AwareDatetime | None
    failure_code: FailureCode | None

    @model_validator(mode="after")
    def coherent_result(self) -> "OutcomeCommand":
        facts = (self.snapshot_id, self.manifest_sha256, self.verified_at)
        if any(value is None for value in facts) and not all(value is None for value in facts):
            raise ValueError("Snapshot verification requires all three facts")
        if self.state == "succeeded":
            if (
                self.verified_at is None
                or self.reconciled_at is None
                or self.failure_code is not None
            ):
                raise ValueError("Success requires verified and reconciled evidence")
        elif self.failure_code is None:
            raise ValueError("A failed/interrupted result requires a safe failure code")
        if self.reconciled_at is not None and self.reconciled_at < self.finished_at:
            raise ValueError("Reconciliation must follow completion")
        if self.verified_at is not None and self.verified_at > self.finished_at:
            raise ValueError("Verification must precede completion")
        return self


class ReleaseCommand(BridgeCommand):
    op: Literal["release"]
    checked_at: AwareDatetime
    version: str | None = Field(max_length=40)
    release_url: str | None = Field(max_length=160)
    failure_code: Literal["release_unavailable", "release_invalid", "release_timeout"] | None

    @model_validator(mode="after")
    def stable_release(self) -> "ReleaseCommand":
        if self.failure_code is not None:
            if self.version is not None or self.release_url is not None:
                raise ValueError("A failed observation cannot replace the last release")
        elif (
            self.version is None
            or not VERSION_PATTERN.fullmatch(self.version)
            or self.release_url
            not in {RELEASE_PREFIX + self.version, RELEASE_PREFIX + "v" + self.version}
        ):
            raise ValueError("A successful observation requires a stable repository release")
        return self


class ExpireCommand(BridgeCommand):
    op: Literal["expire"]
    run_id: UUID
    claim_id: UUID
    snapshot_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    expired_at: AwareDatetime


class RestoreFinalizedMarker(StrictRequest):
    format_version: Literal[3]
    snapshot_id: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_installation_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,62}$")
    target_project: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,62}$")
    target_instance_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,62}$")
    target_db_container_id: str = Field(pattern=r"^[0-9a-f]{12,64}$")
    completed_at: AwareDatetime
    application_sessions_invalidated: bool = Field(strict=True)

    @model_validator(mode="after")
    def completed_restore(self) -> "RestoreFinalizedMarker":
        if (
            not self.application_sessions_invalidated
            or self.source_installation_id == self.target_instance_id
        ):
            raise ValueError("Restore must finalize a distinct target and invalidate sessions")
        return self


class AdoptCommand(BridgeCommand):
    op: Literal["adopt"]
    restore_marker: RestoreFinalizedMarker


class ClaimResponse(BaseModel):
    run: BackupRunResponse
    claim_id: UUID
    installation_id: str
    scheduled_for: datetime | None
    claimed_schedule: Schedule
    claimed_retention_days: RetentionDays
