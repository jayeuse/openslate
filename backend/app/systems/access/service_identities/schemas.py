from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.listing import StandardListRequest

ServiceIdentityStatusValue = Literal["active", "disabled"]
EffectiveServiceIdentityStatus = Literal["active", "disabled", "expired", "deleted"]


class ServiceIdentitySortField(StrEnum):
    NAME = "name"
    EXPIRES_AT = "expires_at"
    UPDATED_AT = "updated_at"


def effective_status(
    *, status: str, is_deleted: bool, expires_at: datetime
) -> EffectiveServiceIdentityStatus:
    if is_deleted:
        return "deleted"
    if status == "disabled":
        return "disabled"
    return "expired" if expires_at <= datetime.now(UTC) else "active"


class ServiceIdentityCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    purpose: str = Field(min_length=1)
    owner_id: UUID
    role_id: UUID
    expires_at: datetime
    status: ServiceIdentityStatusValue = "active"

    @field_validator("name", "purpose", mode="before")
    @classmethod
    def trim_required_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("expires_at")
    @classmethod
    def require_future_aware_expiry(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("expires_at must include a timezone")
        if value <= datetime.now(UTC):
            raise ValueError("expires_at must be in the future")
        return value


class ServiceIdentityUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(default=None, min_length=1, max_length=200)  # type: ignore[assignment]
    purpose: str = Field(default=None, min_length=1)  # type: ignore[assignment]
    owner_id: UUID = Field(default=None)  # type: ignore[assignment]
    role_id: UUID = Field(default=None)  # type: ignore[assignment]
    expires_at: datetime = Field(default=None)  # type: ignore[assignment]
    status: ServiceIdentityStatusValue = Field(default=None)  # type: ignore[arg-type]

    @field_validator("name", "purpose", mode="before")
    @classmethod
    def trim_optional_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("expires_at")
    @classmethod
    def require_future_aware_expiry(cls, value: datetime) -> datetime:
        return ServiceIdentityCreate.require_future_aware_expiry(value)


class ServiceIdentityResponse(BaseModel):
    id: UUID
    name: str
    purpose: str
    owner_id: UUID
    role_id: UUID
    expires_at: datetime
    status: ServiceIdentityStatusValue
    effective_status: EffectiveServiceIdentityStatus
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="before")
    @classmethod
    def derive_effective_status(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return value
        derived = effective_status(
            status=value.status, is_deleted=value.is_deleted, expires_at=value.expires_at
        )
        return {
            field: getattr(value, field)
            for field in cls.model_fields
            if field != "effective_status"
        } | {"effective_status": derived}


class ServiceIdentityListRequest(StandardListRequest[ServiceIdentitySortField]):
    status: ServiceIdentityStatusValue | None = None
    owner_id: UUID | None = None
    role_id: UUID | None = None
