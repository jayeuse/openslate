"""Batch items cross real HTTP, field validation, policy, audit and PostgreSQL."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import AccessLevel
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.record_triggers.models import RecordTriggerEvent
from app.systems.sandbox.records.models import Record
from tests.catalog.record_batch_support import batch_world as batch_world
from tests.catalog.record_batch_support import create, item, submit
from tests.catalog.test_record_import_integration import world as world
from tests.rbac.support import add_department, add_module

pytestmark = pytest.mark.integration


def _updates(db, row_id):
    return list(
        db.scalars(
            select(AuditLog).where(
                AuditLog.entity_type == "records",
                AuditLog.entity_id == UUID(row_id),
                AuditLog.action == AuditAction.UPDATE,
            )
        )
    )


def _events(db, row_id):
    return list(
        db.scalars(
            select(RecordTriggerEvent).where(
                RecordTriggerEvent.record_id == UUID(row_id),
                RecordTriggerEvent.event_kind == "field-changed",
            )
        )
    )


def _notices(db, row_id):
    return list(
        db.scalars(
            select(InAppNotification).where(
                InAppNotification.kind == "record-assigned",
                InAppNotification.subject_id == UUID(row_id),
            )
        )
    )


def test_batch_preserves_other_values_and_commits_successes_around_invalid_and_stale_items(
    batch_world,
):
    world = batch_world
    first, invalid, stale, last = [
        create(world, name) for name in ("First", "Invalid", "Stale", "Last")
    ]
    field = world.fields["title"]
    stale_item = item(stale, field.id, "Must not save")
    stale_item["revision"] = "2020-01-01T00:00:00Z"
    response = submit(
        world,
        [
            item(first, field.id, "Moved first"),
            item(invalid, field.id, None),
            stale_item,
            item(last, field.id, "Moved last"),
        ],
    )

    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    results = response.json()["results"]
    assert [result["record_id"] for result in results] == [
        row["id"] for row in (first, invalid, stale, last)
    ]
    assert [result["status"] for result in results] == ["updated", "invalid", "stale", "updated"]
    assert results[1]["errors"] == [
        {"code": "required_field", "field_id": str(field.id), "message": "Field is required"}
    ]
    for index, old, title in ((0, first, "Moved first"), (3, last, "Moved last")):
        saved = results[index]["record"]
        assert saved["data"] == {**old["data"], str(field.id): title}
        assert saved["updated_at"] != old["updated_at"]
        stored = world.client.get(f"/api/records/{old['id']}").json()
        assert saved == stored
        assert len(_updates(world.db, old["id"])) == len(_events(world.db, old["id"])) == 1
    for old in (invalid, stale):
        assert world.client.get(f"/api/records/{old['id']}").json()["data"] == old["data"]
        assert _updates(world.db, old["id"]) == _events(world.db, old["id"]) == []


def test_batch_reports_unchanged_assignee_lost_access_without_weakening_validation(batch_world):
    world = batch_world
    assigned = create(world, "Assigned", user=str(world.reader.id))
    valid = create(world, "Unaffected")
    world.grant.is_deleted = True
    world.grant.deleted_at = datetime.now(UTC)
    world.db.commit()
    response = submit(
        world,
        [
            item(assigned, world.fields["title"].id, "Must not save"),
            item(valid, world.fields["title"].id, "Saved"),
        ],
    )
    assert response.status_code == 200, response.text
    results = response.json()["results"]
    assert [result["status"] for result in results] == ["invalid", "updated"]
    assert results[0]["errors"] == [
        {
            "code": "invalid_field_value",
            "field_id": str(world.fields["user"].id),
            "message": "User must be an active reader of this module",
        }
    ]
    assert world.client.get(f"/api/records/{assigned['id']}").json()["data"] == assigned["data"]
    assert _updates(world.db, assigned["id"]) == _events(world.db, assigned["id"]) == []
    assert len(_notices(world.db, assigned["id"])) == 1


def test_missing_wrong_module_and_hidden_records_have_identical_forbidden_results(batch_world):
    world = batch_world
    own = create(world, "Own")
    other_module = add_module(world.db, add_department(world.db))
    hidden = Record(org_id=other_module.org_id,
                    module_id=other_module.id, data={"private": "must never return"})
    world.db.add(hidden)
    world.db.commit()
    from uuid6 import uuid7

    missing_id = str(uuid7())
    ids = (str(hidden.id), missing_id)
    world.grant.level = AccessLevel.WRITE
    world.db.commit()
    for actor in (world.admin, world.reader):
        world.actor[0] = actor
        response = submit(
            world,
            [
                {**item(own, world.fields["title"].id, "Ignored"), "record_id": record_id}
                for record_id in ids
            ],
        )
        assert response.status_code == 200, response.text
        assert response.json()["results"] == [
            {"status": "forbidden", "record_id": record_id} for record_id in ids
        ]
    assert hidden.data == {"private": "must never return"}
    assert _updates(world.db, str(hidden.id)) == []
    assert world.client.get(f"/api/records/{own['id']}").json()["data"] == own["data"]


@pytest.mark.parametrize("actor_name", ["reader", "outsider", "guest"])
def test_batch_outer_authority_denial_writes_nothing(batch_world, actor_name):
    world = batch_world
    row = create(world, "Keep")
    world.actor[0] = getattr(world, actor_name)
    response = submit(world, [item(row, world.fields["title"].id, "Refused")])
    assert response.status_code == 403, response.text
    assert world.db.get(Record, UUID(row["id"])).data == row["data"]
    assert _updates(world.db, row["id"]) == _events(world.db, row["id"]) == []


def test_batch_rechecks_the_exact_revoked_session_before_any_item(batch_world):
    world = batch_world
    row = create(world, "Keep")
    session = world.db.scalar(
        select(IdentitySession).where(IdentitySession.user_id == world.admin.id)
    )
    session.revoked_at = datetime.now(UTC)
    world.db.commit()
    response = submit(world, [item(row, world.fields["title"].id, "Refused")])
    assert response.status_code == 403
    assert world.db.get(Record, UUID(row["id"])).data == row["data"]
    assert _updates(world.db, row["id"]) == _events(world.db, row["id"]) == []


@pytest.mark.parametrize("bad_field", ["closed", "foreign", "relationship"])
def test_batch_rejects_unsupported_field_changes_per_item(batch_world, bad_field):
    world = batch_world
    row = create(world, "Keep")
    field = Field(
        org_id=world.module.org_id,
        module_id=world.module.id, name="Unsupported", type="text", position=20, config={}
    )
    if bad_field == "closed":
        field.is_deleted = True
    elif bad_field == "foreign":
        field.module_id = add_module(world.db, add_department(world.db)).id
    else:
        field.type = "relationship"
        field.relationship_target_module_id = world.module.id
        field.relationship_multiple_targets = True
        field.relationship_multiple_sources = True
    world.db.add(field)
    world.db.commit()
    response = submit(world, [item(row, field.id, "Must not save")])
    assert response.status_code == 200, response.text
    result = response.json()["results"][0]
    assert result["status"] == "invalid"
    assert (
        result["errors"][0]["code"]
        == {
            "closed": "closed_field_mutation",
            "foreign": "unknown_field",
            "relationship": "relationship_field",
        }[bad_field]
    )
    assert world.db.get(Record, UUID(row["id"])).data == row["data"]
    assert _updates(world.db, row["id"]) == _events(world.db, row["id"]) == []


def test_batch_assignment_is_net_new_and_unchanged_values_do_not_enqueue_events(batch_world):
    world = batch_world
    row = create(world, "Keep")
    response = submit(world, [item(row, world.fields["user"].id, str(world.reader.id))])
    assert response.status_code == 200, response.text
    saved = response.json()["results"][0]["record"]
    assert saved["data"] == {**row["data"], str(world.fields["user"].id): str(world.reader.id)}
    assert [notice.recipient_id for notice in _notices(world.db, row["id"])] == [world.reader.id]
    assert len(_events(world.db, row["id"])) == 1
    response = submit(world, [item(saved, world.fields["user"].id, str(world.reader.id))])
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["status"] == "updated"
    assert len(_notices(world.db, row["id"])) == len(_events(world.db, row["id"])) == 1


def test_batch_constraint_failure_rolls_back_only_that_item_and_its_notification(
    batch_world, monkeypatch
):
    world = batch_world
    first, rejected, last = [create(world, name) for name in ("First", "Rejected", "Last")]
    import app.systems.sandbox.records.batch_router as batch_router

    original = batch_router.notify_record_assignments

    def invalid_recipient(db, record, *, previous, fields):
        original(db, record, previous=previous, fields=fields)
        if str(record.id) == rejected["id"]:
            for event in db.scalars(
                select(RecordTriggerEvent).where(
                    RecordTriggerEvent.record_id == record.id,
                    RecordTriggerEvent.event_kind == "field-changed",
                )
            ):
                event.depth = -1

    monkeypatch.setattr(batch_router, "notify_record_assignments", invalid_recipient)
    response = submit(
        world,
        [
            item(row, world.fields["user"].id, str(world.reader.id))
            for row in (first, rejected, last)
        ],
    )
    assert response.status_code == 200, response.text
    assert [result["status"] for result in response.json()["results"]] == [
        "updated",
        "invalid",
        "updated",
    ]
    assert world.db.get(Record, UUID(rejected["id"])).data == rejected["data"]
    assert (
        _updates(world.db, rejected["id"])
        == _events(world.db, rejected["id"])
        == _notices(world.db, rejected["id"])
        == []
    )
    for row in (first, last):
        assert (
            len(_updates(world.db, row["id"]))
            == len(_events(world.db, row["id"]))
            == len(_notices(world.db, row["id"]))
            == 1
        )


def test_batch_outer_commit_failure_returns_failure_and_no_updated_rows(batch_world, monkeypatch):
    world = batch_world
    row = create(world, "Keep")
    monkeypatch.setattr(
        world.db,
        "commit",
        lambda: (_ for _ in ()).throw(
            IntegrityError("owned test commit", None, ValueError("owned"))
        ),
    )
    response = submit(world, [item(row, world.fields["title"].id, "Must roll back")])
    assert response.status_code == 409, response.text
    assert "results" not in response.json()
    assert world.db.get(Record, UUID(row["id"])).data == row["data"]
    assert _updates(world.db, row["id"]) == _events(world.db, row["id"]) == []


def test_batch_request_validation_rejects_before_writing(batch_world):
    """One HTTP case; test_record_import_rules.py owns every batch envelope rule."""

    world = batch_world
    row = create(world, "Keep")
    change = item(row, world.fields["title"].id, "Refused")
    changes = [change] * 101
    response = submit(world, changes)
    assert response.status_code == 422, response.text
    assert world.db.get(Record, UUID(row["id"])).data == row["data"]
    assert _updates(world.db, row["id"]) == _events(world.db, row["id"]) == []
