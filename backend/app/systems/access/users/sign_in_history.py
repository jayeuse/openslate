"""S4: the caller's own sign-in history from sessions and attributed security events.

Only the caller's rows: sessions they own and events whose subject they are. Idle timeouts
have no stored end time, so they are not listed.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import Row, Select, case, func, literal, select, union_all
from sqlalchemy.orm import Bundle, Session

from app.common.listing import ListQuerySpec, execute_standard_list
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.sessions_schemas import (
    SignInEventListRequest,
    SignInEventListResponse,
    SignInEventResponse,
    SignInEventSortField,
)
from app.systems.manage.audit.models import SecurityEvent

_EVENT_KINDS = {"identity.sign_in_failure": "sign_in_failed", "identity.lockout": "locked_out"}


def _sessions(user_id: UUID, kind: str, at: Any) -> Select[Any]:
    return select(
        literal(kind).label("kind"),
        IdentitySession.id.label("id"),
        at.label("occurred_at"),
        IdentitySession.user_agent.label("user_agent"),
        func.host(IdentitySession.ip_address).label("ip_address"),
    ).where(IdentitySession.user_id == user_id, at.is_not(None))


def _events(user_id: UUID) -> Select[Any]:
    return select(
        case(
            *((SecurityEvent.event_type == name, kind) for name, kind in _EVENT_KINDS.items())
        ).label("kind"),
        SecurityEvent.id.label("id"),
        SecurityEvent.occurred_at.label("occurred_at"),
        SecurityEvent.event_metadata["user_agent"].astext.label("user_agent"),
        SecurityEvent.event_metadata["ip_address"].astext.label("ip_address"),
    ).where(
        SecurityEvent.subject_id == user_id, SecurityEvent.event_type.in_(tuple(_EVENT_KINDS))
    )


def list_sign_in_events(
    db: Session, user_id: UUID, params: SignInEventListRequest
) -> SignInEventListResponse:
    source = union_all(
        _sessions(user_id, "signed_in", IdentitySession.created_at),
        _sessions(user_id, "session_ended", IdentitySession.revoked_at),
        _events(user_id),
    ).subquery("sign_in_events")
    bundle: Bundle[Row[Any]] = Bundle("event", *source.c, single_entity=True)
    spec = ListQuerySpec(
        sort_fields={SignInEventSortField.OCCURRED_AT: source.c.occurred_at},
        default_sort=SignInEventSortField.OCCURRED_AT,
        tie_breaker=func.row(source.c.id, source.c.kind),
    )
    listed = execute_standard_list(db, select(bundle), params, spec)
    return SignInEventListResponse(
        items=[SignInEventResponse.model_validate(row._asdict()) for row in listed.items],
        pagination=listed.pagination,
    )
