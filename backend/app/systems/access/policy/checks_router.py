"""Authoritative workspace-only Access checks for administrators."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.policy.authorization import check_workspace_access
from app.systems.access.policy.evaluator import PrincipalKind
from app.systems.access.policy.schemas import AccessCheckRequest, AccessCheckResponse
from app.systems.access.users.models import User, UserRole

router = APIRouter(prefix="/access/checks", tags=["access"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]

CHECK_FAILURE_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"description": "Authentication required"},
    403: {"description": "Administrator access required"},
    404: {"description": "Principal not found"},
    409: {"description": "Principal changed while checking access"},
    422: {"description": "Invalid request"},
    503: {"description": "Authorization data unavailable"},
}


@router.post(
    "",
    response_model=AccessCheckResponse,
    responses={
        200: {
            "headers": {
                "Cache-Control": {
                    "schema": {"type": "string"},
                    "description": "private, no-store",
                }
            }
        },
        **CHECK_FAILURE_RESPONSES,
    },
    operation_id="check_workspace_access",
)
def check_access(
    payload: AccessCheckRequest,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AccessCheckResponse:
    """Return the current workspace decision; service results are metadata-only."""

    require_fresh_exact_admin(db, admin.id)
    checked_at = utc_now()
    result, checked_at = check_workspace_access(
        db,
        principal_kind=PrincipalKind(payload.principal_kind),
        principal_id=payload.principal_id,
        capability=payload.permission_id,
        now=checked_at,
    )
    response.headers["Cache-Control"] = "private, no-store"
    return AccessCheckResponse(
        principal_kind=payload.principal_kind,
        principal_id=payload.principal_id,
        permission_id=payload.permission_id,
        scope_kind=payload.scope_kind,
        policy_decision=result.decision,
        reason=result.reason,
        source_rule_id=result.source_rule_id,
        policy_revision=result.policy_version,
        checked_at=checked_at,
        runtime_supported=payload.principal_kind == PrincipalKind.USER.value,
    )
