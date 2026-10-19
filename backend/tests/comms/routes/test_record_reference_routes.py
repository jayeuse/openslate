"""Cards are current, source-bound projections; a missing grant never yields cached record data."""

from uuid import UUID

import pytest
from uuid6 import uuid7

from app.systems.access.policy.models import GroupAccess, GroupMember
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.comms.conftest import NOW
from tests.comms.routes.message_support import send
from tests.comms.routes.structure_support import ROOT, _channel, _created, _error, _ok, _read, _tag

pytestmark = pytest.mark.integration


@pytest.fixture
def linked_records(structure_routes):
    case, org = structure_routes, structure_routes.world.first
    with case.world.session(org) as db:
        source = Module(org_id=org.id, department_id=org.department, module_name="Orders")
        destination = Module(org_id=org.id, department_id=org.department, module_name="Moved")
        db.add_all([source, destination])
        db.flush()
        field = Field(
            org_id=org.id, module_id=source.id, name="Order title", type="text", position=0
        )
        db.add(field)
        db.flush()
        source.title_field_id = field.id
        record = Record(org_id=org.id, module_id=source.id, data={str(field.id): "Current title"})
        db.add(record)
        db.add(GroupMember(org_id=org.id, group_id=org.group, user_id=org.peer))
        access = GroupAccess(
            org_id=org.id,
            group_id=org.group,
            department_id=org.department,
            module_id=source.id,
            level="read",
        )
        db.add(access)
        db.flush()
        ids = (source.id, destination.id, field.id, record.id, access.id)
        db.commit()
    try:
        yield case, ids
    finally:
        with case.world.session(org) as db:
            db.get(Module, ids[0]).title_field_id = None
            db.flush()
            db.delete(db.get(Field, ids[2]))
            db.commit()


def test_live_record_cards_capture_module_and_recheck_record_and_conversation_sources(
    linked_records,
):
    case, (module, destination, field, record, grant) = linked_records
    org = case.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    _, c = _created(
        admin,
        ROOT + "/conversations",
        _channel("Cards", scope="members", member_ids=[str(org.peer)]),
    )
    conversation = UUID(c.rsplit("/", 1)[-1])
    case.settings({"record_card_fields": [str(field)]}, conversation)
    created = send(peer, c + "/messages", "", record_ids=[str(record)])
    card = created["record_references"][0]
    assert card["state"] == "available" and card["record_id"] == str(record)
    assert card["module_id"] == str(module) and card["module_name"] == "Orders"
    assert card["title"] == "Current title"
    assert card["fields"] == [
        {"field_id": str(field), "label": "Order title", "display_value": "Current title"}
    ]
    ref_path = c + "/record-references/" + card["id"]
    assert _ok(peer.get(ref_path)) == card
    assert _ok(peer.get(ROOT + "/record-references"))["items"] == [card]
    with case.world.session(org) as db:
        db.get(Record, record).data = {str(field): "Changed title"}
        db.commit()
    assert _ok(peer.get(ref_path))["title"] == "Changed title"
    with case.world.session(org) as db:
        db.get(GroupAccess, grant).is_deleted = True
        db.commit()
    unavailable = {"id": card["id"], "state": "unavailable"}
    assert _ok(peer.get(ref_path)) == unavailable
    assert _ok(peer.get(c + "/messages/" + created["id"]))["record_references"] == [unavailable]
    assert _ok(peer.get(ROOT + "/record-references"))["items"] == [unavailable]
    replay = _ok(
        peer.post(
            c + "/messages",
            json={
                "client_key": created["client_key"],
                "body": "",
                "record_ids": [str(record)],
            },
        )
    )
    assert replay["id"] == created["id"] and replay["record_references"] == [unavailable]
    assert _ok(admin.get(ref_path))["state"] == "available"
    before = _ok(peer.get(c + "/messages"))["pagination"]["high_water_seq"]
    _error(
        peer.post(
            c + "/messages",
            json={
                "client_key": str(uuid7()),
                "body": "Denied reference",
                "record_ids": [str(record)],
            },
        ),
        422,
    )
    assert _ok(peer.get(c + "/messages"))["pagination"]["high_water_seq"] == before
    with case.world.session(org) as db:
        db.get(Record, record).module_id = destination
        db.commit()
    assert _ok(admin.get(ref_path)) == unavailable  # Even an admin cannot rebind a captured source.
    response = admin.delete(c + f"/members/{org.peer}", headers={"If-Match": _tag(_read(admin, c))})
    assert response.status_code == 204
    _error(peer.get(ref_path), 404)
    assert _ok(peer.get(ROOT + "/record-references"))["items"] == []
    _ok(admin.delete(c + "/messages/" + created["id"]))
    _error(admin.get(ref_path), 404)
    assert _ok(admin.get(ROOT + "/record-references"))["items"] == []


