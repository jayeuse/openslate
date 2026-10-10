from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.common.normalization import normalize_email


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_login_email(cls, value: object) -> object:
        return normalize_email(value)


class PasswordChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=12, max_length=128)


class EmailChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=255)
    current_password: str = Field(min_length=1, max_length=128)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_target(cls, value: object) -> object:
        normalized = normalize_email(value)
        if isinstance(normalized, str) and len(normalized.encode("utf-8")) > 255:
            raise ValueError("Email address exceeds provider limit")
        return normalized


class EmailChangeCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token_hash: str = Field(min_length=56, max_length=56, pattern=r"^[0-9a-f]{56}$")


class ActionTokenCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token_hash: str = Field(min_length=56, max_length=56, pattern=r"^[0-9a-f]{56}$")
    password: str = Field(min_length=12, max_length=128)


class RecoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_recovery_email(cls, value: object) -> object:
        return normalize_email(value)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"


class RefreshTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    refresh_token: str = Field(min_length=32, max_length=4096)


class SessionResponse(BaseModel):
    id: UUID
    created_at: str
    refreshed_at: str
    expires_at: str
    current: bool = False
