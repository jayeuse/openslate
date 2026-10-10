"""Plural snapshots through real Auth, runtime policy and one PostgreSQL view."""

import json
from contextlib import contextmanager
from datetime import UTC, datetime

import pytest
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import GroupAccess
from app.systems.manage.audit.models import SecurityEvent
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records import aggregation, query_router
from app.systems.sandbox.records.models import Record
from tests.record_queries.export_http_support import ExportWorld
from tests.record_queries.export_http_support import export_world as export_world
from tests.record_queries.export_http_support import fake_provider as fake_provider
from tests.record_queries.export_http_support import provider_account as provider_account

pytestmark = pytest.mark.integration
PATH = "/api/records/aggregate-snapshots"


@contextmanager
def second_module(world: ExportWorld):
    with Session(world.owner) as db:
        module = Module(department_id=world.department_id, module_name="Second batch source")
        db.add(module)
        db.flush()
        field = Field(module_id=module.id, name="Label", type="text", position=0, config={})
        grant = GroupAccess(
            group_id=world.group_id,
            department_id=world.department_id,
            module_id=module.id,
            level="read",
        )
        db.add_all([field, grant])
        db.flush()
        record = Record(module_id=module.id, data={str(field.id): "Second"})
        db.add(record)
        db.commit()
        ids = module.id, field.id, grant.id, record.id
    try:
        yield (
            {
                "mode": "groups",
                "module_id": str(ids[0]),
                "definition": {"columns": []},
                "dimension": {"field_id": str(ids[1]), "expected_type": "text"},
            },
            ids[2],
        )
    finally:
        with Session(world.owner) as db:
            for model, identifier in (
                (Record, ids[3]),
                (Field, ids[1]),
                (GroupAccess, ids[2]),
                (Module, ids[0]),
            ):
                db.delete(db.get(model, identifier))
                db.flush()
            db.commit()


def queries(world: ExportWorld) -> list[dict[str, object]]:
    common = {
        "mode": "groups",
        "module_id": str(world.module_id),
        "definition": {"columns": []},
        "dimension": {"field_id": str(world.label_id), "expected_type": "text"},
    }
    return [
        {**common, "aggregation": "count"},
        {
            **common,
            "aggregation": "sum",
            "measure": {"field_id": str(world.amount_id), "expected_type": "decimal"},
        },
    ]


def events(world: ExportWorld) -> list[SecurityEvent]:
    from sqlalchemy import select

    with Session(world.owner) as db:
        return list(
            db.scalars(
                select(SecurityEvent).where(
                    SecurityEvent.actor_id == world.actor_id,
                    SecurityEvent.event_type == "records.aggregate_snapshots.authorized",
                )
            )
        )


def test_batch_snapshot_is_complete_ordered_and_commits_one_private_event(
    export_world: ExportWorld,
):
    response = export_world.client.post(PATH, json={"queries": queries(export_world)})
    assert response.status_code == 200
    snapshots = response.json()["items"]
    assert len(snapshots) == 2
    assert [(item["label"], item["value"]) for item in snapshots[0]["items"]] == [
        ("Alpha", 1),
        ("Beta", 1),
        ("Gamma", 1),
    ]
    assert [(item["label"], item["value"]) for item in snapshots[1]["items"]] == [
        ("Beta", "10"),
        ("Gamma", "3"),
        ("Alpha", "2"),
    ]
    assert all(
        item["pagination"]["count"] == item["pagination"]["total"] == 3 for item in snapshots
    )
    assert all(not item["pagination"]["has_more"] for item in snapshots)
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    recorded = events(export_world)
    assert len(recorded) == 1
    assert recorded[0].event_metadata == {
        "query_count": 2,
        "bucket_count": 6,
        "module_ids": [str(export_world.module_id)],
    }


@pytest.mark.parametrize("count", [0, 13])
def test_batch_rejects_empty_or_over_twelve_queries(export_world: ExportWorld, count: int):
    response = export_world.client.post(PATH, json={"queries": [queries(export_world)[0]] * count})
    assert response.status_code == 422
    assert events(export_world) == []


def test_hidden_later_module_refuses_whole_batch(export_world: ExportWorld):
    from uuid6 import uuid7

    requests = queries(export_world)
    requests[1]["module_id"] = str(uuid7())
    response = export_world.client.post(PATH, json={"queries": requests})
    assert response.status_code == 404
    assert "items" not in response.json()
    assert b"Alpha" not in response.content and events(export_world) == []


def test_batch_accepts_twelve_queries_and_rejects_missing_identity(export_world: ExportWorld):
    body = {"queries": [queries(export_world)[0]] * 12}
    response = export_world.client.post(PATH, json=body)
    assert response.status_code == 200 and len(response.json()["items"]) == 12
    assert len(events(export_world)) == 1
    export_world.client.cookies.clear()
    assert export_world.client.post(PATH, json=body).status_code == 401
    assert len(events(export_world)) == 1


