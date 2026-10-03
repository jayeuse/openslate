"""Administrator-only backup metadata. Requests queue work, never stop services."""

from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import get_current_user, require_fresh_exact_admin
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.backups import service
from app.systems.manage.backups.models import BackupRun
from app.systems.manage.backups.schemas import (
    BackupCreate,
    BackupListRequest,
    BackupPolicyUpdate,
    BackupRunResponse,
    BackupSort,
    BackupStatusResponse,
    VersionResponse,
)

router = APIRouter(tags=["backups"])
Actor = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]
_LIST_SPEC = ListQuerySpec(
    sort_fields={
        BackupSort.REQUESTED_AT: cast(ColumnElement[Any], BackupRun.requested_at),
        BackupSort.NAME: cast(ColumnElement[Any], BackupRun.name),
        BackupSort.STATE: cast(ColumnElement[Any], BackupRun.state),
        BackupSort.PROVENANCE: cast(ColumnElement[Any], BackupRun.provenance),
        BackupSort.FINISHED_AT: cast(ColumnElement[Any], BackupRun.finished_at),
    },
    default_sort=BackupSort.REQUESTED_AT,
    tie_breaker=cast(ColumnElement[Any], BackupRun.id),
    search_fields=(
        cast(ColumnElement[str], BackupRun.name),
        cast(ColumnElement[str], BackupRun.state),
        cast(ColumnElement[str], BackupRun.provenance),
        cast(ColumnElement[str], BackupRun.snapshot_id),
    ),
)


def _error(code: str, status: int = 409) -> HTTPException:
    messages = {
        "stale_revision": "Backup policy has changed",
        "backup_idempotency_conflict": "This request key was used for a different backup",
        "backup_identity_conflict": "Backup installation identity is unavailable",
        "backup_unavailable": "Backup metadata is unavailable",
    }
    return HTTPException(
        status,
        detail={"code": code, "message": messages.get(code, "Backup state conflict")},
        headers={"Cache-Control": "no-store"},
    )


@router.get(
    "/backups/status", response_model=BackupStatusResponse, operation_id="get_backup_status"
)
def get_status(actor: Actor, db: Database, response: Response) -> BackupStatusResponse:
    require_fresh_exact_admin(db, actor.id)
    response.headers["Cache-Control"] = "no-store"
    try:
        return service.status_response(db, service.installation_id(db))
    except (SQLAlchemyError, service.BackupStateError) as error:
        db.rollback()
        raise _error("backup_unavailable", 503) from error


@router.patch(
    "/backups/status", response_model=BackupStatusResponse, operation_id="update_backup_policy"
)
def update_policy(
    payload: BackupPolicyUpdate, actor: Actor, db: Database, response: Response
) -> BackupStatusResponse:
    require_fresh_exact_admin(db, actor.id)
    try:
        instance = service.installation_id(db)
        policy = service.lock_policy(db, instance)
        if policy.revision != payload.revision:
            raise service.BackupStateError("stale_revision")
        # Read before any assignment: a query would autoflush a disabled schedule
        # that still has its old due time and break ck_backup_policies_disabled_due.
        timezone = service.workspace(db).timezone
        for field in payload.model_fields_set - {"revision"}:
            setattr(policy, field, getattr(payload, field))
        policy.timezone = timezone
        policy.next_due_at = service.future_due(policy.schedule, policy.timezone, utc_now())
        policy.revision += 1
        policy.performed_by = actor.id
        db.commit()
        result = service.status_response(db, instance)
    except service.BackupStateError as error:
        db.rollback()
        raise _error(str(error)) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _error("backup_unavailable", 503) from error
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post(
    "/backups",
    response_model=BackupRunResponse,
    status_code=201,
    operation_id="queue_backup",
    responses={201: {"headers": {"Location": {"schema": {"type": "string"}}}}},
)
def queue_backup(
    payload: BackupCreate,
    actor: Actor,
    db: Database,
    response: Response,
    idempotency_key: Annotated[
        str,
        Header(
            min_length=1,
            max_length=128,
            pattern=r"^[A-Za-z0-9._:-]+$",
            description="Required durable request identity",
        ),
    ],
) -> BackupRunResponse:
    require_fresh_exact_admin(db, actor.id)
    try:
        instance = service.installation_id(db)
        run = service.queue_manual(db, instance, actor.id, payload.name, idempotency_key)
        db.commit()
        result = service.run_response(run, instance)
    except service.BackupStateError as error:
        db.rollback()
        raise _error(str(error)) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _error("backup_unavailable", 503) from error
    response.headers.update(
        {"Cache-Control": "no-store", "Location": f"/api/backups?run_id={result.id}"}
    )
    return result


@router.get(
    "/backups", response_model=StandardListResponse[BackupRunResponse], operation_id="list_backups"
)
def list_backups(
    params: Annotated[BackupListRequest, Query()], actor: Actor, db: Database, response: Response
) -> StandardListResponse[BackupRunResponse]:
    require_fresh_exact_admin(db, actor.id)
    try:
        instance = service.installation_id(db)
        statement = select(BackupRun)
        for field in ("state", "provenance"):
            value = getattr(params, field)
            if value is not None:
                statement = statement.where(getattr(BackupRun, field) == value)
        if params.installation is not None:
            statement = statement.where(
                BackupRun.installation_id == instance
                if params.installation == "current"
                else BackupRun.installation_id != instance
            )
        if params.run_id is not None:
            statement = statement.where(BackupRun.id == params.run_id)
        listed = execute_standard_list(db, statement, params, _LIST_SPEC)
    except (SQLAlchemyError, service.BackupStateError) as error:
        db.rollback()
        raise _error("backup_unavailable", 503) from error
    response.headers["Cache-Control"] = "no-store"
    return StandardListResponse(
        items=[service.run_response(row, instance) for row in listed.items],
        pagination=listed.pagination,
    )


@router.get("/version", response_model=VersionResponse, operation_id="get_running_version")
def get_version(
    request: Request, actor: Actor, db: Database, response: Response
) -> VersionResponse:
    require_fresh_exact_admin(db, actor.id)
    try:
        result = service.version_status(db, request.app.version)
    except SQLAlchemyError as error:
        db.rollback()
        raise _error("backup_unavailable", 503) from error
    response.headers["Cache-Control"] = "no-store"
    return result
