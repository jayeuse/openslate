"""Department attribution and department-manager access to persisted audit history."""

from datetime import UTC, date, datetime
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel, Group, GroupAccess
from app.systems.access.users.models import UserRole
from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardScope
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.manage.audit.listeners import REALTIME_INVALIDATION_KEY
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.dashboards.models import Dashboard
from app.systems.openview.reports.models import Report
from app.systems.openview.views.models import SavedView
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.rbac.support import (
    _client,
    add_department,
    add_module,
    add_user,
    make_group_access,
    organization,
)

pytestmark = pytest.mark.integration


def _created_log(db: Session, entity: object) -> AuditLog:
    row = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == entity.__tablename__,  # type: ignore[attr-defined]
            AuditLog.entity_id == entity.id,  # type: ignore[attr-defined]
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert row is not None
    return row


def _board_payloads(db: Session) -> list[dict[str, str]]:
    return [
        event.to_payload()
        for event in db.info.get(REALTIME_INVALIDATION_KEY, [])
        if event.entity.startswith("board")
    ]


def test_same_flush_record_ancestry_and_relationship_source_are_stamped(
    integration_db: Session,
) -> None:
    org_id = organization(integration_db).id
    inventory = Department(org_id=org_id, id=uuid7(), department_name=f"Inventory {uuid7()}")
    finance = Department(org_id=org_id, id=uuid7(), department_name=f"Finance {uuid7()}")
    module = Module(org_id=inventory.org_id, id=uuid7(),
                    department_id=inventory.id, module_name="Items")
    other_module = Module(org_id=finance.org_id, id=uuid7(),
                          department_id=finance.id, module_name="Accounts")
    field = Field(
        org_id=module.org_id,
        id=uuid7(),
        module_id=module.id,
        name="Related item",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=other_module.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    source = Record(org_id=module.org_id, id=uuid7(), module_id=module.id, data={})
    target = Record(org_id=other_module.org_id, id=uuid7(), module_id=other_module.id, data={})
    edge = RelationshipEdge(
        org_id=field.org_id,
        id=uuid7(), field_id=field.id, source_record_id=source.id, target_record_id=target.id
    )
    integration_db.add_all([inventory, finance, module, other_module, field, source, target, edge])
    integration_db.flush()

    for entity in (inventory, module, field, source, edge):
        assert _created_log(integration_db, entity).department_id == inventory.id
    for entity in (finance, other_module, target):
        assert _created_log(integration_db, entity).department_id == finance.id


def test_view_report_dashboard_and_group_access_use_their_own_department(
    integration_db: Session,
) -> None:
    department = add_department(integration_db)
    module = add_module(integration_db, department)
    group = Group(org_id=department.org_id, id=uuid7(), name=f"Audit group {uuid7()}")
    view = SavedView(org_id=module.org_id, module_id=module.id, name="All items", definition={})
    report = Report(org_id=module.org_id, module_id=module.id, name="Items", recipe={})
    dashboard = Dashboard(org_id=department.org_id, department_id=department.id, name="Items")
    grant = GroupAccess(
        org_id=department.org_id,
        group_id=group.id,
        department_id=department.id,
        module_id=None,
        level=AccessLevel.READ,
    )
    integration_db.add_all([group, view, report, dashboard, grant])
    integration_db.flush()

    for entity in (view, report, dashboard, grant):
        assert _created_log(integration_db, entity).department_id == department.id
    assert _created_log(integration_db, group).department_id is None


def test_board_content_and_revision_descendants_use_department_board_scope(
    integration_db: Session,
) -> None:
    department = add_department(integration_db)
    module = add_module(integration_db, department)
    author = add_user(integration_db, role=UserRole.ADMIN)
    record = Record(org_id=module.org_id, id=uuid7(), module_id=module.id, data={})
    board = Board(
        org_id=department.org_id,
        id=uuid7(), scope=BoardScope.DEPARTMENT, department_id=department.id, name="Items"
    )
    post = BoardPost(
        org_id=board.org_id,
        id=uuid7(), board_id=board.id, author_id=author.id, title="Count", body="Today"
    )
    event = BoardEvent(
        org_id=board.org_id,
        id=uuid7(),
        board_id=board.id,
        author_id=author.id,
        title="Count",
        all_day=True,
        start_date=date(2026, 10, 1),
        end_date=date(2026, 10, 1),
        timezone_name="UTC",
    )
    revision = BoardPostRevision(
        org_id=post.org_id,
        id=uuid7(),
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=author.id,
        title="Count",
        body="Today",
        published_at=datetime.now(UTC),
    )
    file = File(
        org_id=board.org_id,
        id=uuid7(),
        purpose="board_attachment",
        board_id=board.id,
        creator_id=author.id,
        filename="items.txt",
        expected_size=1,
        object_key=f"audit-{uuid7()}",
    )
    integration_db.add_all([record, board])
    integration_db.flush()
    integration_db.add_all([post, event, file])
    integration_db.flush()
    integration_db.add(revision)
    integration_db.flush()
    reminder = BoardEventReminder(
        org_id=event.org_id, board_id=board.id, event_id=event.id, timing="start",
    )
    link = BoardRecordLink(
        org_id=board.org_id,
        board_id=board.id,
        post_id=post.id,
        record_id=record.id,
        module_id=module.id,
    )
    attachment = BoardAttachment(
        org_id=board.org_id, board_id=board.id, post_id=post.id, file_id=file.id,
    )
    integration_db.add_all([reminder, link, attachment])
    integration_db.flush()
    revision_link = BoardPostRevisionRecordLink(
        org_id=revision.org_id,
        revision_id=revision.id, record_id=record.id, module_id=module.id
    )
    revision_attachment = BoardPostRevisionAttachment(
        org_id=revision.org_id, revision_id=revision.id, file_id=file.id,
    )
    integration_db.add_all([revision_link, revision_attachment])
    integration_db.flush()

    for entity in (
        board,
        post,
        event,
        revision,
        reminder,
        link,
        attachment,
        revision_link,
        revision_attachment,
    ):
        assert _created_log(integration_db, entity).department_id == department.id
    assert _created_log(integration_db, file).department_id is None
    assert {tuple(sorted(payload.items())) for payload in _board_payloads(integration_db)} == {
        tuple(sorted({"entity": entity, "board_id": str(board.id)}.items()))
        for entity in ("boards", "board_posts", "board_events")
    }


def test_persisted_parent_ancestry_is_loaded_for_children_after_expunge(
    integration_db: Session,
) -> None:
    department = add_department(integration_db)
    module = add_module(integration_db, department)
    author = add_user(integration_db, role=UserRole.ADMIN)
    relationship_field = Field(
        org_id=module.org_id,
        module_id=module.id,
        name="Related",
        type=FieldType.RELATIONSHIP,
        position=0,
        relationship_target_module_id=module.id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    source = Record(org_id=module.org_id, module_id=module.id, data={})
    target = Record(org_id=module.org_id, module_id=module.id, data={})
    board = Board(org_id=department.org_id, scope=BoardScope.DEPARTMENT,
                  department_id=department.id, name="Items")
    integration_db.add_all([relationship_field, source, target, board])
    integration_db.flush()
    post = BoardPost(org_id=board.org_id, board_id=board.id, author_id=author.id,
                     title="Count", body="Today")
    integration_db.add(post)
    integration_db.flush()
    link = BoardRecordLink(
        org_id=board.org_id,
        board_id=board.id,
        post_id=post.id,
        record_id=source.id,
        module_id=module.id,
    )
    integration_db.add(link)
    integration_db.flush()
    revision = BoardPostRevision(
        org_id=post.org_id,
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=author.id,
        title="Count",
        body="Today",
        published_at=datetime.now(UTC),
    )
    integration_db.add(revision)
    integration_db.flush()

    org_id = department.org_id
    department_id = department.id
    module_id = module.id
    board_id = board.id
    post_id = post.id
    integration_db.expunge_all()
    integration_db.info.pop(REALTIME_INVALIDATION_KEY, None)

    module_child = Field(org_id=org_id, module_id=module_id,
                         name="Notes", type=FieldType.TEXT, position=1)
    record_child = RelationshipEdge(
        org_id=org_id,
        field_id=relationship_field.id,
        source_record_id=source.id,
        target_record_id=target.id,
    )
    board_child = BoardEvent(
        org_id=org_id,
        board_id=board_id,
        author_id=author.id,
        title="Recount",
        all_day=True,
        start_date=date(2026, 10, 2),
        end_date=date(2026, 10, 2),
        timezone_name="UTC",
    )
    post_child = BoardPostRevision(
        org_id=org_id,
        post_id=post_id,
        publication_number=2,
        publication_key=uuid7(),
        content_fingerprint="b" * 64,
        author_id=author.id,
        title="Count",
        body="Today",
        published_at=datetime.now(UTC),
    )
    revision_child = BoardPostRevisionRecordLink(
        org_id=org_id,
        revision_id=revision.id, record_id=source.id, module_id=module_id
    )
    integration_db.add_all([module_child, record_child, board_child, post_child, revision_child])
    integration_db.flush()

    for child in (module_child, record_child, board_child, post_child, revision_child):
        assert _created_log(integration_db, child).department_id == department_id
    assert sorted(_board_payloads(integration_db), key=lambda payload: payload["entity"]) == [
        {"entity": "board_events", "board_id": str(board_id)},
        {"entity": "board_posts", "board_id": str(board_id)},
        {"entity": "board_posts", "board_id": str(board_id)},
    ]


def test_project_board_and_its_group_have_no_department(
    integration_db: Session,
) -> None:
    org_id = organization(integration_db).id
    board = Board(org_id=org_id, scope=BoardScope.PROJECT, name=f"Project {uuid7()}")
    group = Group(org_id=org_id, name=f"Project group {uuid7()}")
    integration_db.add_all([board, group])
    integration_db.flush()
    board_group = BoardGroup(org_id=board.org_id, board_id=board.id,
                             group_id=group.id, level=AccessLevel.READ)
    integration_db.add(board_group)
    integration_db.flush()

    for entity in (board, board_group, group):
        assert _created_log(integration_db, entity).department_id is None
    assert _board_payloads(integration_db) == [
        {"entity": "boards", "board_id": str(board.id)},
        {"entity": "boards", "board_id": str(board.id)},
    ]


def test_child_audit_department_survives_same_flush_parent_hard_delete(
    integration_db: Session,
) -> None:
    department = add_department(integration_db)
    module = add_module(integration_db, department)
    record = Record(org_id=module.org_id, module_id=module.id, data={})
    integration_db.add(record)
    integration_db.flush()
    department_id = department.id
    created_ids = {
        entity.__tablename__: _created_log(integration_db, entity).id
        for entity in (department, module, record)
    }

    integration_db.delete(record)
    integration_db.delete(module)
    integration_db.delete(department)
    integration_db.flush()

    assert integration_db.get(Department, department_id) is None
    for entity, entity_id in (
        (department, department_id),
        (module, module.id),
        (record, record.id),
    ):
        assert integration_db.get(AuditLog, created_ids[entity.__tablename__]).department_id == (
            department_id
        )
        deleted = integration_db.scalar(
            select(AuditLog).where(
                AuditLog.entity_type == entity.__tablename__,
                AuditLog.entity_id == entity_id,
                AuditLog.action == AuditAction.DELETE,
            )
        )
        assert deleted is not None and deleted.department_id == department_id


def test_department_manager_lists_only_the_explicitly_managed_department(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    inventory = add_department(integration_db)
    finance = add_department(integration_db)
    inventory_module = add_module(integration_db, inventory)
    finance_module = add_module(integration_db, finance)
    inventory_record = Record(
        org_id=inventory_module.org_id, module_id=inventory_module.id, data={},
    )
    finance_record = Record(org_id=finance_module.org_id, module_id=finance_module.id, data={})
    integration_db.add_all([inventory_record, finance_record])
    integration_db.flush()
    administrator = add_user(integration_db, role=UserRole.ADMIN)
    manager = add_user(integration_db, role=UserRole.MEMBER)
    module_manager = add_user(integration_db, role=UserRole.MEMBER)
    make_group_access(integration_db, [manager], inventory, level=AccessLevel.MANAGE)
    make_group_access(
        integration_db,
        [module_manager],
        inventory,
        inventory_module,
        level=AccessLevel.MANAGE,
    )

    path = "/api/audit-logs"
    inventory_path = f"{path}?department_id={inventory.id}&limit=100"
    listed = _client(api, manager, integration_db).get(inventory_path)
    assert listed.status_code == 200
    items = listed.json()["items"]
    assert str(inventory_record.id) in {item["entity_id"] for item in items}
    assert str(finance_record.id) not in {item["entity_id"] for item in items}
    assert all(item["department_id"] == str(inventory.id) for item in items)
    assert listed.json()["pagination"]["total"] == len(items)

    page = _client(api, manager, integration_db).get(
        f"{path}?department_id={inventory.id}&limit=1&offset=1"
    )
    assert page.status_code == 200
    assert page.json()["pagination"]["total"] == len(items)
    assert len(page.json()["items"]) == 1

    for actor, url in (
        (manager, path),
        (manager, f"{path}?department_id={finance.id}"),
        (manager, f"{path}?department_id={uuid7()}"),
        (module_manager, inventory_path),
    ):
        assert _client(api, actor, integration_db).get(url).status_code == 403

    all_logs = _client(api, administrator, integration_db).get(f"{path}?limit=100")
    assert all_logs.status_code == 200
    assert all_logs.json()["pagination"]["total"] > len(items)
    assert str(finance_record.id) in {item["entity_id"] for item in all_logs.json()["items"]}
    filtered = _client(api, administrator, integration_db).get(inventory_path)
    assert filtered.status_code == 200
    assert filtered.json()["pagination"]["total"] == len(items)

    inventory_log: UUID = _created_log(integration_db, inventory_record).id
    for restricted in (
        f"{path}/{inventory_log}",
        f"{path}/export?department_id={inventory.id}",
        "/api/security-events",
    ):
        assert _client(api, manager, integration_db).get(restricted).status_code == 403


def test_library_file_audit_uses_its_direct_department_through_archive_and_delete(integration_db):
    db = integration_db
    creator = add_user(db)
    department = add_department(db)
    file = File(
        org_id=department.org_id,
        purpose="library_document",
        department_id=department.id,
        creator_id=creator.id,
        filename="private.pdf",
        expected_size=1,
        object_key=uuid7().hex,
        state="awaiting_upload",
    )
    db.add(file)
    db.flush()
    assert _created_log(db, file).department_id == department.id
    department_id, file_id = department.id, file.id
    file.is_deleted = True
    file.deleted_at = datetime.now(UTC)
    db.flush()
    archived = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "files",
            AuditLog.entity_id == file_id,
            AuditLog.action == AuditAction.DELETE,
        )
    )
    assert archived is not None and archived.department_id == department_id
    # The existing listener records soft deletion as DELETE and reopening as UPDATE.
    file.is_deleted, file.deleted_at = False, None
    db.flush()
    updated = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "files",
            AuditLog.entity_id == file_id,
            AuditLog.action == AuditAction.UPDATE,
        )
    )
    assert updated is not None and updated.department_id == department_id
    db.delete(file)
    db.flush()
    db.delete(department)
    db.flush()
    deleted = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "files",
            AuditLog.entity_id == file_id,
            AuditLog.action == AuditAction.DELETE,
        )
    ).all()
    assert len(deleted) == 2 and all(log.department_id == department_id for log in deleted)