def test_later_distinct_module_is_rechecked_after_materialization(
    export_world: ExportWorld, monkeypatch
):
    with second_module(export_world) as (request, grant_id):
        original = aggregation.aggregate_snapshot_records
        completed = []

        def revoke_later_module(db, payload, *, reader):
            result = original(db, payload, reader=reader)
            completed.append(True)
            if len(completed) == 2:
                with Session(export_world.owner) as writer:
                    writer.get(GroupAccess, grant_id).is_deleted = True
                    writer.commit()
            return result

        monkeypatch.setattr(aggregation, "aggregate_snapshot_records", revoke_later_module)
        response = export_world.client.post(
            PATH, json={"queries": [queries(export_world)[0], request]}
        )
        assert completed == [True, True]
        assert response.status_code == 403 and events(export_world) == []


def test_multi_module_batch_preserves_request_order_and_target_metadata(export_world: ExportWorld):
    with second_module(export_world) as (request, _):
        response = export_world.client.post(
            PATH, json={"queries": [request, queries(export_world)[0]]}
        )
        assert response.status_code == 200
        assert response.json()["items"][0]["items"][0]["label"] == "Second"
        event = events(export_world)[0]
        assert event.subject_id is None
        assert event.event_metadata == {
            "query_count": 2,
            "bucket_count": 4,
            "module_ids": sorted([str(export_world.module_id), request["module_id"]]),
        }


def test_queries_share_one_repeatable_read_view(export_world: ExportWorld, monkeypatch):
    original = aggregation.aggregate_snapshot_records
    observed = []

    def change_between_queries(db, payload, *, reader):
        result = original(db, payload, reader=reader)
        observed.append(db.connection())
        if len(observed) == 1:
            with Session(export_world.owner) as writer:
                record = writer.get(Record, export_world.record_ids[1])
                record.data = {**record.data, str(export_world.amount_id): "90"}
                writer.commit()
        return result

    monkeypatch.setattr(aggregation, "aggregate_snapshot_records", change_between_queries)
    response = export_world.client.post(PATH, json={"queries": queries(export_world)})
    assert response.status_code == 200
    assert len(observed) == 2 and observed[0] is observed[1]
    assert response.json()["items"][1]["items"][0]["value"] == "10"
    with Session(export_world.owner) as reader:
        assert (
            reader.get(Record, export_world.record_ids[1]).data[str(export_world.amount_id)] == "90"
        )


@pytest.mark.parametrize("lost", ["module_access", "session"])
def test_batch_fences_live_authority_before_output(export_world: ExportWorld, monkeypatch, lost):
    original = aggregation.aggregate_snapshot_records
    completed = []

    def revoke_after_last_query(db, payload, *, reader):
        result = original(db, payload, reader=reader)
        completed.append(True)
        if len(completed) == 2:
            with Session(export_world.owner) as writer:
                if lost == "module_access":
                    writer.get(GroupAccess, export_world.grant_id).is_deleted = True
                else:
                    writer.get(IdentitySession, export_world.session_id).revoked_at = datetime.now(
                        UTC
                    )
                writer.commit()
        return result

    monkeypatch.setattr(aggregation, "aggregate_snapshot_records", revoke_after_last_query)
    response = export_world.client.post(PATH, json={"queries": queries(export_world)})
    assert completed == [True, True]
    assert response.status_code == 403
    assert b"Alpha" not in response.content and events(export_world) == []


def test_batch_bucket_cap_applies_to_total_result(export_world: ExportWorld, monkeypatch):
    monkeypatch.setattr(aggregation, "MAX_AGGREGATE_SNAPSHOT_BUCKETS", 5)
    response = export_world.client.post(PATH, json={"queries": queries(export_world)})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "aggregate_snapshot_limit_exceeded"
    assert events(export_world) == []


def test_batch_byte_cap_includes_outer_json(export_world: ExportWorld, monkeypatch):
    request = queries(export_world)[0]
    singular = export_world.client.post("/api/records/aggregate-snapshot", json=request)
    assert singular.status_code == 200
    expected = json.dumps(
        {"items": [singular.json(), singular.json()]}, separators=(",", ":")
    ).encode()
    monkeypatch.setattr(aggregation, "MAX_AGGREGATE_SNAPSHOT_BYTES", len(expected))
    accepted = export_world.client.post(PATH, json={"queries": [request, request]})
    assert accepted.status_code == 200
    monkeypatch.setattr(aggregation, "MAX_AGGREGATE_SNAPSHOT_BYTES", len(expected) - 1)
    rejected = export_world.client.post(PATH, json={"queries": [request, request]})
    assert rejected.status_code == 422
    assert len(events(export_world)) == 1


@pytest.mark.parametrize("failure", ["query", "event"])
def test_batch_dependency_failure_releases_no_partial_body(
    export_world: ExportWorld, monkeypatch, failure
):
    def unavailable(*_args, **_kwargs):
        raise OperationalError("unavailable", {}, RuntimeError("unavailable"))

    if failure == "query":
        original = aggregation.aggregate_snapshot_records
        calls = []

        def fail_second(db, payload, *, reader):
            calls.append(True)
            if len(calls) == 2:
                return unavailable()
            return original(db, payload, reader=reader)

        monkeypatch.setattr(aggregation, "aggregate_snapshot_records", fail_second)
    else:
        monkeypatch.setattr(query_router, "append_security_event", unavailable)
    response = export_world.client.post(PATH, json={"queries": queries(export_world)})
    assert response.status_code == 503
    assert b"Alpha" not in response.content and events(export_world) == []
