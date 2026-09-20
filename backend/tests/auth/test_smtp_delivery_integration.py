"""PostgreSQL transaction and lease proofs for local SMTP delivery."""

import os
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.core.config.settings import Settings
from app.systems.access.identity.models import ActionTokenPurpose, IdentityActionToken
from app.systems.access.identity.service import issue_action_token
from app.systems.access.users.models import Role, User, UserStatus
from app.systems.platform.notifications.models import IdentityDeliveryOutbox, OutboxState
from app.systems.platform.notifications.outbox import decrypt_action_token, queue_action_delivery
from app.systems.platform.notifications.worker import SmtpOutboxWorker
from tests.config_support import settings_values
from tests.conftest import guarded_create_engine


@pytest.mark.integration
def test_committed_action_and_outbox_are_visible_but_rollback_leaves_neither(
    integration_owner_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings()
    monkeypatch.setattr("app.systems.platform.notifications.outbox.get_settings", lambda: settings)
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    committed_user_id = None
    try:
        with Session(engine) as db:
            role = db.scalar(select(Role).where(Role.role == "member"))
            assert role is not None
            committed = _user(role, "smtp-commit")
            db.add(committed)
            db.flush()
            committed_user_id = committed.id
            raw_token = issue_action_token(db, committed.id, ActionTokenPurpose.RECOVERY)
            assert queue_action_delivery(db, committed.id, ActionTokenPurpose.RECOVERY, raw_token)
            db.commit()
            outbox = db.scalar(
                select(IdentityDeliveryOutbox).where(
                    IdentityDeliveryOutbox.recipient == committed.email
                )
            )
            action = db.scalar(
                select(IdentityActionToken).where(IdentityActionToken.user_id == committed.id)
            )
            assert outbox is not None and action is not None
            assert outbox.encrypted_token is not None
            assert decrypt_action_token(outbox.encrypted_token, settings) == raw_token

            rolled_back = _user(role, "smtp-rollback")
            db.add(rolled_back)
            db.flush()
            rolled_back_email = rolled_back.email
            rolled_back_id = rolled_back.id
            raw_rollback = issue_action_token(db, rolled_back.id, ActionTokenPurpose.RECOVERY)
            assert queue_action_delivery(
                db, rolled_back.id, ActionTokenPurpose.RECOVERY, raw_rollback
            )
            db.rollback()
            assert (
                db.scalar(
                    select(IdentityDeliveryOutbox).where(
                        IdentityDeliveryOutbox.recipient == rolled_back_email
                    )
                )
                is None
            )
            assert (
                db.scalar(
                    select(IdentityActionToken).where(IdentityActionToken.user_id == rolled_back_id)
                )
                is None
            )
        runtime_engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
        try:
            with Session(runtime_engine) as runtime_db:
                assert runtime_db.scalar(select(IdentityDeliveryOutbox.id).limit(1)) is not None
        finally:
            runtime_engine.dispose()
    finally:
        if committed_user_id is not None:
            with Session(engine) as cleanup_db:
                committed_user = cleanup_db.get(User, committed_user_id)
                if committed_user is not None:
                    cleanup_db.delete(committed_user)
                    cleanup_db.commit()
        engine.dispose()


@pytest.mark.integration
def test_stale_lease_is_reclaimed_and_only_current_lease_can_finalize(
    integration_owner_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings()
    monkeypatch.setattr("app.systems.platform.notifications.outbox.get_settings", lambda: settings)
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    user_id = None
    try:
        with Session(engine) as db:
            role = db.scalar(select(Role).where(Role.role == "member"))
            assert role is not None
            user = _user(role, "smtp-stale")
            user_email = user.email
            db.add(user)
            db.flush()
            user_id = user.id
            raw_token = issue_action_token(db, user.id, ActionTokenPurpose.RECOVERY)
            assert queue_action_delivery(db, user.id, ActionTokenPurpose.RECOVERY, raw_token)
            db.commit()
            delivery = db.scalar(
                select(IdentityDeliveryOutbox)
                .where(IdentityDeliveryOutbox.recipient == user_email)
                .execution_options(populate_existing=True)
            )
            assert delivery is not None
            delivery_id = delivery.id
            delivery.state = OutboxState.SENDING
            delivery.lease_token = uuid7()
            delivery.lease_expires_at = utc_now() - timedelta(seconds=1)
            stale_lease = delivery.lease_token
            db.commit()

        worker = SmtpOutboxWorker(settings)
        runtime_engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
        monkeypatch.setattr(
            "app.systems.platform.notifications.worker.get_engine", lambda: runtime_engine
        )
        sent: list[str] = []
        monkeypatch.setattr(
            "app.systems.platform.notifications.worker.send_delivery_bounded",
            lambda recipient, *_args: sent.append(recipient) or True,
        )
        claim = worker._claim_due_delivery()
        assert claim is not None and claim.id == delivery_id and claim.lease_token != stale_lease
        worker._deliver_claimed(type(claim)(delivery_id, stale_lease))
        assert sent == []
        with Session(engine) as db:
            delivery = db.scalar(
                select(IdentityDeliveryOutbox)
                .where(IdentityDeliveryOutbox.recipient == user_email)
                .execution_options(populate_existing=True)
            )
            assert delivery is not None
            assert delivery.state == OutboxState.SENDING
            assert delivery.lease_token == claim.lease_token
            assert delivery.lease_expires_at is not None and delivery.lease_expires_at > utc_now()
        worker._deliver_claimed(claim)
        assert sent == [user_email]
        with Session(engine) as db:
            delivery = db.get(IdentityDeliveryOutbox, delivery_id)
            assert delivery is not None
            assert delivery.state == OutboxState.DELIVERED
            assert delivery.encrypted_token is None
    finally:
        if "runtime_engine" in locals():
            runtime_engine.dispose()
        if user_id is not None:
            with Session(engine) as cleanup_db:
                stale_user = cleanup_db.get(User, user_id)
                if stale_user is not None:
                    cleanup_db.delete(stale_user)
                    cleanup_db.commit()
        engine.dispose()


@pytest.mark.integration
def test_runtime_claim_skips_a_crashed_max_attempt_delivery_and_finalizes_the_next(
    integration_owner_db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _smtp_settings(smtp_delivery_max_attempts=2)
    monkeypatch.setattr("app.systems.platform.notifications.outbox.get_settings", lambda: settings)
    owner_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    user_ids: list[UUID] = []
    runtime_engine = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    try:
        with Session(owner_engine) as db:
            role = db.scalar(select(Role).where(Role.role == "member"))
            assert role is not None
            exhausted_user = _user(role, "smtp-exhausted")
            later_user = _user(role, "smtp-later")
            db.add_all([exhausted_user, later_user])
            db.flush()
            user_ids.extend([exhausted_user.id, later_user.id])
            exhausted_token = issue_action_token(db, exhausted_user.id, ActionTokenPurpose.RECOVERY)
            later_token = issue_action_token(db, later_user.id, ActionTokenPurpose.RECOVERY)
            assert queue_action_delivery(
                db, exhausted_user.id, ActionTokenPurpose.RECOVERY, exhausted_token
            )
            assert queue_action_delivery(
                db, later_user.id, ActionTokenPurpose.RECOVERY, later_token
            )
            db.commit()
            exhausted = db.scalar(
                select(IdentityDeliveryOutbox).where(
                    IdentityDeliveryOutbox.recipient == exhausted_user.email
                )
            )
            later = db.scalar(
                select(IdentityDeliveryOutbox).where(
                    IdentityDeliveryOutbox.recipient == later_user.email
                )
            )
            assert exhausted is not None and later is not None
            exhausted.state = OutboxState.SENDING
            exhausted.attempt_count = settings.smtp_delivery_max_attempts
            exhausted.lease_token = uuid7()
            exhausted.lease_expires_at = utc_now() - timedelta(seconds=1)
            exhausted_id = exhausted.id
            later_id = later.id
            db.commit()

        worker = SmtpOutboxWorker(settings)
        monkeypatch.setattr(
            "app.systems.platform.notifications.worker.get_engine", lambda: runtime_engine
        )
        monkeypatch.setattr(
            "app.systems.platform.notifications.worker.send_delivery_bounded", lambda *_args: True
        )
        claim = worker._claim_due_delivery()
        assert claim is not None and claim.id == later_id
        worker._deliver_claimed(claim)

        with Session(owner_engine) as db:
            exhausted = db.get(IdentityDeliveryOutbox, exhausted_id)
            later = db.get(IdentityDeliveryOutbox, later_id)
            assert exhausted is not None and later is not None
            assert exhausted.state == OutboxState.FAILED
            assert exhausted.encrypted_token is None
            assert exhausted.lease_token is None
            assert exhausted.failure_code == "attempts_exhausted"
            assert later.state == OutboxState.DELIVERED
            assert later.encrypted_token is None
    finally:
        runtime_engine.dispose()
        with Session(owner_engine) as cleanup_db:
            for user_id in user_ids:
                user = cleanup_db.get(User, user_id)
                if user is not None:
                    cleanup_db.delete(user)
            cleanup_db.commit()
        owner_engine.dispose()


def _smtp_settings(**overrides: object) -> Settings:
    return Settings.model_validate(
        settings_values(
            smtp_enabled=True,
            smtp_host="smtp.example.test",
            smtp_port=587,
            smtp_from="no-reply@example.test",
            smtp_transport="starttls",
            smtp_delivery_encryption_key="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            **overrides,
        )
    )


def _user(role: Role, prefix: str) -> User:
    suffix = uuid7().hex[:12]
    return User(
        email=f"{prefix}-{suffix}@example.test",
        username=f"{prefix}-{suffix}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
    )
