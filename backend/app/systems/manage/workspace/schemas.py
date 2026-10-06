import re
from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from babel.core import Locale, UnknownLocaleError
from babel.numbers import is_currency
from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator

from app.common.normalization import normalize_email
from app.core.config import get_settings

_LOCALE_TAG_PATTERN = re.compile(
    r"^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?"
    r"(?:-(?:[0-9][A-Za-z0-9]{3}|[A-Za-z0-9]{5,8}))*$"
)
type WorkspaceTheme = Literal["slate", "whiteboard", "triplicate", "stockroom"]


class _WorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _trim_optional(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


class WorkspaceUpdate(_WorkspaceRequest):
    revision: int = Field(ge=1)
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    legal_name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    contact_email: str | None = Field(default=None, max_length=254)
    contact_phone: str | None = Field(default=None, max_length=50)
    postal_address: str | None = Field(default=None, max_length=2000)
    logo_file_id: UUID | None = None
    timezone: str | None = Field(default=None, max_length=64)
    locale: str | None = Field(default=None, max_length=35)
    mark: str | None = Field(default=None, max_length=32)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    week_start: Literal["monday", "sunday"] | None = None
    business_hours: str | None = Field(default=None, max_length=200)
    theme: WorkspaceTheme | None = None
    invitation_expiry_days: int | None = Field(default=None, ge=1, le=365)
    guest_duration_days: int | None = Field(default=None, ge=1, le=365)

    @field_validator(
        "display_name",
        "legal_name",
        "description",
        "contact_email",
        "contact_phone",
        "postal_address",
        "timezone",
        "locale",
        mode="before",
    )
    @classmethod
    def trim_text(cls, value: Any) -> Any:
        return _trim_optional(value)

    @field_validator("mark", "business_hours", mode="before")
    @classmethod
    def trim_organization_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, value: Any) -> Any:
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("currency")
    @classmethod
    def validate_currency(cls, value: str | None) -> str | None:
        if value is not None and not is_currency(value):
            raise ValueError("Currency must be a supported ISO 4217 code")
        return value

    @field_validator("display_name")
    @classmethod
    def require_display_name_when_supplied(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if not value:
            raise ValueError("Display name must not be blank")
        return value

    @field_validator("contact_email")
    @classmethod
    def validate_contact_email(cls, value: str | None) -> str | None:
        return normalize_email(value) if value is not None else None

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str | None) -> str | None:
        if value is None:
            return value
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as error:
            raise ValueError("Timezone must be an IANA timezone") from error
        return value

    @field_validator("locale")
    @classmethod
    def validate_locale(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if value.lower() == "root" or not _LOCALE_TAG_PATTERN.fullmatch(value):
            raise ValueError("Locale is not supported")
        try:
            locale = Locale.parse(value, sep="-")
        except (UnknownLocaleError, ValueError) as error:
            raise ValueError("Locale is not supported") from error
        canonical = str(locale).replace("_", "-")
        if len(canonical) > 35:
            raise ValueError("Locale is not supported")
        return canonical

    @model_validator(mode="after")
    def require_change(self) -> "WorkspaceUpdate":
        if self.model_fields_set == {"revision"}:
            raise ValueError("At least one workspace field is required")
        for field in {"timezone", "locale"} & self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field.capitalize()} must not be blank")
        for field in {
            "invitation_expiry_days",
            "guest_duration_days",
            "mark",
            "currency",
            "week_start",
            "business_hours",
            "theme",
        } & self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} must not be null")
        if "display_name" in self.model_fields_set and self.display_name is None:
            raise ValueError("Display name must not be blank")
        return self


class WorkspaceResponse(BaseModel):
    id: UUID
    display_name: str
    legal_name: str | None
    description: str | None
    contact_email: str | None
    contact_phone: str | None
    postal_address: str | None
    logo_file_id: UUID | None
    timezone: str
    locale: str
    mark: str
    currency: str
    week_start: Literal["monday", "sunday"]
    business_hours: str
    theme: WorkspaceTheme
    invitation_expiry_days: int
    guest_duration_days: int
    revision: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @computed_field
    def today(self) -> date:
        return datetime.now(ZoneInfo(self.timezone)).date()

    @computed_field
    def purge_enabled(self) -> bool:
        return get_settings().lifecycle_purge_enabled


class WorkspaceAppearanceResponse(BaseModel):
    """The only workspace value available before sign-in."""

    theme: WorkspaceTheme
    model_config = ConfigDict(extra="forbid")
