"""Compound batches cross HTTP and real PostgreSQL item/outer transactions."""

from datetime import UTC, datetime
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from uuid6 import uuid7

from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.record_triggers.models import RecordTriggerEvent
from app.systems.sandbox.records.models import Record
from tests.catalog.record_batch_support import batch_world as batch_world
from tests.catalog.record_batch_support import compound, create, effects, item, submit
from tests.catalog.record_batch_support import world as world
from tests.rbac.support import add_department, add_module

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("kind", ["date", "datetime"])
def test_compound_pair_saves_one_complete_record_and_event_beside_both_single_forms(
    batch_world, kind
):
    world = batch_world
    world.fields["end"] = Field(
        module_id=world.module.id, name="End", type=kind, position=20, config={}
    )
    world.db.add(world.fields["end"])
    world.db.commit()
    before_start, before_end, after_start, after_end = (
        ("2026-10-03", "2026-10-05", "2026-10-04", "2026-10-06")
        if kind == "date"
        else (
            "2026-10-03T12:30:01.123Z",
            "2026-10-05T13:00:02.456Z",
            "2026-10-04T12:30:01.123Z",
            "2026-10-06T13:00:02.456Z",
        )
    )
    pair = create(world, "Pair", **{kind: before_start, "end": before_end})
    single, legacy = create(world, "Single"), create(world, "Legacy")
    start, end, title = (str(world.fields[name].id) for name in (kind, "end", "title"))
    response = submit(
        world,
        [
            compound(pair, (start, after_start), (end, after_end)),
            compound(single, (title, "One-change opt-in")),
            item(legacy, world.fields["title"].id, "Legacy saved"),
        ],
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    results = response.json()["results"]
    assert [(result["record_id"], result["status"]) for result in results] == [
        (row["id"], "updated") for row in (pair, single, legacy)
    ]
    for old, result, changes in zip(
        (pair, single, legacy),
        results,
        (
            {start: after_start, end: after_end},
            {title: "One-change opt-in"},
            {title: "Legacy saved"},
        ),
        strict=True,
    ):
        saved = result["record"]
        assert saved["data"] == {**old["data"], **changes}
        assert saved["updated_at"] != old["updated_at"]
        assert world.client.get(f"/api/records/{old['id']}").json() == saved
        updates, events, notices = effects(world.db, old)
        assert len(updates) == len(events) == 1 and notices == []
        assert set(events[0].changed_field_ids) == set(changes)
        assert events[0].previous_values == old["data"]
        assert events[0].values == saved["data"]


@pytest.mark.parametrize(
    "bad_field", ["date", "datetime", "title", "user", "closed", "foreign", "relationship"]
)
def test_invalid_second_change_rolls_back_both_fields_while_other_items_commit(
    batch_world, bad_field
):
    world = batch_world
    first, rejected, last = [create(world, name) for name in ("First", "Rejected", "Last")]
    if bad_field in {"closed", "foreign", "relationship"}:
        second = Field(
            module_id=world.module.id, name="Unsupported", type="text", position=20, config={}
        )
        if bad_field == "closed":
            second.is_deleted = True
        elif bad_field == "foreign":
            second.module_id = add_module(world.db, add_department(world.db)).id
        else:
            second.type = "relationship"
            second.relationship_target_module_id = world.module.id
            second.relationship_multiple_targets = True
            second.relationship_multiple_sources = True
        world.db.add(second)
        world.db.commit()
        invalid_value = "Must not save"
    else:
        second = world.fields[bad_field]
        invalid_value = {
            "date": "2026-02-30",
            "datetime": {"not": "a timestamp"},
            "title": None,
            "user": str(world.reader.id),
        }[bad_field]
        if bad_field == "user":
            world.grant.is_deleted = True
            world.grant.deleted_at = datetime.now(UTC)
            world.db.commit()
    response = submit(
        world,
        [
            item(first, world.fields["title"].id, "First saved"),
            compound(rejected, (world.fields["int"].id, 42), (second.id, invalid_value)),
            compound(last, (world.fields["title"].id, "Last saved")),
        ],
    )
    assert response.status_code == 200, response.text
    results = response.json()["results"]
    assert [result["status"] for result in results] == ["updated", "invalid", "updated"]
    assert results[1]["errors"][0]["field_id"] == str(second.id)
    assert results[1]["errors"][0]["code"] == {
        "title": "required_field",
        "closed": "closed_field_mutation",
        "foreign": "unknown_field",
        "relationship": "relationship_field",
    }.get(bad_field, "invalid_field_value")
    assert world.client.get(f"/api/records/{rejected['id']}").json() == rejected
    assert effects(world.db, rejected) == ([], [], [])
    for row, result in ((first, results[0]), (last, results[2])):
        assert world.client.get(f"/api/records/{row['id']}").json() == result["record"]
        updates, events, _ = effects(world.db, row)
        assert len(updates) == len(events) == 1


def test_compound_assignment_is_one_event_and_one_net_new_notification(batch_world):
    world = batch_world
    row = create(world, "Before")
    title, user = world.fields["title"].id, world.fields["user"].id
    response = submit(world, [compound(row, (title, "Assigned"), (user, str(world.reader.id)))])
    assert response.status_code == 200, response.text
    saved = response.json()["results"][0]["record"]
    assert saved["data"] == {**row["data"], str(title): "Assigned", str(user): str(world.reader.id)}
    updates, events, notices = effects(world.db, row)
    assert len(updates) == len(events) == len(notices) == 1
    assert notices[0].recipient_id == world.reader.id
    assert set(events[0].changed_field_ids) == {str(title), str(user)}
    unchanged = submit(world, [compound(saved, (title, "Assigned"), (user, str(world.reader.id)))])
    assert unchanged.status_code == 200
    assert unchanged.json()["results"][0]["status"] == "updated"
    assert tuple(len(rows) for rows in effects(world.db, row)) == (1, 1, 1)


def test_compound_constraint_failure_rolls_back_both_values_and_item_effects(
    batch_world, monkeypatch
):
    import app.systems.sandbox.records.batch_router as batch_router

    world = batch_world
    first, rejected, last = [create(world, name) for name in ("First", "Rejected", "Last")]
    original = batch_router.notify_record_assignments

    def fail_constraint(db, record, *, previous, fields):
        original(db, record, previous=previous, fields=fields)
        if str(record.id) == rejected["id"]:
            event = db.scalar(
                select(RecordTriggerEvent).where(
                    RecordTriggerEvent.record_id == record.id,
                    RecordTriggerEvent.event_kind == "field-changed",
                )
            )
            event.depth = -1

    monkeypatch.setattr(batch_router, "notify_record_assignments", fail_constraint)
    response = submit(
        world,
        [
            compound(
                row,
                (world.fields["title"].id, "Saved"),
                (world.fields["user"].id, str(world.reader.id)),
            )
            for row in (first, rejected, last)
        ],
    )
    assert response.status_code == 200, response.text
    results = response.json()["results"]
    assert [result["status"] for result in results] == ["updated", "invalid", "updated"]
    assert results[1]["errors"] == [
        {"code": "record_update_failed", "field_id": None, "message": "Unable to update record"}
    ]
    assert world.client.get(f"/api/records/{rejected['id']}").json() == rejected
    assert effects(world.db, rejected) == ([], [], [])
    for row in (first, last):
        assert tuple(len(rows) for rows in effects(world.db, row)) == (1, 1, 1)


@pytest.mark.parametrize("failure,status", [(IntegrityError, 409), (OperationalError, 503)])
def test_compound_outer_commit_failure_confirms_nothing_and_rolls_back_all_items(
    batch_world, monkeypatch, failure, status
):
    world = batch_world
    rows = [create(world, name) for name in ("First", "Last")]

    def fail_commit():
        raise failure("owned commit", None, ValueError("private-canary"))

    monkeypatch.setattr(world.db, "commit", fail_commit)
    response = submit(
        world,
        [
            compound(row, (world.fields["title"].id, "Refused"), (world.fields["int"].id, 42))
            for row in rows
        ],
    )
    assert response.status_code == status, response.text
    assert "results" not in response.json() and "private-canary" not in response.text
    for row in rows:
        assert world.db.get(Record, UUID(row["id"])).data == row["data"]
        assert effects(world.db, row) == ([], [], [])


def test_compound_invalid_envelope_is_422_before_even_valid_items_write(batch_world):
    """One HTTP case; test_record_import_rules.py owns every compound envelope rule."""

    world = batch_world
    row = create(world, "Keep")
    change = compound(row, (world.fields["title"].id, "Refused"))
    change.update(field_id=str(world.fields["title"].id), value="Mixed")
    response = submit(world, [item(row, world.fields["title"].id, "Also refused"), change])
    assert response.status_code == 422, response.text
    assert world.client.get(f"/api/records/{row['id']}").json() == row
    assert effects(world.db, row) == ([], [], [])


def test_compound_hidden_wrong_module_and_missing_results_reveal_only_input_ids(batch_world):
    world = batch_world
    own = create(world, "Own")
    hidden = Record(
        module_id=add_module(world.db, add_department(world.db)).id, data={"private": "canary"}
    )
    world.db.add(hidden)
    world.db.commit()
    identifiers = (str(hidden.id), str(uuid7()))
    response = submit(
        world,
        [
            {
                **compound(
                    own, (world.fields["title"].id, "Refused"), (world.fields["int"].id, 42)
                ),
                "record_id": identifier,
            }
            for identifier in identifiers
        ],
    )
    assert response.status_code == 200, response.text
    assert response.json()["results"] == [
        {"status": "forbidden", "record_id": identifier} for identifier in identifiers
    ]
    assert hidden.data == {"private": "canary"}
    assert world.client.get(f"/api/records/{own['id']}").json() == own