def test_record_admission_and_quote_reads_never_widen_sources(linked_records):
    case, (module, _destination, _field, record, _grant) = linked_records
    org, foreign = case.world.first, case.world.second
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    c = f"{ROOT}/conversations/{org.conversation}"
    case.settings({"allowed_record_modules": [str(uuid7())]}, org.conversation)
    _error(
        admin.post(
            c + "/messages",
            json={"client_key": str(uuid7()), "body": "", "record_ids": [str(record)]},
        ),
        422,
    )
    case.settings(
        {"allowed_record_modules": [str(module)], "require_record_link": True}, org.conversation
    )
    _error(
        peer.post(c + "/messages", json={"client_key": str(uuid7()), "body": "Missing link"}), 422
    )
    root = send(peer, c + "/messages", "Referenced", record_ids=[str(record)])
    quoted = send(peer, c + "/messages", "Quote", reply_to_id=root["id"], record_ids=[str(record)])
    assert quoted["reply_to_id"] == root["id"] and "quote" not in quoted
    case.add_visited_guest()
    outsider = case.client(org.author, foreign.id)
    _error(outsider.get(c + "/record-references/" + root["record_references"][0]["id"]), 404)
    assert _ok(outsider.get(ROOT + "/record-references"))["pagination"]["total"] == 0
    _ok(peer.delete(c + "/messages/" + root["id"]))
    assert _ok(peer.get(c + "/messages/" + root["id"]))["state"] == "deleted"
    current = _ok(peer.get(c + "/messages/" + quoted["id"]))
    assert current["reply_to_id"] == root["id"] and current["body"] == "Quote"


def test_source_purge_inventory_blocks_retained_links_without_exposing_private_conversations(
    linked_records,
):
    from app.systems.sandbox.lifecycle.planner import plan_lifecycle
    from app.systems.sandbox.lifecycle.schemas import LifecycleOperation, LifecycleTargetType

    case, (_module, _destination, _field, record, _grant) = linked_records
    org = case.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    _, path = _created(
        admin,
        ROOT + "/conversations",
        _channel("Private reference", scope="members", member_ids=[str(org.peer)]),
    )
    message = send(peer, path + "/messages", "", record_ids=[str(record)])
    assert (
        admin.delete(
            path + f"/members/{org.author}", headers={"If-Match": _tag(_read(admin, path))}
        ).status_code
        == 204
    )
    _error(admin.get(path), 404)
    with case.world.session(org) as db:
        source = db.get(Record, record)
        source.is_deleted, source.deleted_at = True, NOW
        db.commit()
        plan = plan_lifecycle(
            db, LifecycleTargetType.RECORD, record, LifecycleOperation.PURGE, org.author
        )
        impact = plan.response()
        assert any(
            blocker.entity_id == record and blocker.code == "purge_external_schema_dependency"
            for blocker in impact.blockers
        )
        public = impact.model_dump_json()
        assert path.rsplit("/", 1)[-1] not in public
        assert message["record_references"][0]["id"] not in public
