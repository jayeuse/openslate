from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.listing import StandardListRequest, StandardListResponse


class FilePurpose(StrEnum):
    RECORD_ATTACHMENT = "record_attachment"
    LIBRARY_DOCUMENT = "library_document"
    WORKSPACE_LOGO = "workspace_logo"


class FileState(StrEnum):
    AWAITING_UPLOAD = "awaiting_upload"
    UPLOADING = "uploading"
    PENDING_SCAN = "pending_scan"
    READY = "ready"
    REJECTED = "rejected"
    DELETING = "deleting"
    PURGED = "purged"


class FileCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    purpose: FilePurpose
    record_id: UUID | None = None
    filename: str = Field(min_length=1, max_length=255)
    expected_size: int = Field(gt=0, le=25 * 1024 * 1024, strict=True)

    @field_validator("filename")
    @classmethod
    def safe_filename(cls, value: str) -> str:
        if any(ord(char) < 32 or char in "/\\" for char in value) or value in {".", ".."}:
            raise ValueError("Filename must be a plain filename without control characters")
        return value

    @model_validator(mode="after")
    def purpose_matches_parent(self) -> "FileCreate":
        if (self.purpose == FilePurpose.RECORD_ATTACHMENT) != (self.record_id is not None):
            raise ValueError("Only record attachments require a record")
        if self.purpose == FilePurpose.WORKSPACE_LOGO and self.expected_size > 2 * 1024 * 1024:
            raise ValueError("Logos must not exceed 2 MiB")
        return self


class FileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    purpose: FilePurpose
    record_id: UUID | None
    creator_id: UUID
    filename: str
    media_type: str | None
    expected_size: int
    actual_size: int | None
    state: FileState
    failure_code: str | None
    is_deleted: bool
    created_at: datetime
    updated_at: datetime


class FileSortField(StrEnum):
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class FileListRequest(StandardListRequest[FileSortField]):
    purpose: FilePurpose
    record_id: UUID | None = None


class FileListResponse(StandardListResponse[FileResponse]):
    pass
