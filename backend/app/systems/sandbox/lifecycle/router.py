"""HTTP integration for lifecycle close, reopen, and purge operations."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.common.dependencies import require_admin, require_fresh_exact_admin
from app.core.config import get_settings
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.manage.audit.context import get_audit_context
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleAlreadyClosed,
    LifecycleAlreadyOpen,
    LifecycleConfirmationNameMismatch,
    LifecycleError,
    LifecyclePlanDriftError,
    LifecyclePreflightError,
    LifecyclePurgeDisabled,
    LifecyclePurgePreconditionError,
)
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.purge_support import (
    PURGE_DISABLED_MESSAGE,
    last_successful_backup_at,
)
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleClosePreviewResponse,
    LifecycleCloseRequest,
    LifecycleMutationResponse,
    LifecycleOperation,
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
    LifecycleReopenRequest,
    LifecycleTargetType,
)
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    close_lifecycle,
    issue_challenge,
    purge_lifecycle,
    reopen_lifecycle,
    verify_challenge,
)
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.display import record_title
from app.systems.sandbox.records.models import Record

router = APIRouter(tags=["lifecycle"])
# Close, reopen and purge change the schema, so only an administrator runs them.
AdminUser = Annotated[User, Depends(require_admin)]

_TARGET_MODELS: dict[LifecycleTargetType, type[Any]] = {
    LifecycleTargetType.DEPARTMENT: Department,
    LifecycleTargetType.MODULE: Module,
    LifecycleTargetType.FIELD: Field,
    LifecycleTargetType.RECORD: Record,
}
_CONFIRMATION_FIELDS = {
    LifecycleTargetType.DEPARTMENT: "department_name",
    LifecycleTargetType.MODULE: "module_name",
    LifecycleTargetType.FIELD: "name",
    LifecycleTargetType.RECORD: "id",
}


def _error_response(error: LifecycleError) -> HTTPException:
    detail: dict[str, object] = {"code": str(error.code), "message": error.detail}
    if isinstance(error, LifecyclePreflightError):
        detail["blockers"] = [blocker.model_dump(mode="json") for blocker in error.blockers]
    return HTTPException(status_code=error.status_code, detail=detail)


def _target(db: Session, target_type: LifecycleTargetType, target_id: UUID) -> Any:
    target = db.get(_TARGET_MODELS[target_type], target_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target not found")
    return target


def _confirmation_name(
    db: Session,
    target_type: LifecycleTargetType,
    target_id: UUID,
    supplied: str,
) -> None:
    target = _target(db, target_type, target_id)
    expected = _target_name(db, target_type, target)
    if supplied != expected:
        raise _error_response(
            LifecycleConfirmationNameMismatch("Confirmation name does not match target")
        )


def _target_name(db: Session, target_type: LifecycleTargetType, target: Any) -> str:
    if target_type is LifecycleTargetType.RECORD:
        module = db.get(Module, target.module_id)
        if module is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Target not found")
        return record_title(db, target, module)
    return str(getattr(target, _CONFIRMATION_FIELDS[target_type]))


def _require_purge_enabled() -> None:
    if not get_settings().lifecycle_purge_enabled:
        raise _error_response(LifecyclePurgeDisabled(PURGE_DISABLED_MESSAGE))


def _preview(
    target_type: LifecycleTargetType,
    target_id: UUID,
    user: User,
    db: Session,
    response: Response,
) -> LifecycleClosePreviewResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        target = _target(db, target_type, target_id)
        if target.is_deleted:
            raise LifecycleAlreadyClosed("Target is already closed")
        plan = plan_lifecycle(db, target_type, target_id, LifecycleOperation.CLOSE, user.id)
        issued = issue_challenge(
            db,
            user.id,
            LifecycleOperation.CLOSE.value,
            target_type.value,
            target_id,
            plan.impact_digest,
        )
        return LifecycleClosePreviewResponse(
            impact=plan.response(),
            token=issued.token,
            expires_at=issued.expires_at,
            confirmation_name=getattr(target, _CONFIRMATION_FIELDS[target_type]),
        )
    except LifecycleError as error:
        raise _error_response(error) from error


def _close(
    target_type: LifecycleTargetType,
    target_id: UUID,
    payload: LifecycleCloseRequest,
    user: User,
    db: Session,
    response: Response,
) -> LifecycleMutationResponse:
    response.headers["Cache-Control"] = "no-store"
    _confirmation_name(db, target_type, target_id, payload.confirmation_name)
    try:
        if _target(db, target_type, target_id).is_deleted:
            raise LifecycleAlreadyClosed("Target is already closed")
        digest = challenge_impact_digest(
            db,
            payload.token,
            user.id,
            LifecycleOperation.CLOSE.value,
            target_type.value,
            target_id,
        )
        challenge = verify_challenge(
            db,
            payload.token,
            user.id,
            LifecycleOperation.CLOSE.value,
            target_type.value,
            target_id,
            digest,
            user.email,
            payload.password,
        )
        require_fresh_exact_admin(db, user.id)
        plan = plan_lifecycle(db, target_type, target_id, LifecycleOperation.CLOSE, user.id)
        if plan.impact_digest != challenge.impact_digest:
            db.rollback()
            raise LifecyclePlanDriftError(
                "Lifecycle impact changed after planning; obtain a new impact plan"
            )
        impact = close_lifecycle(db, target_type, target_id, user.id, plan=plan)
        return LifecycleMutationResponse(
            impact=impact,
            operation_id=get_audit_context(db).request_id,
        )
    except LifecycleError as error:
        raise _error_response(error) from error


def _purge_preview(
    target_type: LifecycleTargetType,
    target_id: UUID,
    user: User,
    db: Session,
    response: Response,
) -> LifecyclePurgePreviewResponse:
    response.headers["Cache-Control"] = "no-store"
    _require_purge_enabled()
    try:
        require_fresh_exact_admin(db, user.id)
        target = _target(db, target_type, target_id)
        plan = plan_lifecycle(db, target_type, target_id, LifecycleOperation.PURGE, user.id)
        name = _target_name(db, target_type, target)
        issued = issue_challenge(
            db,
            user.id,
            LifecycleOperation.PURGE.value,
            target_type.value,
            target_id,
            plan.impact_digest,
        )
        return LifecyclePurgePreviewResponse(
            impact=plan.response(),
            token=issued.token,
            expires_at=issued.expires_at,
            confirmation_name=name,
            last_successful_backup_at=last_successful_backup_at(db),
        )
    except LifecycleError as error:
        raise _error_response(error) from error


def _purge(
    target_type: LifecycleTargetType,
    target_id: UUID,
    payload: LifecyclePurgeRequest,
    user: User,
    db: Session,
    response: Response,
) -> LifecycleMutationResponse:
    response.headers["Cache-Control"] = "no-store"
    _require_purge_enabled()
    _confirmation_name(db, target_type, target_id, payload.confirmation_name)
    try:
        require_fresh_exact_admin(db, user.id)
        target = _target(db, target_type, target_id)
        if not target.is_deleted:
            raise LifecyclePurgePreconditionError("Target must be closed before it can be purged")
        digest = challenge_impact_digest(
            db,
            payload.token,
            user.id,
            LifecycleOperation.PURGE.value,
            target_type.value,
            target_id,
        )
        challenge = verify_challenge(
            db,
            payload.token,
            user.id,
            LifecycleOperation.PURGE.value,
            target_type.value,
            target_id,
            digest,
            user.email,
            payload.password,
        )
        _require_purge_enabled()
        require_fresh_exact_admin(db, user.id)
        plan = plan_lifecycle(db, target_type, target_id, LifecycleOperation.PURGE, user.id)
        if plan.impact_digest != challenge.impact_digest:
            db.rollback()
            raise LifecyclePlanDriftError(
                "Lifecycle impact changed after planning; obtain a new impact plan"
            )
        impact = purge_lifecycle(db, target_type, target_id, user.id, plan=plan)
        return LifecycleMutationResponse(
            impact=impact,
            operation_id=get_audit_context(db).request_id,
        )
    except LifecycleError as error:
        raise _error_response(error) from error


def _reopen(
    target_type: LifecycleTargetType,
    target_id: UUID,
    payload: LifecycleReopenRequest,
    user: User,
    db: Session,
) -> LifecycleMutationResponse:
    if payload.confirmed is not True:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "confirmation_required", "message": "confirmed must be true"},
        )
    try:
        target = _target(db, target_type, target_id)
        if not target.is_deleted:
            raise LifecycleAlreadyOpen("Target is already open")
        impact = reopen_lifecycle(db, target_type, target_id, user.id)
        return LifecycleMutationResponse(
            impact=impact,
            operation_id=get_audit_context(db).request_id,
        )
    except LifecycleError as error:
        raise _error_response(error) from error


@router.post(
    "/departments/{department_id}/close/preview",
    response_model=LifecycleClosePreviewResponse,
)
def preview_department_close(
    department_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleClosePreviewResponse:
    return _preview(LifecycleTargetType.DEPARTMENT, department_id, user, db, response)


@router.post(
    "/departments/{department_id}/close",
    response_model=LifecycleMutationResponse,
)
def close_department(
    department_id: UUID,
    payload: LifecycleCloseRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleMutationResponse:
    return _close(LifecycleTargetType.DEPARTMENT, department_id, payload, user, db, response)


@router.post(
    "/departments/{department_id}/reopen",
    response_model=LifecycleMutationResponse,
)
def reopen_department(
    department_id: UUID,
    payload: LifecycleReopenRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> LifecycleMutationResponse:
    return _reopen(LifecycleTargetType.DEPARTMENT, department_id, payload, user, db)


@router.post("/modules/{module_id}/close/preview", response_model=LifecycleClosePreviewResponse)
def preview_module_close(
    module_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleClosePreviewResponse:
    return _preview(LifecycleTargetType.MODULE, module_id, user, db, response)


@router.post("/modules/{module_id}/close", response_model=LifecycleMutationResponse)
def close_module(
    module_id: UUID,
    payload: LifecycleCloseRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleMutationResponse:
    return _close(LifecycleTargetType.MODULE, module_id, payload, user, db, response)


@router.post("/modules/{module_id}/reopen", response_model=LifecycleMutationResponse)
def reopen_module(
    module_id: UUID,
    payload: LifecycleReopenRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> LifecycleMutationResponse:
    return _reopen(LifecycleTargetType.MODULE, module_id, payload, user, db)


@router.post("/fields/{field_id}/close/preview", response_model=LifecycleClosePreviewResponse)
def preview_field_close(
    field_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleClosePreviewResponse:
    return _preview(LifecycleTargetType.FIELD, field_id, user, db, response)


@router.post("/fields/{field_id}/close", response_model=LifecycleMutationResponse)
def close_field(
    field_id: UUID,
    payload: LifecycleCloseRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleMutationResponse:
    return _close(LifecycleTargetType.FIELD, field_id, payload, user, db, response)


@router.post("/fields/{field_id}/reopen", response_model=LifecycleMutationResponse)
def reopen_field(
    field_id: UUID,
    payload: LifecycleReopenRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> LifecycleMutationResponse:
    return _reopen(LifecycleTargetType.FIELD, field_id, payload, user, db)


@router.post(
    "/departments/{department_id}/purge/preview",
    response_model=LifecyclePurgePreviewResponse,
)
def preview_department_purge(
    department_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecyclePurgePreviewResponse:
    return _purge_preview(LifecycleTargetType.DEPARTMENT, department_id, user, db, response)


@router.post(
    "/departments/{department_id}/purge",
    response_model=LifecycleMutationResponse,
)
def purge_department(
    department_id: UUID,
    payload: LifecyclePurgeRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleMutationResponse:
    return _purge(LifecycleTargetType.DEPARTMENT, department_id, payload, user, db, response)


@router.post("/modules/{module_id}/purge/preview", response_model=LifecyclePurgePreviewResponse)
def preview_module_purge(
    module_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecyclePurgePreviewResponse:
    return _purge_preview(LifecycleTargetType.MODULE, module_id, user, db, response)


@router.post("/modules/{module_id}/purge", response_model=LifecycleMutationResponse)
def purge_module(
    module_id: UUID,
    payload: LifecyclePurgeRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleMutationResponse:
    return _purge(LifecycleTargetType.MODULE, module_id, payload, user, db, response)


@router.post("/fields/{field_id}/purge/preview", response_model=LifecyclePurgePreviewResponse)
def preview_field_purge(
    field_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecyclePurgePreviewResponse:
    return _purge_preview(LifecycleTargetType.FIELD, field_id, user, db, response)


@router.post("/fields/{field_id}/purge", response_model=LifecycleMutationResponse)
def purge_field(
    field_id: UUID,
    payload: LifecyclePurgeRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleMutationResponse:
    return _purge(LifecycleTargetType.FIELD, field_id, payload, user, db, response)


@router.post("/records/{record_id}/purge/preview", response_model=LifecyclePurgePreviewResponse)
def preview_record_purge(
    record_id: UUID,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecyclePurgePreviewResponse:
    return _purge_preview(LifecycleTargetType.RECORD, record_id, user, db, response)


@router.post("/records/{record_id}/purge", response_model=LifecycleMutationResponse)
def purge_record(
    record_id: UUID,
    payload: LifecyclePurgeRequest,
    user: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> LifecycleMutationResponse:
    return _purge(LifecycleTargetType.RECORD, record_id, payload, user, db, response)


__all__ = ["router"]
