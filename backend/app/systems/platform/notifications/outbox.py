"""Transactional queueing and protected payload handling for local SMTP."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.systems.access.identity.models import ActionTokenPurpose, IdentityActionToken
from app.systems.access.users.models import User
from app.systems.platform.notifications.models import IdentityDeliveryOutbox


class DeliveryPayloadError(RuntimeError):
    """An encrypted action token cannot be safely delivered."""


@dataclass(frozen=True, slots=True)
class DeliveryStatus:
    enabled: bool
    state_counts: dict[str, int]


def smtp_delivery_enabled() -> bool:
    """Return whether an administrator may request email delivery."""

    return get_settings().smtp_enabled


def encrypt_action_token(raw_token: str, settings: Settings) -> str:
    key = _encryption_key(settings)
    return Fernet(key).encrypt(raw_token.encode("utf-8")).decode("ascii")


def decrypt_action_token(encrypted_token: str, settings: Settings) -> str:
    try:
        return (
            Fernet(_encryption_key(settings))
            .decrypt(encrypted_token.encode("ascii"))
            .decode("utf-8")
        )
    except (InvalidToken, UnicodeDecodeError) as error:
        raise DeliveryPayloadError("Delivery payload is unavailable") from error


def queue_action_delivery(
    db: Session,
    user_id: UUID,
    purpose: ActionTokenPurpose,
    raw_token: str,
) -> bool:
    """Enqueue an encrypted action link with its action token transaction.

    Disabled SMTP intentionally leaves no token payload or queue row.  Callers
    can retain temporary-password flows without an email service.
    """

    settings = get_settings()
    if not settings.smtp_enabled:
        return False
    if not raw_token:
        raise DeliveryPayloadError("Delivery payload is unavailable")
    user = db.get(User, user_id)
    action = db.scalar(
        select(IdentityActionToken).where(
            IdentityActionToken.user_id == user_id,
            IdentityActionToken.purpose == purpose,
            IdentityActionToken.token_digest == sha256(raw_token.encode("utf-8")).hexdigest(),
        )
    )
    if user is None or action is None:
        raise DeliveryPayloadError("Delivery payload is unavailable")
    db.add(
        IdentityDeliveryOutbox(
            action_token_id=action.id,
            recipient=user.email,
            purpose=purpose,
            encrypted_token=encrypt_action_token(raw_token, settings),
        )
    )
    return True


def delivery_status(db: Session, settings: Settings | None = None) -> DeliveryStatus:
    """Return non-sensitive queue counts for health or administrative callers."""

    from sqlalchemy import func

    active_settings = settings or get_settings()
    rows = db.execute(
        select(IdentityDeliveryOutbox.state, func.count()).group_by(IdentityDeliveryOutbox.state)
    ).all()
    counts = {str(state): count for state, count in rows}
    return DeliveryStatus(active_settings.smtp_enabled, counts)


def _encryption_key(settings: Settings) -> bytes:
    key = settings.smtp_delivery_encryption_key
    if not settings.smtp_enabled or key is None:
        raise DeliveryPayloadError("SMTP delivery is not enabled")
    return key.get_secret_value().encode("ascii")
