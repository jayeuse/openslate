"""Realtime channel tokens for the current membership."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.common.dependencies.auth import get_current_membership
from app.core.config import get_settings
from app.systems.access.users.models import Membership
from app.systems.platform.realtime.schemas import RealtimeTokenRead
from app.systems.platform.realtime.tokens import mint_realtime_token

router = APIRouter(prefix="/realtime", tags=["realtime"])


@router.post("/token", response_model=RealtimeTokenRead)
def issue_realtime_token(
    membership: Annotated[Membership, Depends(get_current_membership)],
) -> RealtimeTokenRead:
    """A 5-minute token for private channels of the ``X-Org`` organization.

    The membership dependency admits the session, the organization, MFA and the IP
    policy. Realtime checks the membership again at every channel join.
    """

    token = mint_realtime_token(
        get_settings(), user_id=membership.user_id, org_id=membership.org_id
    )
    return RealtimeTokenRead(
        access_token=token.token, expires_at=token.expires_at, topic_prefix=token.topic_prefix
    )
