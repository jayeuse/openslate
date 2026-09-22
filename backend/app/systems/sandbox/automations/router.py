"""Read-only recent-run API for published Sandbox automations."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.common.dependencies import require_all_capabilities
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.automations.schemas import AutomationRunListResponse
from app.systems.sandbox.automations.service import list_recent_runs

router = APIRouter(prefix="/sandbox", tags=["sandbox-automations"])
ReadActor = Annotated[
    User,
    Depends(
        require_all_capabilities(
            Capability.MODULES_READ,
            Capability.FIELDS_READ,
            Capability.RELATIONSHIPS_READ,
            Capability.DEPARTMENTS_READ,
        )
    ),
]
Database = Annotated[Session, Depends(get_db)]


@router.get(
    "/automation-runs",
    response_model=AutomationRunListResponse,
    operation_id="list_sandbox_automation_runs",
)
def get_automation_runs(
    _actor: ReadActor,
    db: Database,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AutomationRunListResponse:
    return list_recent_runs(db, limit=limit, offset=offset)
