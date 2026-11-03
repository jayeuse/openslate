"""The plain system status that every signed-in person may read."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

PartKey = Literal["data", "signing_in", "files", "email"]
PartStatus = Literal["working", "not_working", "not_set_up", "set_up"]
BackupState = Literal["on_time", "late", "no_schedule", "never_backed_up", "unknown"]
BackupResult = Literal["verified", "failed", "interrupted"]


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


class SystemStatusResponse(BaseModel):
    parts: list[SystemPart]
    version: str
    checked_at: datetime
    # Always present; null for everyone but an admin of the bound organization.
    organization: OrganizationStatus | None
