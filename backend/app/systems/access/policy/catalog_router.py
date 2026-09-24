"""Administrator-only catalog of capabilities available to access policy tooling."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict

from app.common.dependencies import require_roles
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.permissions import Capability

router = APIRouter(prefix="/access", tags=["access"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]


class CapabilityItem(BaseModel):
    """A stable, plain-language description of one enforceable capability."""

    model_config = ConfigDict(frozen=True)

    id: Capability
    label: str
    description: str
    group: str


class CapabilityCatalogResponse(BaseModel):
    """The complete non-paginated catalog of access capabilities."""

    model_config = ConfigDict(frozen=True)

    items: tuple[CapabilityItem, ...]


_CAPABILITY_DETAILS: dict[Capability, tuple[str, str, str]] = {
    Capability.DEPARTMENTS_READ: (
        "View departments",
        "View department information.",
        "Departments",
    ),
    Capability.DEPARTMENTS_WRITE: (
        "Manage departments",
        "Create and change departments.",
        "Departments",
    ),
    Capability.MODULES_READ: (
        "View modules",
        "View module information.",
        "Modules",
    ),
    Capability.MODULES_WRITE: (
        "Manage modules",
        "Create and change modules.",
        "Modules",
    ),
    Capability.FIELDS_READ: (
        "View fields",
        "View field information.",
        "Fields",
    ),
    Capability.FIELDS_WRITE: (
        "Manage fields",
        "Create and change fields.",
        "Fields",
    ),
    Capability.RECORDS_READ: (
        "View records",
        "View saved records.",
        "Records",
    ),
    Capability.RECORDS_WRITE: (
        "Manage records",
        "Create and change records.",
        "Records",
    ),
    Capability.RELATIONSHIPS_READ: (
        "View relationships",
        "View relationships between records.",
        "Relationships",
    ),
    Capability.RELATIONSHIPS_WRITE: (
        "Manage relationships",
        "Create and change relationships between records.",
        "Relationships",
    ),
}


@router.get(
    "/capabilities",
    response_model=CapabilityCatalogResponse,
    operation_id="list_access_capabilities",
)
def list_capabilities(_: AdminUser, response: Response) -> CapabilityCatalogResponse:
    """Return every current capability in the stable enum declaration order."""

    response.headers["Cache-Control"] = "private, no-store"
    return CapabilityCatalogResponse(
        items=tuple(
            CapabilityItem(
                id=capability,
                label=_CAPABILITY_DETAILS[capability][0],
                description=_CAPABILITY_DETAILS[capability][1],
                group=_CAPABILITY_DETAILS[capability][2],
            )
            for capability in Capability
        )
    )
