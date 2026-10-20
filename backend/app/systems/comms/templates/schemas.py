"""The existing ordinary settings/capability vocabulary, bounded as a single JSON document."""

import json
from datetime import datetime
from typing import Any, Self
from uuid import UUID

from pydantic import Field, StrictBool, field_validator, model_validator

from app.systems.comms.capabilities import (
    CONVERSATION_CAPABILITIES,
    GROUP_SCOPES,
    POSTER_CAPABILITIES,
)
from app.systems.comms.messages.schemas import WireModel
from app.systems.comms.settings.resolution import SettingsValues, _paired_hours
from app.systems.comms.settings.schemas import CapabilityGrant, SettingLocks

TEMPLATE_BYTES = 64 * 1024


class TemplateCapabilities(WireModel):
    group_grants: list[CapabilityGrant]
    everyone: dict[str, StrictBool]

    @model_validator(mode="after")
    def channel_only(self) -> Self:
        pairs = [(row.group_id, row.capability) for row in self.group_grants]
        if (
            len(pairs) != len(set(pairs))
            or set(self.everyone) - set(POSTER_CAPABILITIES)
            or any(
                "channel" not in GROUP_SCOPES.get(row.capability, ()) for row in self.group_grants
            )
        ):
            raise ValueError("Only distinct channel capability grants and switches are permitted")
        return self


class TemplateImport(WireModel):
    name: str = Field(min_length=1, max_length=255)
    description: str
    settings: dict[str, Any]
    capabilities: TemplateCapabilities = Field(
        default_factory=lambda: TemplateCapabilities(group_grants=[], everyone={}),
    )

    @field_validator("name", mode="before")
    @classmethod
    def name_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("settings")
    @classmethod
    def ordinary_settings(cls, value: dict[str, Any]) -> dict[str, Any]:
        if "dm_rule" in value or not _paired_hours(value):
            raise ValueError("Use ordinary channel settings and paired quiet hours")
        return SettingsValues.model_validate(value).model_dump(mode="json", exclude_unset=True)

    @model_validator(mode="after")
    def bounded_document(self) -> Self:
        value = self.model_dump(mode="json", exclude_unset=True)
        if (
            len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
            > TEMPLATE_BYTES
        ):
            raise ValueError("Template exceeds 64 KiB")
        if any("\x00" in item for item in (self.name, self.description)):
            raise ValueError("Template text cannot contain NUL")
        return self


class TemplateResponse(TemplateImport):
    id: UUID
    org_id: UUID
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def bounded_document(self) -> Self:
        # The cap applies to the imported document, not server-owned resource metadata.
        TemplateImport.model_validate(
            self.model_dump(
                include=set(TemplateImport.model_fields),
                exclude_unset=True,
            )
        )
        return self


class TemplateApply(SettingLocks):
    conversation_ids: list[UUID] = Field(min_length=1, max_length=100)
    capability_keys: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def selection(self) -> Self:
        if (
            len(self.conversation_ids) != len(set(self.conversation_ids))
            or len(self.capability_keys) != len(set(self.capability_keys))
            or set(self.capability_keys) - set(CONVERSATION_CAPABILITIES)
            or not (self.keys or self.capability_keys)
        ):
            raise ValueError("Select distinct targets and ordinary settings or capabilities")
        return self


class CapabilityPreview(WireModel):
    before: TemplateCapabilities
    after: TemplateCapabilities
    skipped_locked: list[str]


class ApplyPreviewItem(WireModel):
    conversation_id: UUID
    before: dict[str, Any]
    after: dict[str, Any]
    skipped_locked_keys: list[str]
    capabilities: CapabilityPreview | None = None


class TemplateApplyPreview(WireModel):
    items: list[ApplyPreviewItem]


class ApplyResultItem(WireModel):
    conversation_id: UUID
    applied_keys: list[str]
    skipped_locked_keys: list[str]
    applied_capabilities: list[str] | None = None
    skipped_locked_capabilities: list[str] | None = None


class TemplateApplyResult(WireModel):
    items: list[ApplyResultItem]
