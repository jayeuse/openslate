"""One HTTP send coordinator for ordinary messages and replies over the S15 transaction."""

from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError

from app.core.database.session import AuditSession
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error, require_conversation_access
from app.systems.comms.messages.admission import authorize_send
from app.systems.comms.messages.reads import get_message, project_messages
from app.systems.comms.messages.schemas import LiveMessage, ReplyRequest, SendRequest, Tombstone
from app.systems.comms.messages.service import (
    InvalidSend,
    MessageReferenceUnavailable,
    SendConflict,
    SendMessageCommand,
    SendRateLimited,
    send_message,
)


def send(
    db: AuditSession,
    user: User,
    conversation_id: UUID,
    request: SendRequest,
    *,
    parent_id: UUID | None = None,
) -> tuple[LiveMessage | Tombstone, bool]:
    require_conversation_access(db, user, conversation_id, "read")
    if parent_id is not None:
        root = get_message(db, conversation_id, message_id=parent_id)
        if root.parent_id is not None:
            raise error("comms_not_found", "Thread root not found")

    def authorize(replayed: bool) -> None:
        if replayed:
            require_conversation_access(db, user, conversation_id, "read")
            if parent_id is not None:
                root = get_message(db, conversation_id, message_id=parent_id)
                if root.parent_id is not None:
                    raise error("comms_not_found", "Thread root not found")
        else:
            authorize_send(db, user, conversation_id, request, parent_id=parent_id)

    try:
        values = request.model_dump()
        if isinstance(request, ReplyRequest):
            values["parent_id"] = parent_id
        result = send_message(
            db,
            org_id=bound_organization(db),
            author_id=user.id,
            conversation_id=conversation_id,
            command=SendMessageCommand(**values),
            authorize=authorize,
        )
        message = project_messages(db, user.id, [result.message])[0]
        if not result.replayed and not isinstance(message, LiveMessage):
            raise error("comms_unavailable", "Message changed before acknowledgement", 503)
        return message, result.replayed
    except SendRateLimited as exc:
        refused = error("comms_rate_limited", "Wait before sending again", 429)
        refused.headers = {"Retry-After": str(exc.retry_after)}
        raise refused from exc
    except SendConflict as exc:
        raise error(
            "comms_idempotency_mismatch", "Client key identifies a different send", 409
        ) from exc
    except MessageReferenceUnavailable as exc:
        raise error("comms_not_found", "Message not found") from exc
    except InvalidSend as exc:
        raise error("comms_invalid_input", "Message cannot be sent", 422) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "Message unavailable", 503) from exc
