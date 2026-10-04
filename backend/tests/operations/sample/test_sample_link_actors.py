"""Relationships use a person who can write the source and read the target."""

import json
from contextlib import ExitStack
from dataclasses import replace
from datetime import date
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest

from operations.sample.blueprint import edge_child_ids
from operations.sample.client import SampleClient
from operations.sample.episodes import plan_sessions
from operations.sample.packs import get_pack
from operations.sample.packs.types import RejectionCase
from operations.sample.population.activity import run_activity
from operations.sample.scenario import build_dataset
from operations.sample.verification.core import verify_records_and_relationships
from operations.seed_sample_data import build_plan_summary
from tests.operations.sample.packs.test_school_access import _LEVEL_RANK, _module_level
from tests.operations.sample.test_sample_actor_access import _restricted_pack

ANCHOR = date(2026, 9, 30)
LEAD, CLERK, BRIDGE = "internal_ops_lead", "internal_ops_02", "internal_ops_04"


def _id(key):
    return str(uuid5(NAMESPACE_URL, "link-actor:" + key))


def _pack(*, no_writer=False, bridge=False, rejection=False):
    pack = _restricted_pack()
    if no_writer or bridge:
        grants = {**pack.actors.group_access, "lead-grants": (("ops", "requests", "manage"),)}
        actors = replace(pack.actors, group_access=grants)
        if bridge:
            person = replace(
                actors.people[1],
                key=BRIDGE,
                groups=("bridge-grants",),
                email="casey.lane@northside.example",
                username="casey_lane",
            )
            grants["bridge-grants"] = (("ops", "requests", "write"), ("ops", "updates", "read"))
            actors = replace(
                actors,
                people=(*actors.people, person),
                team_keys={"ops": (*actors.team_keys["ops"], BRIDGE)},
            )
        pack = replace(pack, actors=actors)
    cases = ()
    if rejection:
        cases = (
            RejectionCase(
                "linked-record-refusal",
                "guest_01",
                ("requests:000001", "updates:000001"),
                403,
                "Forbidden",
            ),
        )
    return replace(
        pack,
        history=replace(pack.history, status_paths={}, target_share=0.0),
        blueprint=replace(pack.blueprint, record_created_trigger_keys=()),
        rejections=replace(pack.rejections, activity_cases=cases),
    )


def _dataset(**options):
    return build_dataset("small", seed=17, anchor_date=ANCHOR, organization=_pack(**options))


def test_school_relationship_creators_have_source_write_and_target_read():
    dataset = build_dataset("small", seed=42, anchor_date=ANCHOR, organization=get_pack("school"))
    records = {record.logical_id: record for record in dataset.records}
    failures = []
    cross_department = 0
    for edge, child_id in zip(dataset.edges, edge_child_ids(dataset), strict=True):
        source, target = records[edge.source_record_id], records[edge.target_record_id]
        child = records[child_id]
        actor = edge.creator_key
        cross_department += source.actor_key != target.actor_key

        def level(person, record):
            return _LEVEL_RANK[
                _module_level(dataset.organization, person, record.actor_key, record.module_key)
            ]

        if level(actor, source) < 2 or level(actor, target) < 1:
            failures.append((edge.source_record_id, edge.target_record_id, actor))
        if level(child.creator_key, source) >= 2 and level(child.creator_key, target) >= 1:
            assert actor == child.creator_key
    assert failures == []
    assert cross_department == 415


def test_relationships_without_an_eligible_member_stop_before_population():
    with pytest.raises(ValueError, match="relationship.*writer"):
        _dataset(no_writer=True)


def test_relationship_writer_falls_back_to_another_eligible_team_member():
    dataset = build_dataset(
        "small",
        seed=17,
        anchor_date=ANCHOR,
        organization=_pack(bridge=True),
        module_counts_override={"requests": 30, "updates": 30},
    )
    records = {record.logical_id: record for record in dataset.records}
    lead_parent_edges = [
        edge for edge in dataset.edges if records[edge.source_record_id].creator_key == LEAD
    ]
    assert lead_parent_edges
    assert {getattr(edge, "creator_key", "") for edge in lead_parent_edges} == {BRIDGE}


def test_a_different_link_writer_has_short_one_person_sessions_before_refusals():
    dataset = build_dataset(
        "small",
        seed=17,
        anchor_date=ANCHOR,
        organization=_pack(rejection=True),
        module_counts_override={"requests": 17, "updates": 17},
    )
    sessions = plan_sessions(dataset)
    created, linked = set(), set()
    link_sessions = []
    for session in sessions:
        if session.kind == "create":
            created.update(session.record_ids)
        elif session.kind == "link":
            link_sessions.append(session)
            assert session.creator_key == LEAD
            assert session.module_key == "requests"
            assert session.record_ids == () and session.steps == ()
            assert 1 <= len(session.edge_indices) <= 6
            for index in session.edge_indices:
                edge = dataset.edges[index]
                assert {edge.source_record_id, edge.target_record_id} <= created
                assert index not in linked
                linked.add(index)
        elif session.kind == "reject":
            assert any(
                dataset.edges[index].target_record_id == "updates:000001" for index in linked
            )
    assert link_sessions
    assert linked == set(range(len(dataset.edges)))


def test_planned_writes_count_links_against_their_source_writer():
    summary = build_plan_summary(_dataset())
    assert summary["writes_by_person"] == {LEAD: 4, CLERK: 2}


