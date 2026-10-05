from datetime import UTC, datetime

from record_queries.test_database import setup_rows
from uuid6 import uuid7
from views.test_access import actor

from app.systems.openview.views.models import SavedView
from app.systems.platform.files.models import File
from app.systems.sandbox.lifecycle.batch_dependencies import load_purge_dependencies
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.planning_scope import LifecycleScope
from app.systems.sandbox.lifecycle.schemas import LifecycleTargetType
from app.systems.sandbox.modules.models import Module


def test_purge_dependency_inventory_tracks_saved_view_default_changes():
    now = datetime.now(UTC)
    module_id, view_id = uuid7(), uuid7()
    module = Module(
        id=module_id,
        department_id=uuid7(),
        module_name="Inventory",
        is_deleted=True,
        deleted_at=now,
        updated_at=now,
    )
    view = SavedView(
        id=view_id,
        module_id=module_id,
        name="Shared",
        is_default=False,
        definition={"version": 1},
        presentation={"version": 1},
        is_deleted=False,
        deleted_at=None,
        updated_at=now,
    )

    class ScalarRows(list):
        def all(self):
            return self

    class DependencySession:
        def scalars(self, statement):
            entity = statement.column_descriptions[0]["entity"]
            return ScalarRows({SavedView: [view]}.get(entity, []))

    scope = LifecycleScope(
        departments=(),
        modules=(module,),
        fields=(),
        records=(),
        edges=(),
    )
    dependencies = load_purge_dependencies(
        DependencySession(),  # type: ignore[arg-type]
        scope,
        LifecycleTargetType.MODULE,
    )

    assert dependencies.ids["saved_views"] == (view_id,)
    assert "saved_view_defaults" not in dependencies.ids
    first = next(row for row in dependencies.rows if row.entity_type == "saved_views")
    view.is_default = True
    changed = load_purge_dependencies(
        DependencySession(),  # type: ignore[arg-type]
        scope,
        LifecycleTargetType.MODULE,
    )
    changed_state = next(row for row in changed.rows if row.entity_type == "saved_views")
    assert changed_state.state_fingerprint != first.state_fingerprint


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
        name="Shared",
        definition={"version": 1},
    )
    module.is_deleted = True
    query_db.add_all([attachment, view])
    query_db.flush()
    plan = plan_lifecycle(query_db, "module", module.id, "purge", None)
    assert {row.entity_type for row in plan.rows} >= {"files", "saved_views"}
    assert any(blocker.code == "purge_file_dependency" for blocker in plan.blockers)
    assert attachment.id in plan.scope_ids["files"]
    assert view.id in plan.scope_ids["saved_views"]
    before = plan.impact_digest
    view.is_default = True
    query_db.flush()
    after_default_change = plan_lifecycle(query_db, "module", module.id, "purge", None)
    assert after_default_change.impact_digest != before

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
        name="Shared",
        definition={"version": 1},
    )
    module.is_deleted = True
    query_db.add_all([attachment, view])
    query_db.commit()
    module_id, record_id, file_id, view_id = (
        module.id,
        records[0].id,
        attachment.id,
        view.id,
    )
    plan = plan_lifecycle(query_db, "module", module_id, "purge", None)
    execute_lifecycle(query_db, plan)
    assert query_db.get(Module, module_id) is None
    assert query_db.get(Record, record_id) is None
    assert query_db.get(File, file_id) is None
    assert query_db.get(SavedView, view_id) is None
    events = query_db.scalars(
        select(AuditLog).where(
            AuditLog.action == "delete",
            AuditLog.entity_id.in_([file_id, view_id]),
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
        state="awaiting_upload",
    )
    view = SavedView(
        module_id=module.id,
        name="Shared",
        definition={"version": 1},
    )
    query_db.add_all([attachment, view])
    query_db.commit()
    plan = plan_lifecycle(query_db, "module", module.id, "close", None)
    assert not any(row.entity_type in {"files", "saved_views"} for row in plan.rows)
    execute_lifecycle(query_db, plan)
    assert not attachment.is_deleted and attachment.state == "awaiting_upload"
    assert not view.is_deleted
