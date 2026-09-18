from record_queries.test_database import setup_rows
from uuid6 import uuid7
from views.test_access import actor

from app.systems.openview.views.models import SavedView
from app.systems.platform.files.models import File
from app.systems.sandbox.lifecycle.planning import plan_lifecycle


def test_purge_lists_and_blocks_unpurged_attachments_and_lists_saved_views(query_db):
    owner = actor(query_db)
    module, _, records = setup_rows(query_db, "text", ["value"])
    attachment = File(
        purpose="record_attachment",
        record_id=records[0].id,
        creator_id=owner.id,
        filename="private.pdf",
        expected_size=100,
        object_key=uuid7().hex,
        state="awaiting_upload",
    )
    view = SavedView(
        module_id=module.id,
        owner_id=owner.id,
        name="Private",
        visibility="private",
        definition={"version": 1},
    )
    module.is_deleted = True
    query_db.add_all([attachment, view])
    query_db.flush()
    plan = plan_lifecycle(query_db, "module", module.id, "purge", None)
    assert {row.entity_type for row in plan.rows} >= {"files", "saved_views"}
    assert any(blocker.code == "purge_file_dependency" for blocker in plan.blockers)
    assert attachment.id in plan.scope_ids["files"]
    before = plan.impact_digest
    attachment.state = "purged"
    query_db.flush()
    current = plan_lifecycle(query_db, "module", module.id, "purge", None)
    assert current.impact_digest != before
    assert not current.blockers


def test_parent_purge_deletes_confirmed_file_inventory_and_views_through_audit(query_db):
    from sqlalchemy import select

    from app.systems.manage.audit.models import AuditLog
    from app.systems.sandbox.lifecycle.execution import execute_lifecycle
    from app.systems.sandbox.modules.models import Module
    from app.systems.sandbox.records.models import Record

    owner = actor(query_db)
    module, _, records = setup_rows(query_db, "text", ["value"])
    attachment = File(
        purpose="record_attachment",
        record_id=records[0].id,
        creator_id=owner.id,
        filename="private.pdf",
        expected_size=100,
        object_key=uuid7().hex,
        state="purged",
        is_deleted=True,
    )
    view = SavedView(
        module_id=module.id,
        owner_id=owner.id,
        name="Private",
        visibility="private",
        definition={"version": 1},
    )
    module.is_deleted = True
    query_db.add_all([attachment, view])
    query_db.commit()
    module_id, record_id, file_id, view_id = module.id, records[0].id, attachment.id, view.id
    plan = plan_lifecycle(query_db, "module", module_id, "purge", None)
    execute_lifecycle(query_db, plan)
    assert query_db.get(Module, module_id) is None
    assert query_db.get(Record, record_id) is None
    assert query_db.get(File, file_id) is None
    assert query_db.get(SavedView, view_id) is None
    events = query_db.scalars(
        select(AuditLog).where(
            AuditLog.action == "delete", AuditLog.entity_id.in_([file_id, view_id])
        )
    ).all()
    assert {event.entity_type for event in events} == {"files", "saved_views"}


def test_close_does_not_archive_file_or_view(query_db):
    from app.systems.sandbox.lifecycle.execution import execute_lifecycle

    owner = actor(query_db)
    module, _, records = setup_rows(query_db, "text", ["value"])
    attachment = File(
        purpose="record_attachment",
        record_id=records[0].id,
        creator_id=owner.id,
        filename="private.pdf",
        expected_size=100,
        object_key=uuid7().hex,
        state="pending_scan",
    )
    view = SavedView(
        module_id=module.id,
        owner_id=owner.id,
        name="Private",
        visibility="private",
        definition={"version": 1},
    )
    query_db.add_all([attachment, view])
    query_db.commit()
    plan = plan_lifecycle(query_db, "module", module.id, "close", None)
    assert not any(row.entity_type in {"files", "saved_views"} for row in plan.rows)
    execute_lifecycle(query_db, plan)
    assert not attachment.is_deleted and attachment.state == "pending_scan"
    assert not view.is_deleted
