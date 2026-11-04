"""System health reads for every signed-in person, and the support files for admins."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.common.dependencies.auth import (
    require_admin,
    require_fresh_exact_admin,
    require_platform_operator,
)
from app.common.listing.schemas import PaginationMetadata
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.health import diagnostics, history, installation, organization, service
from app.systems.manage.health.schemas import (
    HealthPeriod,
    HealthPeriodListResponse,
    SystemStatusResponse,
)

router = APIRouter(prefix="/system", tags=["system"])

Person = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


@router.get("/status", response_model=SystemStatusResponse, operation_id="get_system_status")
def get_system_status(request: Request, person: Person, db: Database) -> SystemStatusResponse:
    # No pooled connection may idle in a transaction while the readiness probe runs.
    db.rollback()
    snapshot, checked_at = service.cached_readiness()
    # Admins of the bound organization only; the next transaction re-binds it for RLS.
    organization_status = organization.organization_status(db, person)
    # Installation-wide and the same for everyone; the cache holds no organization data.
    current = history.cached_history(db)
    installation_status = installation.installation_status(db, person)
    db.rollback()
    return SystemStatusResponse(
        parts=service.system_parts(snapshot, current),
        version=request.app.version,
        checked_at=checked_at,
        organization=organization_status,
        installation=installation_status,
    )


@router.get(
    "/health-periods",
    response_model=HealthPeriodListResponse,
    operation_id="list_system_health_periods",
)
def list_system_health_periods(
    person: Person,
    db: Database,
    limit: Annotated[int, Query(ge=1, le=100)] = 5,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> HealthPeriodListResponse:
    """The last 30 days of periods when a part did not work or was slow; the same for all."""

    db.rollback()
    current = history.cached_history(db)
    db.rollback()
    page = current.periods[offset : offset + limit]
    total = len(current.periods)
    return HealthPeriodListResponse(
        items=[
            HealthPeriod(
                part=period.part, kind=period.kind,
                started_at=period.started_at, ended_at=period.ended_at,
            )
            for period in page
        ],
        pagination=PaginationMetadata(
            limit=limit, offset=offset, count=len(page), total=total,
            has_more=offset + len(page) < total,
        ),
        oldest_sample_at=current.oldest_sample_at,
    )


def _download(content: BaseModel, name: str) -> JSONResponse:
    return JSONResponse(
        content=content.model_dump(mode="json"),
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{name}"',
        },
    )


@router.get(
    "/diagnostics/installation",
    response_model=diagnostics.InstallationDiagnostics,
    operation_id="download_installation_diagnostics",
)
def download_installation_diagnostics(
    request: Request, person: Person, db: Database
) -> JSONResponse:
    """The installation owner's support file. No audit row or security event (J2 A)."""

    require_fresh_exact_admin(db, person.id)
    require_platform_operator(db, person.id)
    now = utc_now()
    content = diagnostics.installation_file(db, person, request.app.version, now)
    return _download(content, diagnostics.file_name("installation", now))


@router.get(
    "/diagnostics/organization",
    response_model=diagnostics.OrganizationDiagnostics,
    operation_id="download_organization_diagnostics",
)
def download_organization_diagnostics(
    request: Request, person: Annotated[User, Depends(require_admin)], db: Database
) -> JSONResponse:
    """An organization admin's support file for the bound organization only (R4)."""

    now = utc_now()
    content = diagnostics.organization_file(db, request.app.version, now)
    return _download(content, diagnostics.file_name("organization", now))
