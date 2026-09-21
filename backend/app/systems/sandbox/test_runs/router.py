"""Capability-gated HTTP routes for Sandbox temporary-input tests."""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.common.dependencies import require_all_capabilities
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.test_runs.schemas import (
    SandboxTestRunCreateRequest,
    SandboxTestRunListResponse,
    SandboxTestRunResponse,
)
from app.systems.sandbox.test_runs.service import (
    SandboxTestError,
    clear_runs,
    create_run,
    list_runs,
    read_run,
)

router = APIRouter(prefix="/sandbox", tags=["sandbox-tests"])

_READ_CAPABILITIES = (
    Capability.DEPARTMENTS_READ,
    Capability.MODULES_READ,
    Capability.FIELDS_READ,
    Capability.RELATIONSHIPS_READ,
)
_WRITE_CAPABILITIES = (
    Capability.DEPARTMENTS_WRITE,
    Capability.MODULES_WRITE,
    Capability.FIELDS_WRITE,
    Capability.RELATIONSHIPS_WRITE,
)
ReadActor = Annotated[User, Depends(require_all_capabilities(*_READ_CAPABILITIES))]
WriteActor = Annotated[User, Depends(require_all_capabilities(*_WRITE_CAPABILITIES))]
Database = Annotated[Session, Depends(get_db)]


@router.get("/tests", response_model=SandboxTestRunListResponse, operation_id="list_sandbox_tests")
def get_runs(
    _actor: ReadActor,
    db: Database,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> SandboxTestRunListResponse:
    return _run(db, lambda: list_runs(db, limit=limit, offset=offset))


@router.post(
    "/tests",
    response_model=SandboxTestRunResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="create_sandbox_test",
)
def post_run(
    payload: SandboxTestRunCreateRequest,
    actor: WriteActor,
    db: Database,
    response: Response,
) -> SandboxTestRunResponse:
    created = _run(db, lambda: create_run(db, actor_id=actor.id, payload=payload))
    response.headers["Location"] = f"/api/sandbox/tests/{created.id}"
    return created


@router.get(
    "/tests/{run_id}",
    response_model=SandboxTestRunResponse,
    operation_id="get_sandbox_test",
)
def get_run(run_id: UUID, _actor: ReadActor, db: Database) -> SandboxTestRunResponse:
    return _run(db, lambda: read_run(db, run_id))


@router.delete("/tests", status_code=status.HTTP_204_NO_CONTENT, operation_id="clear_sandbox_tests")
def delete_runs(actor: WriteActor, db: Database) -> Response:
    _run(db, lambda: clear_runs(db, actor_id=actor.id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _run[Result](db: Session, operation: Callable[[], Result]) -> Result:
    try:
        return operation()
    except SandboxTestError as error:
        db.rollback()
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": error.message},
        ) from error
