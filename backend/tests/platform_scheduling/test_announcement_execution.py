"""Scheduled announcements publish once under current Board and content policy."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.users.models import User, UserStatus
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_service import write_manager
from app.systems.boards.models import Board, BoardGrant
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.openview.reports.models import Report
from app.systems.platform.scheduling import announcement_execution
from app.systems.platform.scheduling.announcement_execution import (
    claim_due_announcement_work,
    fail_announcement_work,
    finalize_announcement_claim,
)
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkState
from app.systems.platform.scheduling.service import WorkClaim, claim_due_work
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module

pytestmark = pytest.mark.integration
NOW = datetime(2026, 9, 24, 12, tzinfo=UTC)


def _other_user(db, role: str) -> User:
    other = User(
        email=f"announcement-other-{uuid7().hex}@example.test",
        username=f"announcement_other_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(other)
    db.flush()
    return other


def _subject(db):
    role = "member"
    actor = User(
        email=f"announcement-work-{uuid7().hex}@example.test",
        username=f"announcement_work_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(actor)
    db.flush()
    board = Board(owner_id=actor.id, name="Scheduled publication")
    db.add(board)
    db.flush()
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=actor.id,
        title="Scheduled notice",
        body="Publish this content once",
        audience_kind="everyone",
        status="scheduled",
        publish_at=NOW,
        revision=2,
    )
    db.add(item)
    db.flush()
    work = ScheduledWork(
        kind="announcement-publish",
        announcement_id=item.id,
        source_revision=item.revision,
        scheduling_actor_id=actor.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
    )
    db.add(work)
    db.flush()
    return actor, role, board, item, work


def test_due_announcement_claim_publishes_one_immutable_result(integration_owner_db):
    db = integration_owner_db
    actor, _role, board, item, work = _subject(db)
    department = Department(department_name=f"Announcement work {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name=f"Announcement work {uuid7().hex}",
    )
    db.add(module)
    db.flush()
    report = Report(module_id=module.id, name="Parallel Report", recipe={})
    db.add(report)
    db.flush()
    report_work = ScheduledWork(
        kind="report-run",
        report_id=report.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
    )
    db.add(report_work)
    db.flush()

    claims = claim_due_announcement_work(db, now=NOW)
    assert len(claims) == 1 and claims[0].id == work.id
    assert [claim.id for claim in claim_due_work(db, now=NOW)] == [report_work.id]

    result_id = finalize_announcement_claim(db, claims[0], now=NOW)
    db.flush()
    result = db.get(BoardAnnouncementRevision, result_id)
    assert result is not None
    assert result.announcement_id == item.id
    assert result.publication_key == work.id
    assert result.title == "Scheduled notice" and result.body == "Publish this content once"
    assert result.performed_by == actor.id
    assert work.state == WorkState.SUCCEEDED and work.publication_result_id == result.id
    assert work.lease_token is None and work.lease_expires_at is None
    assert item.displayed_publication_number == result.publication_number
    assert item.status == "published" and board.revision == 2
    assert finalize_announcement_claim(db, claims[0], now=NOW) is None
    assert claim_due_announcement_work(db, now=NOW) == []
    assert list(
        db.scalars(
            select(BoardAnnouncementRevision).where(
                BoardAnnouncementRevision.announcement_id == item.id
            )
        )
    ) == [result]


def test_revoked_board_edit_grant_cancels_without_publication(integration_owner_db):
    db = integration_owner_db
    actor, role, board, item, work = _subject(db)
    other_owner = User(
        email=f"announcement-owner-{uuid7().hex}@example.test",
        username=f"announcement_owner_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(other_owner)
    db.flush()
    board.owner_id = other_owner.id
    grant = BoardGrant(
        board_id=board.id,
        principal_type="user",
        principal_user_id=actor.id,
        permission="edit",
        effect="allow",
    )
    db.add(grant)
    db.flush()
    claim = claim_due_announcement_work(db, now=NOW)[0]
    grant.is_deleted = True
    grant.deleted_at = NOW
    db.flush()

    assert finalize_announcement_claim(db, claim, now=NOW) is None
    assert work.state == WorkState.CANCELED
    assert item.displayed_publication_number is None


def test_other_author_manager_downgraded_to_edit_cannot_publish(integration_owner_db):
    db = integration_owner_db
    actor, role, board, item, work = _subject(db)
    author = User(
        email=f"announcement-author-{uuid7().hex}@example.test",
        username=f"announcement_author_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(author)
    db.flush()
    board.owner_id = author.id
    item.author_id = author.id
    manager = BoardGrant(
        board_id=board.id,
        principal_type="user",
        principal_user_id=actor.id,
        permission="manage",
        effect="allow",
    )
    db.add(manager)
    db.flush()
    assert write_manager(db, board, actor)
    claim = claim_due_announcement_work(db, now=NOW)[0]

    manager.is_deleted = True
    manager.deleted_at = NOW
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=actor.id,
            permission="edit",
            effect="allow",
        )
    )
    db.flush()
    assert not write_manager(db, board, actor)

    assert finalize_announcement_claim(db, claim, now=NOW) is None
    assert work.state == WorkState.CANCELED
    assert work.publication_result_id is None
    assert item.displayed_publication_number is None
    assert (
        db.scalar(
            select(BoardAnnouncementRevision.id).where(
                BoardAnnouncementRevision.announcement_id == item.id
            )
        )
        is None
    )


@pytest.mark.parametrize(
    "change",
    [
        "board_archived",
        "item_archived",
        "actor_disabled",
        "write_revoked",
        "audience_excluded",
        "source_changed",
        "not_due",
        "expired",
    ],
)
def test_current_source_or_actor_denial_cancels_without_publication(integration_owner_db, change):
    db = integration_owner_db
    actor, role, board, item, work = _subject(db)
    claim = claim_due_announcement_work(db, now=NOW)[0]
    final_time = NOW
    if change == "board_archived":
        board.status = "archived"
    elif change == "item_archived":
        item.status = "archived"
    elif change == "actor_disabled":
        actor.status = UserStatus.DISABLED.value
    elif change == "write_revoked":
        sponsor = _other_user(db, role)
        actor.role = "guest"
        actor.sponsor_user_id = sponsor.id
        actor.expires_at = datetime.now(UTC) + timedelta(days=30)
    elif change == "audience_excluded":
        other = _other_user(db, role)
        item.audience_kind = "user"
        item.audience_user_id = other.id
    elif change == "source_changed":
        item.revision += 1
    elif change == "not_due":
        item.publish_at = NOW + timedelta(hours=1)
    else:
        item.expires_at = NOW + timedelta(seconds=30)
        final_time = NOW + timedelta(minutes=1)
    db.flush()

    assert finalize_announcement_claim(db, claim, now=final_time) is None
    db.flush()
    assert work.state == WorkState.CANCELED
    assert work.publication_result_id is None
    assert item.displayed_publication_number is None
    assert (
        db.scalar(
            select(BoardAnnouncementRevision.id).where(
                BoardAnnouncementRevision.announcement_id == item.id
            )
        )
        is None
    )


def test_expired_lease_recovery_rejects_old_claim_and_current_claim_publishes(integration_owner_db):
    db = integration_owner_db
    _actor, _role, _board, item, work = _subject(db)
    first = claim_due_announcement_work(db, now=NOW)[0]
    second = claim_due_announcement_work(db, now=NOW + timedelta(minutes=3))[0]
    assert second.lease_token != first.lease_token
    assert not fail_announcement_work(db, first, now=NOW + timedelta(minutes=3))
    assert finalize_announcement_claim(db, first, now=NOW + timedelta(minutes=3)) is None
    assert work.state == WorkState.RUNNING
    assert finalize_announcement_claim(db, second, now=NOW + timedelta(minutes=3)) is not None
    db.flush()
    assert item.status == "published" and work.state == WorkState.SUCCEEDED


def test_failed_announcement_claim_retries_with_backoff_and_terminal_limit(integration_owner_db):
    db = integration_owner_db
    _actor, _role, _board, item, work = _subject(db)
    for attempt in range(1, 6):
        claim = claim_due_announcement_work(db, now=NOW)[0]
        assert work.attempt_count == attempt
        assert fail_announcement_work(db, claim, now=NOW)
        assert not fail_announcement_work(db, claim, now=NOW)
        if attempt < 5:
            assert work.state == WorkState.PENDING
            assert work.next_attempt_at == NOW + timedelta(seconds=2**attempt)
            assert claim_due_announcement_work(db, now=NOW) == []
            work.next_attempt_at = NOW
        else:
            assert work.state == WorkState.FAILED
            assert work.failure_code == "attempts_exhausted"
    assert claim_due_announcement_work(db, now=NOW + timedelta(hours=1)) == []
    assert item.displayed_publication_number is None


def test_canceled_or_wrong_kind_claim_cannot_publish(integration_owner_db):
    db = integration_owner_db
    _actor, _role, _board, item, work = _subject(db)
    claim = claim_due_announcement_work(db, now=NOW)[0]
    work.state = WorkState.CANCELED
    work.lease_token = None
    work.lease_expires_at = None
    db.flush()

    assert finalize_announcement_claim(db, claim, now=NOW) is None
    assert finalize_announcement_claim(db, WorkClaim(uuid7(), uuid7()), now=NOW) is None
    assert item.displayed_publication_number is None


def test_rolled_back_publication_leaves_no_result_and_can_retry(integration_owner_db):
    db = integration_owner_db
    _actor, _role, board, item, work = _subject(db)
    claim = claim_due_announcement_work(db, now=NOW)[0]
    with pytest.raises(RuntimeError, match="controlled failure"):
        with db.begin_nested():
            assert finalize_announcement_claim(db, claim, now=NOW) is not None
            db.flush()
            raise RuntimeError("controlled failure")
    db.refresh(work)
    db.refresh(item)
    db.refresh(board)
    assert work.state == WorkState.RUNNING and work.publication_result_id is None
    assert item.status == "scheduled" and item.displayed_publication_number is None
    assert board.revision == 1
    assert (
        db.scalar(
            select(BoardAnnouncementRevision.id).where(
                BoardAnnouncementRevision.announcement_id == item.id
            )
        )
        is None
    )
    assert fail_announcement_work(db, claim, now=NOW)
    assert work.state == WorkState.PENDING


def test_coordinator_rolls_back_failed_publication_then_retries_once(
    integration_owner_db, monkeypatch
):
    db = integration_owner_db
    actor, _role, board, item, work = _subject(db)
    connection = db.connection()

    def session_factory(_engine):
        session = AuditSession(bind=connection, join_transaction_mode="create_savepoint")
        session.info[AUDIT_CONTEXT_KEY] = AuditContext(
            request_id=uuid7(),
            request_method="SCHEDULE",
            request_path="/internal/boards/announcement-scheduler",
        )
        return session

    monkeypatch.setattr(announcement_execution, "_session", session_factory)
    original = announcement_execution.publish_locked
    attempts = 0

    def publish_then_fail(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        revision = original(*args, **kwargs)
        if attempts == 1:
            raise RuntimeError("controlled publication failure")
        return revision

    monkeypatch.setattr(announcement_execution, "publish_locked", publish_then_fail)
    assert announcement_execution.execute_due_announcement_publications(connection, now=NOW) == []
    db.refresh(work)
    db.refresh(item)
    db.refresh(board)
    assert work.state == WorkState.PENDING and work.attempt_count == 1
    assert work.next_attempt_at == NOW + timedelta(seconds=2)
    assert item.status == "scheduled" and board.revision == 1
    assert (
        db.scalar(
            select(BoardAnnouncementRevision.id).where(
                BoardAnnouncementRevision.announcement_id == item.id
            )
        )
        is None
    )
    assert (
        db.scalar(select(InAppNotification.id).where(InAppNotification.work_id == work.id)) is None
    )

    completed = announcement_execution.execute_due_announcement_publications(
        connection, now=NOW + timedelta(seconds=2)
    )
    assert len(completed) == 1 and attempts == 2
    db.refresh(work)
    db.refresh(item)
    assert work.state == WorkState.SUCCEEDED and work.publication_result_id == completed[0]
    assert item.status == "published"
    notifications = list(
        db.scalars(select(InAppNotification).where(InAppNotification.work_id == work.id))
    )
    assert len(notifications) == 1
    assert notifications[0].recipient_id == actor.id
    revision = db.get(BoardAnnouncementRevision, completed[0])
    assert revision is not None and revision.performed_by == actor.id
