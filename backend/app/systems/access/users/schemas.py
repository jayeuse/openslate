from datetime import datetime
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    field_validator,
)

from app.common.listing import StandardListResponse
from app.common.normalization import normalize_email, normalize_username
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import Membership, User, UserRole, UserStatus


class UserResponse(BaseModel):
    id: UUID
    email: str
    username: str
    status: UserStatus
    role: UserRole
    display_name: str | None
    job_title: str | None
    sponsor_user_id: UUID | None
    expires_at: datetime | None
    invitation_sent_at: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None

    model_config = ConfigDict(from_attributes=True)

class DirectoryRowResponse(UserResponse):
    active_session_count: int = Field(ge=0)
    mfa_verified_totp: StrictBool | None
    mfa_observed_at: datetime | None
    last_sign_in_at: datetime | None
    last_active_at: datetime | None
    avatar_url: str | None = None


class UserListResponse(StandardListResponse[DirectoryRowResponse]):
    pass


class UserSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    admins_without_mfa: int = Field(ge=0)
    admins_mfa_unknown: int = Field(ge=0)
    no_recorded_sign_in: int = Field(ge=0)
    inactive_people: int = Field(ge=0)
    as_of: datetime
    inactive_days: int = Field(ge=1, le=3650)


class AccessEntryResponse(BaseModel):
    """The user's effective level on a department (``module_id`` null) or on one module.

    A module entry overrides its department entry. A module with neither is hidden.
    """

    department_id: UUID
    module_id: UUID | None
    level: AccessLevel


class AccountResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    email: str
    username: str
    status: UserStatus
    display_name: str | None
    job_title: str | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None
    phone: str | None = None
    bio: str | None = None
    avatar_file_id: UUID | None = None


class OrganizationMembershipResponse(BaseModel):
    org_id: UUID
    name: str
    slug: str
    role: UserRole


class CurrentOrganizationResponse(OrganizationMembershipResponse):
    access: list[AccessEntryResponse]
    # The organization owner changes its sensitive security; other admins do the rest.
    owner: bool = False


class PendingInvitationResponse(OrganizationMembershipResponse):
    id: UUID
    expires_at: datetime


DefaultOrganizationBlocked = Literal["mfa_required", "ip_not_allowed", "organization_required"]


class AuthenticatedSessionResponse(BaseModel):
    authenticated: Literal[True]
    user_id: UUID
    setup_required: bool
    default_organization_blocked: DefaultOrganizationBlocked | None
    # The organization a tab without its own choice opens; None when the person chooses.
    organization_id: UUID | None = None


class UnauthenticatedSessionResponse(BaseModel):
    authenticated: Literal[False]


class AuthMeResponse(AccountResponse):
    account: AccountResponse
    memberships: list[OrganizationMembershipResponse]
    pending_invitations: list[PendingInvitationResponse]
    current_organization: CurrentOrganizationResponse | None
    default_organization_blocked: DefaultOrganizationBlocked | None
    role: UserRole | None
    access: list[AccessEntryResponse]
    # The installation owner (on-prem) changes installation-wide sign-in and session policy.
    operator: bool = False
    sponsor_user_id: UUID | None = None
    expires_at: datetime | None = None
    invitation_sent_at: datetime | None = None


class OrganizationSelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    org_id: UUID


class SelfProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=200)
    job_title: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=32)
    bio: str | None = Field(default=None, max_length=280)
    avatar_file_id: UUID | None = None


class PersonCardPublicResponse(BaseModel):
    display_name: str
    job_title: str | None
    avatar_url: str | None


class PersonCardResponse(PersonCardPublicResponse):
    email: str | None
    phone: str | None
    bio: str | None


class PersonProfileGroup(BaseModel):
    id: UUID
    name: str


class PersonProfilePublicResponse(BaseModel):
    """A guest's view of a profile: the same three fields as the guest person card."""

    display_name: str
    job_title: str | None
    avatar_url: str | None


class PersonProfileResponse(PersonProfilePublicResponse):
    phone: str | None
    bio: str | None
    role: UserRole
    groups: list[PersonProfileGroup]


class AppearancePreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")

    motion: Literal["system", "reduce"]
    keyboard_shortcuts: StrictBool
    timezone: str | None = None
    date_format: Literal["organization", "dmy", "mdy", "ymd"] = "organization"
    time_format: Literal["organization", "12h", "24h"] = "organization"
    week_start: Literal["organization", "monday", "sunday"] = "organization"
    start_page: Literal[
        "automatic", "sandbox", "boards", "comms", "access", "openview", "manage", "platform"
    ] = "automatic"

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("Timezone must be an IANA name") from None
        return value


class AppearancePreferencesUpdate(AppearancePreferences):
    motion: Literal["system", "reduce"] = "system"
    keyboard_shortcuts: StrictBool = True


class UserPreferencesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: UUID
    theme: Literal["light", "dark", "system"]
    appearance: AppearancePreferences


class UserPreferencesUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    theme: Literal["light", "dark", "system"] = "system"
    appearance: AppearancePreferencesUpdate = Field(default_factory=AppearancePreferencesUpdate)


class AccessGroupResponse(BaseModel):
    """A group whose own row gives an entry its level; a guest's row can be higher."""

    group_id: UUID
    name: str
    level: AccessLevel


class UserAccessEntryResponse(AccessEntryResponse):
    groups: list[AccessGroupResponse]


class UserAccessResponse(BaseModel):
    """A person's effective access. An active administrator is unrestricted with no entries."""

    user_id: UUID
    role: UserRole
    unrestricted: bool
    entries: list[UserAccessEntryResponse]


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: str = Field(min_length=3, max_length=320)
    username: str = Field(min_length=3, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    role: UserRole = UserRole.MEMBER
    group_ids: list[UUID] = Field(default_factory=list, max_length=100)
    display_name: str | None = Field(default=None, max_length=200)
    job_title: str | None = Field(default=None, max_length=200)
    sponsor_user_id: UUID | None = None
    expires_at: datetime | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return normalize_email(value)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)


class InvitationCreate(UserCreate):
    """Administrator-selected profile and authorization for a provider email invite."""


class InvitationResponse(BaseModel):
    user: UserResponse
    delivery: Literal["email", "in_app"] = "email"


def invitation_response(user: User, membership: Membership) -> InvitationResponse:
    return InvitationResponse(
        user=UserResponse(**{key: getattr(
            membership if key == "status" or key not in User.__table__.columns else user, key
        ) for key in UserResponse.model_fields}),
        delivery="in_app" if user.status == "active" else "email",
    )


class InvitationResendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=100,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    role: Literal[UserRole.ADMIN, UserRole.MEMBER] | None = None
    status: Literal[UserStatus.ACTIVE, UserStatus.DISABLED] | None = None
    display_name: str | None = Field(default=None, max_length=200)
    job_title: str | None = Field(default=None, max_length=200)
    sponsor_user_id: UUID | None = None
    expires_at: datetime | None = None

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        return normalize_username(value)


class UserSecurityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: UUID
    verified_factor_count: int = Field(ge=0)
    target_eligible: StrictBool
    smtp_configured: StrictBool


class UserRecoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revoke_sessions: StrictBool = False


class UserRecoveryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    user_id: UUID
    email_request: Literal["accepted"] = "accepted"
    local_revocation: Literal["not_requested", "committed"]
    revoked_sessions: int | None = Field(ge=0)


class UserMfaResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserMfaResetResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation_id: UUID
    user_id: UUID
    factors_cleared: Literal[True] = True
    local_revocation: Literal["committed"] = "committed"
    revoked_sessions: int = Field(ge=0)
