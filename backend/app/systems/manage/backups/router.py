"""Administrator-only backup metadata. Requests queue work, never stop services."""

import hashlib
from collections.abc import Callable, Coroutine
from datetime import datetime, timedelta
from secrets import token_urlsafe
from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.common.dependencies import (
    CurrentIdentity,
    get_current_identity,
    get_current_user,
    require_fresh_exact_admin,
)
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.auth.cookies import _browser_cookie_secure
from app.systems.access.users.models import User
from app.systems.manage.backups import downloads, exports, service
from app.systems.manage.backups.models import BackupExportOperation, BackupRun
from app.systems.manage.backups.schemas import (
    BackupCreate,
    BackupExportCreate,
    BackupExportResponse,
    BackupListRequest,
    BackupPolicyUpdate,
    BackupRunResponse,
    BackupSort,
    BackupStatusResponse,
    ExportDownloadAdmissionRequest,
    ExportDownloadAdmissionResponse,
    VersionResponse,
)
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
    LifecyclePasswordServiceUnavailable,
)
from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient


class ExportSecretRoute(APIRoute):
    """Keep only authored structural validation facts for the two secret POSTs."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def private_validation(request: Request) -> Response:
            try:
                return await original(request)
            except RequestValidationError as error:
                allowed = {
                    "body": {"backup_run_id", "passphrase", "password"},
                    "path": {"export_id"},
                    "header": {"idempotency-key"},
                }
                problems = []
                for problem in error.errors():
                    location = problem.get("loc", ())
                    prefix = location[0] if location and location[0] in allowed else "body"
                    safe = [prefix]
                    if len(location) > 1 and location[1] in allowed[prefix]:
                        safe.append(location[1])
                    problems.append(
                        {"loc": safe, "type": "invalid_request", "msg": "Invalid request value"}
                    )
                raise HTTPException(
                    422, detail=problems, headers={"Cache-Control": "no-store"}
                ) from None

        return private_validation


router = APIRouter(tags=["backups"])
secret_router = APIRouter(route_class=ExportSecretRoute)
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


@secret_router.post(
    "/backups/exports",
    response_model=BackupExportResponse,
    status_code=201,
    operation_id="queue_backup_export",
    responses={201: {"headers": {"Location": {"schema": {"type": "string"}}}}},
)
def queue_backup_export(
    payload: BackupExportCreate,
    actor: Actor,
    db: Database,
    response: Response,
    idempotency_key: Annotated[
        str, Header(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    ],
) -> BackupExportResponse:
    require_fresh_exact_admin(db, actor.id)
    try:
        instance = service.installation_id(db)
        row = exports.queue_export(db, instance, actor.id, payload, idempotency_key)
        db.commit()
        result = exports.export_response(row, instance)
    except service.BackupStateError as error:
        db.rollback()
        raise _error(str(error)) from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _error("export_unavailable", 503) from error
    response.headers.update(
        {"Cache-Control": "no-store", "Location": f"/api/backups/exports/{result.id}"}
    )
    return result


@router.get(
    "/backups/exports/{export_id}",
    response_model=BackupExportResponse,
    operation_id="get_backup_export",
)
def get_backup_export(
    export_id: UUID, actor: Actor, db: Database, response: Response
) -> BackupExportResponse:
    require_fresh_exact_admin(db, actor.id)
    try:
        instance = service.installation_id(db)
        row = db.scalar(
            select(BackupExportOperation).where(
                BackupExportOperation.id == export_id,
                BackupExportOperation.installation_id == instance,
            )
        )
        if row is None:
            raise _error("export_not_found", 404)
        result = exports.export_response(row, instance)
    except (SQLAlchemyError, service.BackupStateError) as error:
        db.rollback()
        raise _error("export_unavailable", 503) from error
    response.headers["Cache-Control"] = "no-store"
    return result


@secret_router.post(
    "/backups/exports/{export_id}/download-admission",
    response_model=ExportDownloadAdmissionResponse,
    operation_id="admit_backup_export_download",
)
def admit_backup_export_download(
    export_id: UUID,
    payload: ExportDownloadAdmissionRequest,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Database,
    request: Request,
    response: Response,
) -> ExportDownloadAdmissionResponse:
    if not identity.cookie_authenticated:
        raise downloads.error("export_admission_required", 403)
    actor = require_fresh_exact_admin(db, identity.user.id)
    actor_id, email = actor.id, actor.email
    db.rollback()
    try:
        verified = ProviderPasswordGrantClient(db).verify_password(
            email, payload.password.get_secret_value()
        )
        if verified != actor_id:
            raise downloads.error("export_identity_conflict", 503)
        fresh, session_expiry = downloads.locked_identity(db, request)
        row = downloads.ready_operation(db, export_id)
        assert row.expires_at is not None
        now = cast(datetime, db.scalar(select(func.clock_timestamp())))
        if session_expiry <= now:
            db.rollback()
            raise HTTPException(401, detail="Invalid authentication credentials")
        expiry = min(now + timedelta(seconds=600), row.expires_at, session_expiry)
        handle = token_urlsafe(32)
        row.admission_digest = hashlib.sha256(handle.encode()).hexdigest()
        row.admission_actor_id, row.admission_session_id = fresh.user.id, fresh.session_id
        row.admission_expires_at = expiry
        db.commit()
    except LifecycleInvalidCredentials as cause:
        db.rollback()
        raise downloads.error("export_password_invalid", 403) from cause
    except LifecyclePasswordRateLimited as cause:
        db.rollback()
        raise downloads.error("export_password_rate_limited", 429) from cause
    except (
        LifecyclePasswordServiceUnavailable,
        SQLAlchemyError,
        service.BackupStateError,
    ) as cause:
        db.rollback()
        raise downloads.error("export_unavailable", 503) from cause
    response.set_cookie(
        "openslate_export_admission",
        handle,
        httponly=True,
        secure=_browser_cookie_secure(),
        samesite="strict",
        path=f"/api/backups/exports/{export_id}/content",
        max_age=max(0, int((expiry - now).total_seconds())),
    )
    response.headers["Cache-Control"] = "no-store"
    return ExportDownloadAdmissionResponse(expires_at=expiry)


@router.get(
    "/backups/exports/{export_id}/content",
    operation_id="download_backup_export_content",
    response_class=Response,
    responses={
        200: {
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            }
        }
    },
)
async def download_backup_export_content(
    export_id: UUID,
    request: Request,
    db: Database,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
) -> Response:
    if not identity.cookie_authenticated:
        raise downloads.error("export_admission_required", 403)
    return await downloads.content_response(db, request, export_id)


router.include_router(secret_router)
