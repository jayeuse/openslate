"""HTTP and internal contracts for Sandbox publication review and application."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class PublicationPreviewRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")


class PublicationRequest(StrictModel):
    expected_revision: Annotated[int, Field(gt=0)] = Field(alias="expectedRevision")
    preview_token: Annotated[str, Field(min_length=1, max_length=8_192)] = Field(
        alias="previewToken"
    )
    impact_digest: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")] = Field(alias="impactDigest")
    password: Annotated[str, Field(min_length=1, max_length=128)]
    note: str | None = Field(default=None, max_length=1_000)


class PublicationChange(StrictModel):
    kind: Literal["department", "module", "field", "relationship", "automation"]
    action: Literal["create", "update", "close", "reopen"]
    sandbox_id: str = Field(alias="sandboxId", min_length=1, max_length=1_000)
    label: str = Field(min_length=1, max_length=150)


class PublicationBlocker(StrictModel):
    code: str
    message: str
    target_id: str | None = Field(default=None, alias="targetId")


class PublicationCounts(StrictModel):
    departments: int = 0
    modules: int = 0
    fields: int = 0
    relationships: int = 0
    automations: int = 0


class PublicationPreviewResponse(StrictModel):
    preview_token: str = Field(alias="previewToken")
    impact_digest: str = Field(alias="impactDigest")
    document_revision: int = Field(alias="documentRevision")
    document_hash: str = Field(alias="documentHash")
    expires_at: datetime = Field(alias="expiresAt")
    changes: list[PublicationChange]
    counts: PublicationCounts
    warnings: list[str]
    blockers: list[PublicationBlocker]


class PublicationVersion(StrictModel):
    id: UUID
    sequence: int
    kind: Literal["published"]
    label: str


class PublicationResponse(StrictModel):
    id: UUID
    version: PublicationVersion
    document_revision: int = Field(alias="documentRevision")
    document_hash: str = Field(alias="documentHash")
    impact_digest: str = Field(alias="impactDigest")
    published_at: datetime = Field(alias="publishedAt")