@pytest.mark.parametrize("busy", (False, True))
def test_activity_uses_the_link_writer_client_for_writes_reconciliation_and_mapping(tmp_path, busy):
    dataset = _dataset()
    records = {record.logical_id: record for record in dataset.records}
    queues = {
        dataset.module_ids[key]: [record for record in dataset.records if record.module_key == key]
        for key in dataset.module_counts
    }
    stored, edges = {}, []
    attempted_busy = False

    def handler(actor):
        def request(request):
            nonlocal attempted_busy
            if request.url.path == "/api/auth/login":
                return httpx.Response(
                    200,
                    json={"authenticated": True},
                    headers=[
                        ("set-cookie", "openslate_access=opaque; Path=/"),
                        ("set-cookie", "openslate_csrf=csrf; Path=/"),
                    ],
                )
            if request.url.path == "/api/records" and request.method == "POST":
                payload = json.loads(request.content)
                record = queues[payload["module_id"]].pop(0)
                assert actor == record.creator_key
                stored[record.logical_id] = _id(record.logical_id)
                return httpx.Response(201, json={"id": stored[record.logical_id], **payload})
            if request.url.path == "/api/relationships":
                assert actor == LEAD, "relationship request must use source writer's client"
                if request.method == "GET":
                    return httpx.Response(200, json={"items": [edges[-1]]})
                body = json.loads(request.content)
                assert {body["source_record_id"], body["target_record_id"]} <= set(stored.values())
                edge = {"id": _id(f"edge:{len(edges)}"), **body}
                edges.append(edge)
                if busy and not attempted_busy:
                    attempted_busy = True
                    return httpx.Response(
                        503, json={"detail": "Relationship operation is temporarily unavailable"}
                    )
                return httpx.Response(201, json=edge)
            pytest.fail(f"Unexpected offline request {request.method} {request.url.path}")

        return request

    with ExitStack() as stack:
        clients = {}
        for actor in (LEAD, CLERK):
            client = stack.enter_context(
                SampleClient(
                    "https://api.example.test",
                    "https://workspace.example.test",
                    tmp_path / f"{actor}.jsonl",
                    transport=httpx.MockTransport(handler(actor)),
                )
            )
            client.login(f"{actor}@northside.example", "not-a-real-password")
            clients[actor] = client
        result = run_activity(
            dataset,
            plan_sessions(dataset),
            modules={key: {"id": value} for key, value in dataset.module_ids.items()},
            field_ids={
                key: {value: value for value in fields.values()}
                for key, fields in dataset.field_ids.items()
            },
            relationship_fields={
                "request_updates": {"id": _id("field"), "relationship_multiple_targets": True}
            },
            actor_ids={actor: _id(actor) for actor in clients},
            clients=clients,
        )
    assert result.edge_count == len(edges) == len(dataset.edges) == 2
    assert set(result.records) == set(records)
    for actor in (LEAD, CLERK):
        journal = [
            json.loads(line) for line in (tmp_path / f"{actor}.jsonl").read_text().splitlines()
        ]
        mappings = [
            event
            for event in journal
            if event.get("event") == "id_mapping" and event.get("kind") == "edge"
        ]
        assert len(mappings) == (2 if actor == LEAD else 0)


@pytest.mark.parametrize("audit_actor", (LEAD, CLERK))
def test_readback_matches_edge_audits_to_the_planned_link_writer(tmp_path, audit_actor):
    dataset = _dataset()
    record_ids = {record.logical_id: _id(record.logical_id) for record in dataset.records}
    actor_ids = {LEAD: _id(LEAD), CLERK: _id(CLERK)}
    relationship_id = _id("field")
    rows = [
        {
            "id": record_ids[record.logical_id],
            "module_id": dataset.module_ids[record.module_key],
            "data": record.data,
        }
        for record in dataset.records
    ]
    edges = [
        {
            "id": _id(f"edge:{index}"),
            "field_id": relationship_id,
            "source_record_id": record_ids[edge.source_record_id],
            "target_record_id": record_ids[edge.target_record_id],
        }
        for index, edge in enumerate(dataset.edges)
    ]

    def audit(entity_id, actor, path):
        return {
            "entity_id": entity_id,
            "performed_by": actor_ids[actor],
            "action": "create",
            "request_method": "POST",
            "request_path": path,
            "request_id": _id("request:" + entity_id),
        }

    record_audits = [
        audit(record_ids[record.logical_id], record.creator_key, "/api/records")
        for record in dataset.records
    ]
    edge_audits = [audit(edge["id"], audit_actor, "/api/relationships") for edge in edges]

    def handler(request):
        if request.url.path == "/api/records":
            result = [row for row in rows if row["module_id"] == request.url.params["module_id"]]
        elif request.url.path == "/api/relationships":
            result = edges
        elif request.url.path == "/api/audit-logs":
            result = (
                record_audits if request.url.params["entity_type"] == "records" else edge_audits
            )
        else:
            pytest.fail(f"Unexpected offline GET {request.url.path}")
        return httpx.Response(
            200,
            json={
                "items": result,
                "pagination": {
                    "total": len(result),
                    "count": len(result),
                    "limit": 100,
                    "offset": 0,
                    "has_more": False,
                },
            },
        )

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        observed, issues = verify_records_and_relationships(
            client,
            dataset=dataset,
            mappings={
                "modules": dataset.module_ids,
                "records": record_ids,
                "fields": {
                    f"{module}:{key}": value
                    for module, fields in dataset.field_ids.items()
                    for key, value in fields.items()
                },
                "relationships": {"request_updates": relationship_id},
            },
            actor_ids=actor_ids,
            started_at="2026-09-30T00:00:00+00:00",
            finished_at="2026-09-30T01:00:00+00:00",
            require_complete=True,
        )
    if audit_actor == LEAD:
        assert observed["relationship_audit_matches"] == 2
        assert issues == []
    else:
        assert observed["relationship_audit_matches"] == 0
        assert "a relationship is missing matching authenticated create audit evidence" in issues
