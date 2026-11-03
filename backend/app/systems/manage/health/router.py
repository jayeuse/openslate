"""GET /api/system/status for every signed-in person of the bound organization."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.health import organization, service
from app.systems.manage.health.schemas import SystemStatusResponse

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/status", response_model=SystemStatusResponse, operation_id="get_system_status")
def get_system_status(
    request: Request,
    person: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> SystemStatusResponse:
    # No pooled connection may idle in a transaction while the readiness probe runs.
    db.rollback()
    snapshot, checked_at = service.cached_readiness()
    # Admins of the bound organization only; the next transaction re-binds it for RLS.
    organization_status = organization.organization_status(db, person)
    db.rollback()
    return SystemStatusResponse(
        parts=service.system_parts(snapshot),
        version=request.app.version,
        checked_at=checked_at,
        organization=organization_status,
    )
