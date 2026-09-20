"""Lease-based local SMTP outbox delivery."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import timedelta
from uuid import UUID

from sqlalchemy import and_, or_, select
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config import Settings
from app.core.database.session import AuditSession, get_engine
from app.core.observability import log_event
from app.systems.access.identity.models import ActionTokenPurpose, IdentityActionToken
from app.systems.access.users.models import User, UserStatus
from app.systems.platform.notifications.models import IdentityDeliveryOutbox, OutboxState
from app.systems.platform.notifications.outbox import DeliveryPayloadError, decrypt_action_token
from app.systems.platform.notifications.smtp import send_delivery_bounded

_POLL_INTERVAL_SECONDS = 1.0
_MAX_BACKOFF_SECONDS = 300
_LEASE_SLACK_SECONDS = 5


@dataclass(frozen=True, slots=True)
class ClaimedDelivery:
    id: UUID
    lease_token: UUID
    recipient: str | None = None
    purpose: ActionTokenPurpose | None = None
    raw_token: str | None = field(default=None, repr=False)


class SmtpOutboxWorker:
    """Claim one row per bounded send and erase terminal action material."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._running = False

    @property
    def running(self) -> bool:
        return self._running

    @property
    def _lease_duration(self) -> timedelta:
        database_operation_seconds = (
            self._settings.database_pool_timeout_seconds
            + self._settings.database_statement_timeout_ms / 1000
        )
        return timedelta(
            seconds=(
                self._settings.smtp_delivery_operation_timeout_seconds
                + 2
                + 2 * database_operation_seconds
                + _LEASE_SLACK_SECONDS
            )
        )

    def start(self) -> None:
        if not self._settings.smtp_enabled or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="openslate-smtp", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            # A bounded child send plus final short database transaction owns the
            # only active iteration.  Do not return to lifespan disposal while it
            # can still touch the pool.
            thread.join()
        self._thread = None
        self._running = False

    def run_once(self) -> int:
        processed = 0
        for _ in range(self._settings.smtp_delivery_batch_size):
            if self._stop.is_set():
                break
            claim = self._claim_due_delivery()
            if claim is None:
                break
            if self._stop.is_set():
                self._release_claim(claim)
                break
            self._deliver_claimed(claim)
            processed += 1
        return processed

    def _run(self) -> None:
        self._running = True
        try:
            while not self._stop.is_set():
                try:
                    self.run_once()
                except Exception:
                    log_event(
                        "smtp_delivery_failure", level=logging.ERROR, reason_code="worker_failure"
                    )
                self._stop.wait(_POLL_INTERVAL_SECONDS)
        finally:
            self._running = False

    def _claim_due_delivery(self) -> ClaimedDelivery | None:
        terminalized = 0
        with AuditSession(bind=get_engine()) as db:
            while terminalized < self._settings.smtp_delivery_batch_size:
                if self._stop.is_set():
                    return None
                now = utc_now()
                row = db.scalar(
                    select(IdentityDeliveryOutbox)
                    .where(
                        or_(
                            and_(
                                IdentityDeliveryOutbox.state == OutboxState.PENDING,
                                IdentityDeliveryOutbox.next_attempt_at <= now,
                            ),
                            and_(
                                IdentityDeliveryOutbox.state == OutboxState.SENDING,
                                IdentityDeliveryOutbox.lease_expires_at <= now,
                            ),
                        )
                    )
                    .order_by(IdentityDeliveryOutbox.next_attempt_at, IdentityDeliveryOutbox.id)
                    .limit(1)
                    .with_for_update(skip_locked=True)
                )
                if row is None:
                    return None
                if row.attempt_count >= self._settings.smtp_delivery_max_attempts:
                    self._fail_exhausted(row)
                    db.commit()
                    terminalized += 1
                    continue
                row.state = OutboxState.SENDING
                row.attempt_count += 1
                row.lease_token = uuid7()
                action = db.get(IdentityActionToken, row.action_token_id)
                user = db.get(User, action.user_id) if action is not None else None
                if not _action_is_deliverable(action, user, row.purpose):
                    self._cancel_delivery(row)
                    db.commit()
                    terminalized += 1
                    continue
                try:
                    if row.encrypted_token is None:
                        raise DeliveryPayloadError("Delivery payload is unavailable")
                    raw_token = decrypt_action_token(row.encrypted_token, self._settings)
                except (DeliveryPayloadError, ValueError):
                    self._record_failure(row)
                    db.commit()
                    continue
                if self._stop.is_set():
                    db.rollback()
                    return None
                row.lease_expires_at = utc_now() + self._lease_duration
                claim = ClaimedDelivery(
                    row.id, row.lease_token, row.recipient, row.purpose, raw_token
                )
                db.flush()
                db.commit()
                return claim
        return None

    def _deliver_claimed(self, claim: ClaimedDelivery) -> None:
        with AuditSession(bind=get_engine()) as db:
            delivery = self._leased_delivery(db, claim)
            if delivery is None:
                return
            action = db.get(IdentityActionToken, delivery.action_token_id)
            user = db.get(User, action.user_id) if action is not None else None
            if not _action_is_deliverable(action, user, delivery.purpose):
                delivery = self._leased_delivery(db, claim, lock=True)
                if delivery is None:
                    return
                self._cancel_delivery(delivery)
                db.commit()
                return
            if claim.recipient is None or claim.purpose is None or claim.raw_token is None:
                return
            if delivery.lease_expires_at is None or delivery.lease_expires_at <= utc_now():
                return
        if self._stop.is_set():
            self._release_claim(claim)
            return
        succeeded = send_delivery_bounded(
            claim.recipient, claim.purpose, claim.raw_token, self._settings
        )
        with AuditSession(bind=get_engine()) as db:
            delivery = self._leased_delivery(db, claim, lock=True, require_unexpired=False)
            if delivery is None:
                return
            if succeeded:
                delivery.state = OutboxState.DELIVERED
                delivery.delivered_at = utc_now()
                delivery.lease_token = None
                delivery.lease_expires_at = None
                delivery.encrypted_token = None
                delivery.failure_code = None
            else:
                self._record_failure(delivery)
            db.flush()
            db.commit()

    def _leased_delivery(
        self,
        db: AuditSession,
        claim: ClaimedDelivery,
        *,
        lock: bool = False,
        require_unexpired: bool = True,
    ) -> IdentityDeliveryOutbox | None:
        clauses = [
            IdentityDeliveryOutbox.id == claim.id,
            IdentityDeliveryOutbox.state == OutboxState.SENDING,
            IdentityDeliveryOutbox.lease_token == claim.lease_token,
        ]
        if require_unexpired:
            clauses.append(IdentityDeliveryOutbox.lease_expires_at > utc_now())
        statement = select(IdentityDeliveryOutbox).where(*clauses)
        if lock:
            statement = statement.with_for_update()
        return db.scalar(statement)

    def _cancel_delivery(self, delivery: IdentityDeliveryOutbox) -> None:
        delivery.state = OutboxState.CANCELED
        delivery.failed_at = utc_now()
        delivery.lease_token = None
        delivery.lease_expires_at = None
        delivery.encrypted_token = None
        delivery.failure_code = "action_unavailable"

    def _record_failure(self, delivery: IdentityDeliveryOutbox) -> None:
        now = utc_now()
        delivery.lease_token = None
        delivery.lease_expires_at = None
        delivery.failure_code = "smtp_unavailable"
        if delivery.attempt_count >= self._settings.smtp_delivery_max_attempts:
            delivery.state = OutboxState.FAILED
            delivery.failed_at = now
            delivery.encrypted_token = None
        else:
            delivery.state = OutboxState.PENDING
            delay = min(2 ** min(delivery.attempt_count, 8), _MAX_BACKOFF_SECONDS)
            delivery.next_attempt_at = now + timedelta(seconds=delay)
        log_event(
            "smtp_delivery_failure",
            level=logging.WARNING,
            operation_id=delivery.id,
            reason_code=delivery.failure_code,
        )

    def _fail_exhausted(self, delivery: IdentityDeliveryOutbox) -> None:
        delivery.state = OutboxState.FAILED
        delivery.failed_at = utc_now()
        delivery.lease_token = None
        delivery.lease_expires_at = None
        delivery.encrypted_token = None
        delivery.failure_code = "attempts_exhausted"

    def _release_claim(self, claim: ClaimedDelivery) -> None:
        with AuditSession(bind=get_engine()) as db:
            delivery = self._leased_delivery(db, claim, lock=True)
            if delivery is None:
                return
            delivery.state = OutboxState.PENDING
            delivery.lease_token = None
            delivery.lease_expires_at = None
            db.commit()


def _action_is_deliverable(
    action: IdentityActionToken | None,
    user: User | None,
    purpose: ActionTokenPurpose | str,
) -> bool:
    if action is None or user is None or user.is_deleted or action.consumed_at is not None:
        return False
    if action.expires_at <= utc_now() or action.purpose != purpose:
        return False
    if purpose == ActionTokenPurpose.INVITATION:
        return user.status == UserStatus.PENDING.value
    return purpose == ActionTokenPurpose.RECOVERY and user.status == UserStatus.ACTIVE.value
