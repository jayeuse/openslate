"""Access policy request and response contracts."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.listing import StandardListRequest
from app.systems.access.policy.evaluator import AccessDecision, EvaluationReason
from app.systems.access.users.permissions import Capability


class AccessGroupSortField(StrEnum):
    NAME = "name"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"


class AccessRuleSubjectKind(StrEnum):
    EVERYONE = "everyone"
    ROLE = "role"
    GROUP = "group"
    USER = "user"
    SERVICE = "service"


class AccessRuleScopeKind(StrEnum):
    WORKSPACE = "workspace"
    DEPARTMENT = "department"
    MODULE = "module"
    FIELD = "field"


class AccessRuleDecision(StrEnum):
    INHERIT = "inherit"
    ALLOW = "allow"
    DENY = "deny"


class AccessRuleSortField(StrEnum):
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"
    PERMISSION_ID = "permission_id"


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccessCheckRequest(_StrictModel):
    principal_kind: Literal["user", "service"]
    principal_id: UUID
    permission_id: Capability
    scope_kind: Literal["workspace"]


class AccessCheckResponse(_StrictModel):
    principal_kind: Literal["user", "service"]
    principal_id: UUID
    permission_id: Capability
    scope_kind: Literal["workspace"]
    policy_decision: AccessDecision
    reason: EvaluationReason
    source_rule_id: UUID | None
    policy_revision: int = Field(ge=1)
    checked_at: datetime
    runtime_supported: bool


class _AccessRuleCommand(_StrictModel):
    subject_kind: AccessRuleSubjectKind
    subject_id: UUID | None = None
    scope_kind: AccessRuleScopeKind
    scope_id: UUID | None = None
    permission_id: Capability
    decision: AccessRuleDecision
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    locked: bool = False

    @field_validator("starts_at", "ends_at")
    @classmethod
    def require_aware_window(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Rule windows must include a timezone")
        return value

    @model_validator(mode="after")
    def require_valid_shapes_and_window(self) -> "_AccessRuleCommand":
        if (self.subject_kind is AccessRuleSubjectKind.EVERYONE) != (self.subject_id is None):
            raise ValueError("everyone subject requires null subject_id")
        if (self.scope_kind is AccessRuleScopeKind.WORKSPACE) != (self.scope_id is None):
            raise ValueError("workspace scope requires null scope_id")
        if (
            self.starts_at is not None
            and self.ends_at is not None
            and self.starts_at >= self.ends_at
        ):
            raise ValueError("starts_at must be before ends_at")
        return self


class AccessRuleCreate(_AccessRuleCommand):
    pass


class AccessRuleUpdate(_StrictModel):
    subject_kind: AccessRuleSubjectKind = Field(default=None)  # type: ignore[assignment]
    subject_id: UUID | None = None
    scope_kind: AccessRuleScopeKind = Field(default=None)  # type: ignore[assignment]
    scope_id: UUID | None = None
    permission_id: Capability = Field(default=None)  # type: ignore[assignment]
    decision: AccessRuleDecision = Field(default=None)  # type: ignore[assignment]
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    locked: bool = Field(default=None)  # type: ignore[assignment]

    @field_validator("starts_at", "ends_at")
    @classmethod
    def require_aware_window(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("Rule windows must include a timezone")
        return value

    @model_validator(mode="after")
    def require_valid_patch(self) -> "AccessRuleUpdate":
        if not self.model_fields_set:
            raise ValueError("Rule patch must include at least one field")
        nullable_fields = {"subject_id", "scope_id", "starts_at", "ends_at"}
        if any(
            field not in nullable_fields and getattr(self, field) is None
            for field in self.model_fields_set
        ):
            raise ValueError("Required rule fields cannot be null")
        if {"subject_kind", "subject_id"} <= self.model_fields_set and (
            (self.subject_kind is AccessRuleSubjectKind.EVERYONE) != (self.subject_id is None)
        ):
            raise ValueError("everyone subject requires null subject_id")
        if {"scope_kind", "scope_id"} <= self.model_fields_set and (
            (self.scope_kind is AccessRuleScopeKind.WORKSPACE) != (self.scope_id is None)
        ):
            raise ValueError("workspace scope requires null scope_id")
        if (
            {"starts_at", "ends_at"} <= self.model_fields_set
            and self.starts_at is not None
            and self.ends_at is not None
            and self.starts_at >= self.ends_at
        ):
            raise ValueError("starts_at must be before ends_at")
        return self

    def merge_with(self, current: AccessRuleCreate) -> AccessRuleCreate:
        """Validate the complete rule after applying this partial update."""

        return AccessRuleCreate.model_validate(
            current.model_dump() | self.model_dump(exclude_unset=True)
        )


class AccessRuleResponse(_AccessRuleCommand):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    subject_id: UUID | None
    scope_id: UUID | None
    starts_at: datetime | None
    ends_at: datetime | None
    locked: bool
    policy_version: int = Field(ge=1)
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None


class AccessRuleListRequest(StandardListRequest[AccessRuleSortField]):
    subject_kind: AccessRuleSubjectKind | None = None
    subject_id: UUID | None = None
    scope_kind: AccessRuleScopeKind | None = None
    scope_id: UUID | None = None
    permission_id: Capability | None = None
    decision: AccessRuleDecision | None = None
    locked: bool | None = None


class AccessRuleBatchCreateOperation(_StrictModel):
    type: Literal["create"]
    rule: AccessRuleCreate


class AccessRuleBatchUpdateOperation(_StrictModel):
    type: Literal["update"]
    rule_id: UUID
    patch: AccessRuleUpdate


class AccessRuleBatchDeleteOperation(_StrictModel):
    type: Literal["delete"]
    rule_id: UUID


AccessRuleBatchOperation = Annotated[
    AccessRuleBatchCreateOperation
    | AccessRuleBatchUpdateOperation
    | AccessRuleBatchDeleteOperation,
    Field(discriminator="type"),
]


class AccessRuleBatchPreviewRequest(_StrictModel):
    base_revision: int = Field(ge=1)
    operations: list[AccessRuleBatchOperation] = Field(min_length=1, max_length=100)


class AccessRuleBatchApplyRequest(AccessRuleBatchPreviewRequest):
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class AccessRuleBatchBlocker(_StrictModel):
    operation_index: int = Field(ge=0)
    code: str
    message: str
    rule_id: UUID | None = None


class AccessRuleBatchCounts(_StrictModel):
    created: int = Field(ge=0)
    updated: int = Field(ge=0)
    deleted: int = Field(ge=0)
    unchanged: int = Field(ge=0)


class AccessRuleBatchPreviewResponse(_StrictModel):
    base_revision: int = Field(ge=1)
    current_revision: int = Field(ge=1)
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    can_apply: bool
    blockers: list[AccessRuleBatchBlocker]
    counts: AccessRuleBatchCounts
    affected_principals: int | None = Field(default=None, ge=0)


class AccessRuleBatchApplyResponse(_StrictModel):
    base_revision: int = Field(ge=1)
    current_revision: int = Field(ge=1)
    digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    counts: AccessRuleBatchCounts
    affected_principals: int | None = Field(default=None, ge=0)


class AccessGroupCreate(_StrictModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    member_ids: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("name", "description", mode="before")
    @classmethod
    def trim_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class AccessGroupUpdate(_StrictModel):
    name: str = Field(default=None, min_length=1, max_length=200)  # type: ignore[assignment]
    description: str = Field(default=None, max_length=2000)  # type: ignore[assignment]
    member_ids: list[UUID] = Field(default=None, max_length=100)  # type: ignore[arg-type]

    @field_validator("name", "description", mode="before")
    @classmethod
    def trim_text(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class AccessGroupResponse(BaseModel):
    id: UUID
    name: str
    description: str
    revision: int
    member_ids: list[UUID]
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None


class AccessGroupListRequest(StandardListRequest[AccessGroupSortField]):
    pass


class AccessDefaultsUpdate(_StrictModel):
    default_role_id: UUID = Field(default=None)  # type: ignore[assignment]
    group_ids: list[UUID] = Field(default=None, max_length=100)  # type: ignore[arg-type]
    department_ids: list[UUID] = Field(default=None, max_length=100)  # type: ignore[arg-type]
    invitation_expiry_days: int = Field(default=None, ge=1, le=365)  # type: ignore[assignment]
    guest_duration_days: int = Field(default=None, ge=1, le=365)  # type: ignore[assignment]
    service_duration_days: int = Field(default=None, ge=1, le=365)  # type: ignore[assignment]
    default_deny: bool = Field(default=None)  # type: ignore[assignment]
    require_guest_sponsor: bool = Field(default=None)  # type: ignore[assignment]
    require_service_owner: bool = Field(default=None)  # type: ignore[assignment]

    @field_validator("default_deny", "require_guest_sponsor", "require_service_owner")
    @classmethod
    def require_protected_flag(cls, value: bool) -> bool:
        if value is False:
            raise ValueError("Protected flags must remain enabled")
        return value


class AccessDefaultsResponse(BaseModel):
    id: UUID
    default_role_id: UUID
    group_ids: list[UUID]
    department_ids: list[UUID]
    invitation_expiry_days: int
    guest_duration_days: int
    service_duration_days: int
    default_deny: bool
    require_guest_sponsor: bool
    require_service_owner: bool
    revision: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_deleted: bool
    performed_by: UUID | None
