"""Typed contracts for Board grant management."""

from datetime import datetime
from enum import StrEnum
from typing import Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.common.listing import StandardListRequest, StandardListResponse
from app.systems.boards.models import BoardGrantEffect, BoardPermission, BoardPrincipalType


class BoardGrantSort(StrEnum):
    PRINCIPAL_TYPE = "principal_type"
    PERMISSION = "permission"
    EFFECT = "effect"
    CREATED_AT = "created_at"


class BoardGrantListRequest(StandardListRequest[BoardGrantSort]):
    pass


class BoardGrantRoleSort(StrEnum):
    ROLE = "role"


class BoardGrantRoleListRequest(StandardListRequest[BoardGrantRoleSort]):
    pass


class BoardGrantRoleChoice(BaseModel):
    id: UUID
    role: str


class BoardGrantRoleListResponse(StandardListResponse[BoardGrantRoleChoice]):
    pass


class BoardContentAudienceKind(StrEnum):
    USER = "user"
    ROLE = "role"
    DEPARTMENT = "department"


class BoardContentAudienceSort(StrEnum):
    LABEL = "label"


class BoardContentAudienceListRequest(StandardListRequest[BoardContentAudienceSort]):
    kind: BoardContentAudienceKind


class BoardContentAudienceChoice(BaseModel):
    id: UUID
    label: str


class BoardContentAudienceListResponse(StandardListResponse[BoardContentAudienceChoice]):
    pass


class BoardGrantCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    principal_type: BoardPrincipalType
    principal_user_id: UUID | None = None
    principal_role_id: UUID | None = None
    permission: BoardPermission
    effect: BoardGrantEffect

    @model_validator(mode="after")
    def require_matching_principal(self) -> Self:
        if self.principal_type is BoardPrincipalType.USER:
            valid = self.principal_user_id is not None and self.principal_role_id is None
        elif self.principal_type is BoardPrincipalType.ROLE:
            valid = self.principal_user_id is None and self.principal_role_id is not None
        else:
            valid = self.principal_user_id is None and self.principal_role_id is None
        if not valid:
            raise ValueError("The principal IDs must match the principal type")
        return self


class BoardGrantResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    principal_type: BoardPrincipalType
    principal_user_id: UUID | None
    principal_role_id: UUID | None
    principal_label: str
    principal_available: bool
    permission: BoardPermission
    effect: BoardGrantEffect
    created_at: datetime
    updated_at: datetime


class BoardGrantListResponse(StandardListResponse[BoardGrantResponse]):
    board_revision: int


class BoardGrantMutationResponse(BaseModel):
    grant: BoardGrantResponse
    board_revision: int
