"""Department lifecycle follows the department's Board, and Record purge waits for links."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import Group
from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardStatus, BoardWidget
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.platform.files.models import File
from app.systems.platform.scheduling.models import (
    InAppNotification,
    ScheduledWork,
    WorkKind,
    WorkState,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleBlockerCode, LifecycleTargetType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.boards.support import admin, department_board, project_board
from tests.boards.test_permanent_delete import _actor, _board_graph

pytestmark = pytest.mark.integration


def _closed_department(db: Session, name: str) -> Department:
    now = datetime.now(UTC)
    department = Department(
        department_name=f"{name} {uuid7().hex[:8]}", is_deleted=True, deleted_at=now
    )
    db.add(department)
    db.flush()
    return department


def test_closing_a_department_archives_its_board_and_reopening_restores_it(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    actor = admin(db)
    department = Department(department_name=f"Close {uuid7().hex[:8]}")
    db.add(department)
    db.flush()
    board = department_board(db, department)
    db.commit()

    close = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "close", actor.id)
    execute_lifecycle(db, close)
    db.refresh(board)
    assert board.status == BoardStatus.ARCHIVED

    reopen = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "reopen", actor.id)
    execute_lifecycle(db, reopen)
    db.refresh(board)
    assert board.status == BoardStatus.ACTIVE


def test_department_purge_removes_its_empty_board(integration_owner_db: Session) -> None:
    db = integration_owner_db
    department = _closed_department(db, "Empty board")
    board = department_board(db, department)
    other = project_board(db)
    db.commit()
    department_id, board_id = department.id, board.id

    plan = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department_id, "purge", None)
    assert [row.entity_id for row in plan.rows if row.entity_type == "boards"] == [board_id]
    assert not plan.blockers
    execute_lifecycle(db, plan)

    assert db.get(Department, department_id) is None
    assert db.get(Board, board_id) is None
    assert db.get(Board, other.id) is not None


def test_department_purge_cascades_its_board_graph_and_retains_source_and_audit(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = _actor(db, admin=True)
    set_audit_actor(db, author.id)
    board, child_ids, source_record, department = _board_graph(db, author, scope="department")
    department.is_deleted = True
    department.deleted_at = datetime.now(UTC)
    post = db.get(BoardPost, child_ids["board_posts"])
    revision = db.get(BoardPostRevision, child_ids["board_post_revisions"])
    event = db.get(BoardEvent, child_ids["board_events"])
    board_group = db.get(BoardGroup, child_ids["board_groups"])
    assert post is not None and revision is not None and event is not None
    assert board_group is not None
    group_id = board_group.group_id
    source_module = db.get(Module, source_record.module_id)
    assert source_module is not None
    source_department_id = source_module.department_id
    owned_module = Module(
        department_id=department.id,
        module_name=f"Owned {uuid7().hex[:8]}",
    )
    db.add(owned_module)
    db.flush()
    owned_record = Record(module_id=owned_module.id, data={})
    db.add(owned_record)
    db.flush()
    owned_widget = BoardWidget(
        board_id=board.id,
        module_id=owned_module.id,
        name="Owned records",
        position=1,
        widget_type="records",
        config={},
    )

    now = datetime.now(UTC)
    reminder = BoardEventReminder(
        board_id=board.id,
        event_id=event.id,
        timing="15m",
        is_deleted=True,
        deleted_at=now,
    )
    file = File(
        purpose="board_attachment",
        board_id=board.id,
        creator_id=author.id,
        filename="already-purged.txt",
        expected_size=1,
        object_key=uuid7().hex,
        state="purged",
        is_deleted=True,
        deleted_at=now,
    )
    db.add_all([reminder, file])
    db.flush()
    attachment = BoardAttachment(
        board_id=board.id,
        file_id=file.id,
        post_id=post.id,
        is_linked=False,
    )
    revision_attachment = BoardPostRevisionAttachment(revision_id=revision.id, file_id=file.id)
    record_link = BoardRecordLink(
        board_id=board.id,
        post_id=post.id,
        record_id=source_record.id,
        module_id=source_record.module_id,
    )
    owned_record_link = BoardRecordLink(
        board_id=board.id,
        post_id=post.id,
        record_id=owned_record.id,
        module_id=owned_module.id,
    )
    revision_link = BoardPostRevisionRecordLink(
        revision_id=revision.id,
        record_id=source_record.id,
        module_id=source_record.module_id,
    )
    owned_revision_link = BoardPostRevisionRecordLink(
        revision_id=revision.id,
        record_id=owned_record.id,
        module_id=owned_module.id,
    )
    post_work = ScheduledWork(
        kind=WorkKind.POST_PUBLISH,
        post_id=post.id,
        source_revision=revision.publication_number,
        scheduling_actor_id=author.id,
        publication_result_id=revision.id,
        scheduled_for=now,
        next_attempt_at=now,
        state=WorkState.SUCCEEDED,
    )
    reminder_work = ScheduledWork(
        kind=WorkKind.EVENT_REMINDER,
        reminder_id=reminder.id,
        occurrence_start_at=now,
        scheduled_for=now,
        next_attempt_at=now,
        state=WorkState.SUCCEEDED,
    )
    db.add_all([owned_widget, attachment, revision_attachment, record_link, owned_record_link])
    db.flush()
    db.add_all([revision_link, owned_revision_link, post_work, reminder_work])
    db.flush()
    post_notice = InAppNotification(
        work_id=post_work.id,
        recipient_id=author.id,
        kind="post-publish",
        subject_type="board_post",
        subject_id=post.id,
    )
    reminder_notice = InAppNotification(
        work_id=reminder_work.id,
        recipient_id=author.id,
        kind="event-reminder",
        subject_type="board_event",
        subject_id=reminder.event_id,
    )
    db.add_all([post_notice, reminder_notice])
    db.commit()

    audited_entities = (
        ("departments", department.id),
        ("boards", board.id),
        ("modules", owned_module.id),
        ("records", owned_record.id),
        ("board_groups", board_group.id),
        ("board_widgets", child_ids["board_widgets"]),
        ("board_widgets", owned_widget.id),
        ("board_events", event.id),
        ("board_event_reminders", reminder.id),
        ("board_posts", post.id),
        ("board_post_revisions", revision.id),
        ("board_attachments", attachment.id),
        ("board_post_revision_attachments", revision_attachment.id),
        ("board_record_links", record_link.id),
        ("board_record_links", owned_record_link.id),
        ("board_post_revision_record_links", revision_link.id),
        ("board_post_revision_record_links", owned_revision_link.id),
        ("files", file.id),
    )
    created_audit_ids = set(
        db.scalars(
            select(AuditLog.id).where(
                AuditLog.action == AuditAction.CREATE,
                AuditLog.entity_id.in_([entity_id for _, entity_id in audited_entities]),
            )
        ).all()
    )
    assert created_audit_ids

    plan = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", author.id)
    assert not plan.blockers
    planned_rows = {(row.entity_type, row.entity_id) for row in plan.rows}
    expected_rows = {
        ("boards", board.id),
        ("modules", owned_module.id),
        ("records", owned_record.id),
        ("board_groups", board_group.id),
        ("board_widgets", child_ids["board_widgets"]),
        ("board_widgets", owned_widget.id),
        ("board_events", event.id),
        ("board_event_reminders", reminder.id),
        ("board_posts", post.id),
        ("board_post_revisions", revision.id),
        ("board_attachments", attachment.id),
        ("board_post_revision_attachments", revision_attachment.id),
        ("board_record_links", record_link.id),
        ("board_record_links", owned_record_link.id),
        ("board_post_revision_record_links", revision_link.id),
        ("board_post_revision_record_links", owned_revision_link.id),
        ("files", file.id),
        ("scheduled_work", post_work.id),
        ("scheduled_work", reminder_work.id),
        ("in_app_notifications", post_notice.id),
        ("in_app_notifications", reminder_notice.id),
    }
    assert expected_rows <= planned_rows

    event.details = "Changed after the Department purge preview"
    db.commit()
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(db, plan)
    assert db.get(Department, department.id) is not None
    assert db.get(Board, board.id) is not None
    assert db.get(BoardEvent, event.id) is not None

    fresh = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", author.id)
    assert not fresh.blockers
    execute_lifecycle(db, fresh)

    for model, row_id in (
        (Department, department.id),
        (Module, owned_module.id),
        (Record, owned_record.id),
        (Board, board.id),
        (BoardGroup, board_group.id),
        (BoardWidget, child_ids["board_widgets"]),
        (BoardWidget, owned_widget.id),
        (BoardEvent, event.id),
        (BoardEventReminder, reminder.id),
        (BoardPost, post.id),
        (BoardPostRevision, revision.id),
        (BoardAttachment, attachment.id),
        (BoardPostRevisionAttachment, revision_attachment.id),
        (BoardRecordLink, record_link.id),
        (BoardRecordLink, owned_record_link.id),
        (BoardPostRevisionRecordLink, revision_link.id),
        (BoardPostRevisionRecordLink, owned_revision_link.id),
        (File, file.id),
        (ScheduledWork, post_work.id),
        (ScheduledWork, reminder_work.id),
        (InAppNotification, post_notice.id),
        (InAppNotification, reminder_notice.id),
    ):
        assert db.get(model, row_id) is None
    assert db.get(Record, source_record.id) is not None
    assert db.get(Module, source_module.id) is not None
    assert db.get(Department, source_department_id) is not None
    assert db.get(Group, group_id) is not None

    retained_audit_ids = set(
        db.scalars(select(AuditLog.id).where(AuditLog.id.in_(created_audit_ids))).all()
    )
    assert retained_audit_ids == created_audit_ids
    deleted_audit_entities = {
        (row.entity_type, row.entity_id)
        for row in db.scalars(
            select(AuditLog).where(
                AuditLog.action == AuditAction.DELETE,
                AuditLog.entity_id.in_([entity_id for _, entity_id in audited_entities]),
            )
        ).all()
    }
    assert set(audited_entities) <= deleted_audit_entities


def test_department_purge_blocks_an_owned_file_until_its_bytes_are_purged(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = admin(db)
    department = _closed_department(db, "Board with unpurged file")
    board = department_board(db, department)
    post = BoardPost(board_id=board.id, author_id=author.id, title="Attachment", body="Details")
    db.add(post)
    db.flush()
    file = File(
        purpose="board_attachment",
        board_id=board.id,
        creator_id=author.id,
        filename="not-yet-purged.txt",
        expected_size=1,
        object_key=uuid7().hex,
        state="awaiting_upload",
    )
    db.add(file)
    db.flush()
    attachment = BoardAttachment(board_id=board.id, file_id=file.id, post_id=post.id)
    db.add(attachment)
    db.commit()

    plan = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", author.id)
    blockers = [
        item for item in plan.blockers if item.code is LifecycleBlockerCode.PURGE_FILE_DEPENDENCY
    ]
    assert [item.entity_id for item in blockers] == [file.id]
    assert not any(
        item.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY for item in plan.blockers
    )
    assert ("files", file.id) in {(row.entity_type, row.entity_id) for row in plan.rows}
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(db, plan)
    assert db.get(Department, department.id) is not None
    assert db.get(Board, board.id) is not None
    assert db.get(BoardPost, post.id) is not None
    assert db.get(File, file.id) is not None


def test_department_purge_plan_drifts_when_its_board_changes_before_execution(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = _closed_department(db, "Drift")
    board = department_board(db, department)
    db.commit()

    plan = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", None)
    before = next(row for row in plan.rows if row.entity_type == "boards")
    board.description = "Changed after preview"
    board.revision += 1
    db.commit()
    current = plan_lifecycle(db, LifecycleTargetType.DEPARTMENT, department.id, "purge", None)
    after = next(row for row in current.rows if row.entity_type == "boards")
    assert after.state_fingerprint != before.state_fingerprint
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(db, plan)
    assert db.get(Board, board.id) is not None


@pytest.mark.parametrize("target_type", ["module", "department"])
def test_parent_purge_waits_for_board_record_links_to_be_removed(
    integration_owner_db: Session, target_type: str
) -> None:
    db = integration_owner_db
    now = datetime.now(UTC)
    author = admin(db)
    department = _closed_department(db, "Linked parent")
    department_board(db, department)
    module = Module(
        department_id=department.id, module_name="Linked", is_deleted=True, deleted_at=now
    )
    db.add(module)
    db.flush()
    record = Record(module_id=module.id, data={}, is_deleted=True, deleted_at=now)
    board = project_board(db)
    db.add(record)
    db.flush()
    item = BoardPost(board_id=board.id, author_id=author.id, title="Linked", body="Body")
    db.add(item)
    db.flush()
    link = BoardRecordLink(
        board_id=board.id, post_id=item.id, record_id=record.id, module_id=module.id
    )
    db.add(link)
    db.commit()
    target_id = module.id if target_type == "module" else department.id

    plan = plan_lifecycle(db, target_type, target_id, "purge", author.id)
    assert link.id in {
        blocker.entity_id
        for blocker in plan.blockers
        if blocker.code is LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY
    }
    with pytest.raises(LifecyclePreflightError):
        execute_lifecycle(db, plan)
    assert db.get(Record, record.id) is not None

    db.delete(link)
    db.commit()
    unlinked = plan_lifecycle(db, target_type, target_id, "purge", author.id)
    assert not unlinked.blockers
    execute_lifecycle(db, unlinked)
    assert db.get(Record, record.id) is None
    assert db.get(Module, module.id) is None
