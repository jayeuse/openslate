"""Administrator-only workspace security read and partial-update contracts."""

from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    IPvAnyAddress,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)

from app.systems.manage.workspace.security_policy import MAX_IP_NETWORKS, canonical_network

SessionTimeout = Literal[15, 30, 60, 480]
MfaPolicy = Literal["optional", "admins", "everyone"]
NetworkInput = Annotated[str, Field(max_length=64)]


class WorkspaceSecurityUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: StrictInt = Field(ge=1)
    session_timeout_minutes: SessionTimeout | None = None
    password_min_length: StrictInt | None = Field(default=None, ge=12, le=128)
    password_require_mixed_case: StrictBool | None = None
    password_require_number: StrictBool | None = None
    mfa_policy: MfaPolicy | None = None
    ip_allow_list: list[NetworkInput] | None = Field(default=None, max_length=MAX_IP_NETWORKS)

    @field_validator("session_timeout_minutes", mode="before")
    @classmethod
    def require_integer_timeout(cls, value: object) -> object:
        if value is not None and type(value) is not int:
            raise ValueError("Session timeout must be a supported number of minutes")
        return value

    @field_validator("ip_allow_list")
    @classmethod
    def canonicalize_networks(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return values
        try:
            return [canonical_network(value) for value in values]
        except ValueError as error:
            raise ValueError("Allow list entries must be valid IPv4 or IPv6 CIDRs") from error

    @model_validator(mode="after")
    def require_explicit_changes(self) -> "WorkspaceSecurityUpdate":
        changed = self.model_fields_set - {"revision"}
        if not changed:
            raise ValueError("At least one security field is required")
        if any(getattr(self, field) is None for field in changed):
            raise ValueError("Security fields must not be null")
        return self


class WorkspaceSecurityResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    revision: int
    session_timeout_minutes: SessionTimeout
    password_min_length: int
    password_require_mixed_case: bool
    password_require_number: bool
    mfa_policy: MfaPolicy
    ip_allow_list: list[str]


class WorkspaceCallerIpResponse(BaseModel):
    address: IPvAnyAddress
