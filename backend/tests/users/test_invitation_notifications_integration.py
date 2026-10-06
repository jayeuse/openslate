"""Original invitation correlation and activation share one audited local commit."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from uuid6 import uuid7

from app.core.base_model import utc_now
from app.systems.access.users import acceptance
from app.systems.access.users.models import UserRole, UserStatus
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.platform.scheduling.models import InAppNotification
from tests.platform_scheduling.test_notification_routes import _client
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("original", ["eligible", "demoted", "absent", "bootstrap"])
@pytest.mark.parametrize("fail_commit", [False, True])
def test_acceptance_notifies_original_inviter_or_current_admins_once_and_atomically(
    integration_owner_db, monkeypatch, original, fail_commit
):
    db = integration_owner_db
    inviter, resender = add_user(db, role=UserRole.ADMIN), add_user(db, role=UserRole.ADMIN)
    target = add_user(db, role=UserRole.MEMBER, status=UserStatus.PENDING)
    target.provider_invitation_operation_id = None if original == "bootstrap" else uuid7()
    target.invitation_sent_at = utc_now()
    if original in {"eligible", "demoted"}:
        append_security_event(
            db,
            SecurityEventIngestRequest(
                event_type="user.invitation",
                outcome=SecurityEventOutcome.SUCCESS,
                source="users.service",
                operation_id=target.provider_invitation_operation_id,
                actor_id=inviter.id,
                subject_id=target.id,
            ),
        )
    # A later resend, even correlated to the original operation, is not the inviter.
    append_security_event(
        db,
        SecurityEventIngestRequest(
            event_type="user.invitation_resend",
            outcome=SecurityEventOutcome.SUCCESS,
            source="users.service",
            operation_id=target.provider_invitation_operation_id or uuid7(),
            actor_id=resender.id,
            subject_id=target.id,
        ),
    )
    if original == "demoted":
        inviter.role = UserRole.MEMBER.value
    db.commit()
    monkeypatch.setattr(acceptance, "begin_invitation_acceptance", lambda _id: uuid7())
    failures = []
    monkeypatch.setattr(
        acceptance, "record_invitation_acceptance_failure", lambda *args: failures.append(args)
    )
    if fail_commit:

        def reject_commit():
            db.flush()
            raise SQLAlchemyError("Controlled activation persistence failure")

        monkeypatch.setattr(db, "commit", reject_commit)
        with pytest.raises(SQLAlchemyError):
            acceptance.accept_verified_invitation(
                db, target.id, verified_email=target.email, verified_identity=target.id
            )
        db.expire_all()
        assert target.status == UserStatus.PENDING.value and target.invitation_accepted_at is None
        assert failures
        assert (
            list(
                db.scalars(
                    select(InAppNotification).where(
                        InAppNotification.kind == "invitation-accepted",
                        InAppNotification.subject_id == target.id,
                    )
                )
            )
            == []
        )
        return
    acceptance.accept_verified_invitation(
        db, target.id, verified_email=target.email, verified_identity=target.id
    )
    notices = list(
        db.scalars(
            select(InAppNotification).where(
                InAppNotification.kind == "invitation-accepted",
                InAppNotification.subject_id == target.id,
            )
        )
    )
    expected = (
        {inviter.id}
        if original == "eligible"
        else ({resender.id} if original == "demoted" else {inviter.id, resender.id})
    )
    assert {n.recipient_id for n in notices} == expected
    assert all(n.subject_type == "user" and n.work_id is None for n in notices)
    first_accepted = target.invitation_accepted_at
    acceptance.accept_verified_invitation(
        db, target.id, verified_email=target.email, verified_identity=target.id
    )
    assert target.invitation_accepted_at == first_accepted
    assert len(
        list(
            db.scalars(
                select(InAppNotification).where(
                    InAppNotification.kind == "invitation-accepted",
                    InAppNotification.subject_id == target.id,
                )
            )
        )
    ) == len(expected)
    reader = inviter if original == "eligible" else resender
    client = _client(db, reader)
    page = client.get("/api/notifications?status=unread")
    assert page.status_code == 200, page.text
    item = page.json()["items"][0]
    assert item["subject_id"] == str(target.id) and item["kind"] == "invitation-accepted"
    assert item["scheduled_for"] is None and "email" not in item
    assert client.post("/api/notifications/read-all").json() == {"updated_count": 1}
    reader.role = UserRole.MEMBER.value
    db.commit()
    assert client.get("/api/notifications").json()["items"] == []
    assert client.post(f"/api/notifications/{notices[0].id}/read").status_code == 404
