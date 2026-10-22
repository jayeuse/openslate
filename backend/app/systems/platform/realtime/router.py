"""Realtime channel tokens for the current membership."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core import base_model
from app.core.config import get_settings
from app.core.database.session import get_db, get_engine
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import fresh_membership
from app.systems.comms.realtime.admission import admit
from app.systems.comms.realtime.grants import lock_projection, reconcile
from app.systems.platform.realtime.schemas import RealtimeTokenRead
from app.systems.platform.realtime.tokens import mint_realtime_token

router = APIRouter(prefix="/realtime", tags=["realtime"])


@router.post(
    "/token",
    response_model=RealtimeTokenRead,
    responses={
        429: {
            "description": "Six issuances per rolling minute per organization and actor",
            "headers": {"Retry-After": {"schema": {"type": "integer"}}},
        },
        503: {"description": "Token admission or reconciliation unavailable"},
    },
)
def issue_realtime_token(
    membership: Annotated[Membership, Depends(get_current_membership)],
    actor: Annotated[User, Depends(get_account_user)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> RealtimeTokenRead:
    """A 5-minute token for private channels of the ``X-Org`` organization.

    The membership dependency admits the session, the organization, MFA and the IP
    policy. Realtime checks the membership again at every channel join.
    """

    response.headers["Cache-Control"] = "no-store"
    org_id, user_id = membership.org_id, membership.user_id
    try:
        # Release the authentication transaction's pool slot before independent admission.
        # Authority is refreshed only after acquiring the projection guard below.
        db.commit()
        admit(get_engine(), org_id, user_id, base_model.utc_now())
        lock_projection(db)
        if fresh_membership(db, actor) is None:
            raise HTTPException(403, "Organization membership unavailable")
        token = mint_realtime_token(
            get_settings(), user_id=user_id, org_id=org_id, now=base_model.utc_now()
        )
        topics = reconcile(db, actor, token.expires_at)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            503, "Realtime token unavailable", headers={"Cache-Control": "no-store"}
        ) from exc
    return RealtimeTokenRead(
        access_token=token.token,
        expires_at=token.expires_at,
        topic_prefix=token.topic_prefix,
        conversation_topics=topics,
    )
