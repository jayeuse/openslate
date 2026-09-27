"""Review and publish the Sandbox draft to operational structure."""

from __future__ import annotations

from collections.abc import Callable
from hashlib import sha256
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.common.dependencies import (
    CurrentIdentity,
    authorize_workspace_capabilities,
    get_current_identity,
    require_fresh_capabilities,
)
from app.core.database import get_db
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.designs.service import SandboxDesignError, read_document
from app.systems.sandbox.lifecycle.exceptions import (
    LifecycleInvalidCredentials,
    LifecyclePasswordRateLimited,
    LifecyclePasswordServiceUnavailable,
)
from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient
from app.systems.sandbox.publications.executor import (
    PublicationError,
    apply_publication,
    replay_or_conflict,
    request_fingerprint,
)
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.schemas import (
    PublicationPreviewRequest,
    PublicationPreviewResponse,
    PublicationRequest,
    PublicationResponse,
)
from app.systems.sandbox.publications.tokens import decode_preview_token, issue_preview_token

router = APIRouter(prefix="/sandbox", tags=["sandbox-publications"])
Database = Annotated[Session, Depends(get_db)]
PublicationActor = Annotated[CurrentIdentity, Depends(get_current_identity)]
_CAPABILITIES = (
    Capability.DEPARTMENTS_WRITE,
    Capability.MODULES_WRITE,
    Capability.FIELDS_WRITE,
    Capability.RELATIONSHIPS_WRITE,
    Capability.RECORDS_WRITE,
)


def _actor(identity: CurrentIdentity) -> CurrentIdentity:
    if identity.setup_only:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return identity


@router.post(
    "/publication-previews",
    response_model=PublicationPreviewResponse,
    operation_id="preview_sandbox_publication",
)
def post_preview(
    payload: PublicationPreviewRequest, identity: PublicationActor, db: Database
) -> PublicationPreviewResponse:
    actor = _actor(identity)
    authorize_workspace_capabilities(
        db,
        actor_id=actor.user.id,
        expected_role_id=actor.user.role_id,
        capabilities=_CAPABILITIES,
    )
    response = _run(db, lambda: read_document(db))
    if response.revision != payload.expected_revision:
        raise _error("stale_revision", "Sandbox document changed; reload before publishing")
    plan = publication_plan(db, response.document)
    token, claims = issue_preview_token(
        actor_id=actor.user.id,
        session_id=actor.session_id,
        document_revision=response.revision,
        document_hash=response.content_hash,
        impact_digest=plan.impact_digest,
        live_state_digest=plan.live_state_digest,
    )
    return PublicationPreviewResponse(
        preview_token=token,
        impact_digest=plan.impact_digest,
        document_revision=response.revision,
        document_hash=response.content_hash,
        expires_at=claims.expires_at,
        changes=list(plan.changes),
        counts=plan.counts,
        warnings=list(plan.warnings),
        blockers=list(plan.blockers),
    )


@router.post(
    "/publications",
    response_model=PublicationResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="create_sandbox_publication",
)
def post_publication(
    payload: PublicationRequest,
    identity: PublicationActor,
    db: Database,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> Response:
    actor = _actor(identity)
    if idempotency_key is None or not 1 <= len(idempotency_key) <= 128:
        raise _error("publication_unavailable", "A bounded Idempotency-Key is required", 400)

    def reauthorize() -> None:
        require_fresh_capabilities(
            db,
            actor_id=actor.user.id,
            session_id=actor.session_id,
            expected_role_id=actor.user.role_id,
            capabilities=_CAPABILITIES,
        )

    reauthorize()
    try:
        verified_id = ProviderPasswordGrantClient(db).verify_password(
            actor.user.email, payload.password
        )
    except LifecyclePasswordRateLimited as error:
        db.rollback()
        raise _error(
            "password_rate_limited", "Password verification is rate limited", 429
        ) from error
    except LifecycleInvalidCredentials as error:
        raise _error("invalid_password", "Password verification failed", 403) from error
    except LifecyclePasswordServiceUnavailable as error:
        db.rollback()
        raise _error("publication_unavailable", "Password verification unavailable", 503) from error
    if verified_id != actor.user.id:
        db.rollback()
        raise _error("invalid_password", "Password verification failed", 403)
    # Password verification commits rate-limit state and releases the first locks.
    reauthorize()
    claims = decode_preview_token(payload.preview_token)
    if claims is None:
        raise _error("preview_expired", "Publication review expired; review again")
    if (
        claims.actor_id != actor.user.id
        or claims.session_id != actor.session_id
        or claims.document_revision != payload.expected_revision
        or claims.impact_digest != payload.impact_digest
    ):
        raise _error("preview_mismatch", "Publication review does not match this request")
    preview_token_digest = sha256(payload.preview_token.encode()).hexdigest()
    fingerprint = request_fingerprint(
        expected_revision=payload.expected_revision,
        document_hash=claims.document_hash,
        impact_digest=payload.impact_digest,
        preview_token_digest=preview_token_digest,
        note=payload.note,
    )
    replay = _run(
        db,
        lambda: replay_or_conflict(
            db,
            actor_id=actor.user.id,
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            preview_token_digest=preview_token_digest,
        ),
    )
    if replay is not None:
        return _created_response(replay)
    result = _run(
        db,
        lambda: apply_publication(
            db,
            actor_id=actor.user.id,
            expected_revision=payload.expected_revision,
            impact_digest=payload.impact_digest,
            expected_live_state_digest=claims.live_state_digest,
            preview_token_digest=preview_token_digest,
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            note=payload.note,
            reauthorize_after_rollback=reauthorize,
        ),
    )
    return _created_response(result)


def _created_response(result: PublicationResponse) -> Response:
    return Response(
        content=result.model_dump_json(by_alias=True),
        status_code=status.HTTP_201_CREATED,
        media_type="application/json",
        headers={
            "Location": f"/api/sandbox/versions/{result.version.id}",
            "Cache-Control": "no-store",
        },
    )


def _error(code: str, message: str, status_code: int = 409) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _run[Result](db: Session, operation: Callable[[], Result]) -> Result:
    try:
        return operation()
    except SandboxDesignError as error:
        db.rollback()
        raise _error(error.code, error.message, error.status_code) from error
    except PublicationError as error:
        db.rollback()
        raise _error(error.code, error.message, error.status_code) from error
    except IntegrityError as error:
        db.rollback()
        raise _error(
            "publication_unavailable", "Unable to publish the Sandbox structure", 503
        ) from error
