"""Ordinary settings and private preferences; no retention or protected command bodies."""

from datetime import datetime
from typing import Annotated, Any, Literal, Self
from uuid import UUID

from pydantic import (
    AwareDatetime,
    Field,
    StrictBool,
    field_validator,
    model_validator,
)

from app.systems.comms.capabilities import CAPABILITIES
from app.systems.comms.messages.schemas import WireModel
from app.systems.comms.settings.resolution import ClockTime, SettingsValues, _paired_hours


class Notifications(WireModel):
    notification_mode: Literal["all", "mentions", "none"] | None = None
    keywords: list[str] | None = None
    notify_followed_threads: StrictBool | None = None
    quiet_hours_start: ClockTime | None = None
    quiet_hours_end: ClockTime | None = None
    notification_sound: StrictBool | None = None
    notification_badges: StrictBool | None = None
    notification_preview: StrictBool | None = None
    desktop_notifications: StrictBool | None = None

    def selected(self) -> dict[str, Any]:
        return {key: getattr(self, key) for key in self.model_fields_set}

    @model_validator(mode="after")
    def valid_values(self) -> Self:
        values = self.selected()
        SettingsValues.model_validate(values)
        if not _paired_hours(values):
            raise ValueError("Set or clear both quiet-hour endpoints")
        if self.keywords is not None:
            self.keywords = SettingsValues(keywords=self.keywords).keywords
        return self


class Shortcuts(WireModel):
    search: str = Field(strict=True)
    new_message: str = Field(strict=True)


class PersonalPreferences(WireModel):
    density: Literal["comfortable", "compact"]
    text_size: Literal["small", "medium", "large"]
    timestamps: Literal["time", "full", "none"]
    group_messages: StrictBool
    avatars: StrictBool
    previews: StrictBool
    send_shortcut: Literal["enter", "ctrl-enter"]
    shortcuts: Shortcuts
    channel_width: int = Field(gt=0, strict=True)
    member_width: int = Field(gt=0, strict=True)
    thread_width: int = Field(gt=0, strict=True)
    notifications: Notifications


def personal_defaults() -> PersonalPreferences:
    return PersonalPreferences(
        density="comfortable",
        text_size="medium",
        timestamps="time",
        group_messages=True,
        avatars=True,
        previews=True,
        send_shortcut="enter",
        shortcuts=Shortcuts(search="Alt+F", new_message="Alt+N"),
        channel_width=240,
        member_width=220,
        thread_width=380,
        notifications=Notifications(),
    )


class MuteOff(WireModel):
    kind: Literal["off", "indefinite"]


class MuteUntil(WireModel):
    kind: Literal["until"]
    until: AwareDatetime

    @field_validator("until", mode="before")
    @classmethod
    def timestamp(cls, value: object) -> object:
        if not isinstance(value, str | datetime):
            raise ValueError("An offset timestamp is required")
        return value


Mute = Annotated[MuteOff | MuteUntil, Field(discriminator="kind")]


class MemberPreferencesPatch(WireModel):
    notify: Literal["all", "mentions", "mute"] | None = None
    mute: Mute | None = None
    starred: StrictBool | None = None
    hidden: StrictBool | None = None
    manual_unread: StrictBool | None = None

    @model_validator(mode="after")
    def nonempty(self) -> Self:
        if not self.model_fields_set or any(
            getattr(self, key) is None for key in self.model_fields_set
        ):
            raise ValueError("Provide non-null preference fields")
        return self


class CategoryPreferencesRequest(WireModel):
    collapsed: StrictBool
    mute: Mute


class WorkspaceScope(WireModel):
    kind: Literal["workspace"]


class CategoryScope(WireModel):
    kind: Literal["category"]
    id: UUID


class ChannelScope(WireModel):
    kind: Literal["channel"]
    id: UUID


SettingsScope = Annotated[
    WorkspaceScope | CategoryScope | ChannelScope, Field(discriminator="kind")
]


class ResolvedValues(SettingsValues):
    dm_rule: Literal["everyone", "shared-channel", "none"] = Field("everyone", exclude=True)


class SettingsResponse(WireModel):
    org_id: UUID
    scope: SettingsScope
    effective: ResolvedValues
    overrides: dict[str, Any]
    sources: dict[str, dict[str, Any]]
    locked_keys: list[str]
    metadata: list[dict[str, str]]


class WorkspaceSettingsResponse(SettingsResponse):
    scope: WorkspaceScope
    dm_rule: Literal["everyone", "shared-channel", "none"]


class SettingsPatch(SettingsValues):
    @model_validator(mode="after")
    def nonempty(self) -> Self:
        if not self.model_fields_set or not _paired_hours(self.model_dump(exclude_unset=True)):
            raise ValueError("Provide settings and paired quiet-hour endpoints")
        return self


class SettingLocks(WireModel):
    keys: list[str]

    @field_validator("keys")
    @classmethod
    def keys_valid(cls, keys: list[str]) -> list[str]:
        if len(set(keys)) != len(keys) or set(keys) - (
            SettingsValues.model_fields.keys() - {"dm_rule"}
        ):
            raise ValueError("Unknown or duplicate setting keys")
        return keys


class SettingsReset(SettingLocks):
    keys: list[str] = Field(min_length=1)


class CapabilityLocks(WireModel):
    capabilities: list[str]

    @field_validator("capabilities")
    @classmethod
    def valid_capabilities(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values) or set(values) - (
            set(CAPABILITIES) - {"manageWorkspace"}
        ):
            raise ValueError("Unknown or duplicate lockable capabilities")
        return values


class CapabilityGrant(WireModel):
    group_id: UUID
    capability: str


class CapabilityConfiguration(WireModel):
    scope: SettingsScope
    group_grants: list[CapabilityGrant]
    everyone: dict[str, StrictBool]


class CapabilityDecision(WireModel):
    allowed: bool
    source: dict[str, Any]


class CapabilityCheck(WireModel):
    org_id: UUID
    user_id: UUID
    conversation_id: UUID
    category_id: UUID | None
    membership_role: Literal["admin", "member", "guest"]
    conversation_level: Literal["none", "read", "post", "manage"]
    manager_source: Literal["creator", "membership_manager", "department_manager"] | None
    access_source: dict[str, Any]
    capabilities: dict[str, CapabilityDecision]


class CreationQuery(WireModel):
    scope_kind: Literal["workspace", "category"] = "workspace"
    category_id: UUID | None = None

    @model_validator(mode="after")
    def scope_identity(self) -> Self:
        if (self.scope_kind == "category") != (self.category_id is not None):
            raise ValueError("Category scope requires exactly one category ID")
        return self


class CreationCheck(WireModel):
    org_id: UUID
    user_id: UUID
    scope: WorkspaceScope | CategoryScope
    membership_role: Literal["admin", "member", "guest"]
    decision: CapabilityDecision
