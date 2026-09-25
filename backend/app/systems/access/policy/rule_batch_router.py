"""Exact-administrator commands for previewing and applying Access rule batches."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Response
from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin, require_roles
from app.core.database import get_db
from app.systems.access.policy.rule_batch_service import (
    apply_rule_batch,
    preview_rule_batch,
)
from app.systems.access.policy.rules_service import policy_revision_etag
from app.systems.access.policy.schemas import (
    AccessRuleBatchApplyRequest,
    AccessRuleBatchApplyResponse,
    AccessRuleBatchPreviewRequest,
    AccessRuleBatchPreviewResponse,
)
from app.systems.access.users.models import User, UserRole

router = APIRouter(prefix="/access/rules", tags=["access"])
AdminUser = Annotated[User, Depends(require_roles(UserRole.ADMIN))]
ETAG_HEADERS: dict[str, dict[str, Any]] = {"ETag": {"schema": {"type": "string"}}}
BATCH_CONFLICT_RESPONSES: dict[int | str, dict[str, Any]] = {
    409: {
        "description": "The policy revision, digest, or planned rules conflict",
        "headers": ETAG_HEADERS,
    },
    503: {"description": "Database unavailable"},
}
APPLY_CONDITIONAL_RESPONSES: dict[int | str, dict[str, Any]] = {
    412: {
        "description": "If-Match does not match the current policy revision",
        "headers": ETAG_HEADERS,
    },
    428: {"description": "If-Match header is required", "headers": ETAG_HEADERS},
}


def _exact_admin(db: Session, admin: User) -> None:
    require_fresh_exact_admin(db, admin.id)


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


@router.post(
    "/impact-preview",
    response_model=AccessRuleBatchPreviewResponse,
    responses={200: {"headers": ETAG_HEADERS}, **BATCH_CONFLICT_RESPONSES},
    operation_id="preview_access_rule_batch",
)
def preview_rule_batch_route(
    payload: AccessRuleBatchPreviewRequest,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AccessRuleBatchPreviewResponse:
    _exact_admin(db, admin)
    plan = preview_rule_batch(db, payload)
    _private(response)
    response.headers["ETag"] = policy_revision_etag(plan.revision)
    return AccessRuleBatchPreviewResponse(
        base_revision=payload.base_revision,
        current_revision=plan.revision,
        digest=plan.digest,
        can_apply=not plan.blockers,
        blockers=list(plan.blockers),
        counts=plan.counts,
        affected_principals=plan.affected_principals,
    )


@router.post(
    "/apply",
    response_model=AccessRuleBatchApplyResponse,
    responses={
        200: {"headers": ETAG_HEADERS},
        **BATCH_CONFLICT_RESPONSES,
        **APPLY_CONDITIONAL_RESPONSES,
    },
    operation_id="apply_access_rule_batch",
)
def apply_rule_batch_route(
    payload: AccessRuleBatchApplyRequest,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
    if_match: Annotated[str | None, Header()] = None,
) -> AccessRuleBatchApplyResponse:
    _exact_admin(db, admin)
    result = apply_rule_batch(
        db,
        payload,
        digest=payload.digest,
        if_match=if_match,
        actor_id=admin.id,
    )
    _private(response)
    response.headers["ETag"] = policy_revision_etag(result.revision)
    return AccessRuleBatchApplyResponse(
        base_revision=payload.base_revision,
        current_revision=result.revision,
        digest=result.digest,
        counts=result.counts,
        affected_principals=result.affected_principals,
    )
