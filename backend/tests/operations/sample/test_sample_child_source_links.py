"""A relationship whose source record is created later links from that source record."""

import json
from contextlib import ExitStack
from dataclasses import replace
from datetime import date
from uuid import NAMESPACE_URL, uuid5

import httpx

from operations.sample.client import SampleClient
from operations.sample.episodes import plan_sessions, record_parents
from operations.sample.packs.types import RelationshipSpec
from operations.sample.population.activity import run_activity
from operations.sample.scenario import build_dataset
from tests.operations.sample.test_sample_actor_access import _restricted_pack

ANCHOR = date(2026, 9, 30)
LEAD, CLERK = "internal_ops_lead", "internal_ops_02"
COUNTS = {"requests": 4, "updates": 9}


def _pack(*, clerk_reads_requests: bool = True):
    pack = _restricted_pack()
    grants = dict(pack.actors.group_access)
    if clerk_reads_requests:
        # Only the clerk writes updates, and the clerk can read the requests they name.
        grants["clerk-grants"] = (("ops", "updates", "write"), ("ops", "requests", "read"))
    else:
        # Both write updates; only the lead can read requests, so the lead links them all.
        grants["lead-grants"] = (("ops", None, "manage"),)
        grants["clerk-grants"] = (("ops", "updates", "write"),)
    # Each update names the request it belongs to: the update is the source and the child.
    spec = RelationshipSpec("update_request", "Request", "updates", "requests", "many-to-many")
    return replace(
        pack,
        catalog=replace(pack.catalog, relationships=(replace(spec, child="source"),)),
        actors=replace(pack.actors, group_access=grants),
        links=replace(
            pack.links,
            parent_indices=lambda _pack, _key, child, counts: (child % counts["requests"],),
        ),
        history=replace(pack.history, status_paths={}, target_share=0.0),
        blueprint=replace(pack.blueprint, record_created_trigger_keys=()),
        rejections=replace(pack.rejections, activity_cases=()),
    )


def _dataset(**options):
    return build_dataset(
        "small",
        seed=17,
        anchor_date=ANCHOR,
        organization=_pack(**options),
        module_counts_override=COUNTS,
    )


def test_source_child_edges_link_each_source_to_its_parent_target():
    dataset = _dataset()
    pairs = [(edge.source_record_id, edge.target_record_id) for edge in dataset.edges]
    assert pairs == [
        (f"updates:{index + 1:06d}", f"requests:{index % 4 + 1:06d}") for index in range(9)
    ]
    parents = record_parents(dataset)
    for source, target in pairs:
        assert target in parents[source]
        assert source not in parents[target]


def test_source_child_is_linked_by_its_creator_right_after_it_is_created():
    dataset = _dataset()
    assert {edge.creator_key for edge in dataset.edges} == {CLERK}
    created: set[str] = set()
    for session in plan_sessions(dataset):
        assert session.kind == "create"
        for logical_id in session.record_ids:
            assert set(record_parents(dataset)[logical_id]) <= created
        created.update(session.record_ids)
    assert created == {record.logical_id for record in dataset.records}


def test_a_source_child_link_waits_for_a_writer_who_reads_the_target():
    dataset = _dataset(clerk_reads_requests=False)
    creators = {record.logical_id: record.creator_key for record in dataset.records}
    assert {edge.creator_key for edge in dataset.edges} == {LEAD}
    deferred = {
        index
        for index, edge in enumerate(dataset.edges)
        if creators[edge.source_record_id] == CLERK
    }
    assert deferred and len(deferred) < len(dataset.edges)
    created: set[str] = set()
    linked: set[int] = set()
    for session in plan_sessions(dataset):
        if session.kind == "create":
            created.update(session.record_ids)
            continue
        assert session.kind == "link"
        assert (session.creator_key, session.module_key) == (LEAD, "updates")
        for index in session.edge_indices:
            edge = dataset.edges[index]
            assert {edge.source_record_id, edge.target_record_id} <= created
            linked.add(index)
    assert linked == deferred


def _id(key: str) -> str:
    return str(uuid5(NAMESPACE_URL, "child-source:" + key))


def test_activity_links_a_source_child_after_both_records_exist(tmp_path):
    dataset = _dataset(clerk_reads_requests=False)
    queues = {
        dataset.module_ids[key]: [record for record in dataset.records if record.module_key == key]
        for key in dataset.module_counts
    }
    stored: dict[str, str] = {}
    links: list[tuple[str, dict[str, str]]] = []

    def handler(actor: str):
        def request(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/auth/login":
                return httpx.Response(
                    200,
                    json={"authenticated": True},
                    headers=[
                        ("set-cookie", "openslate_access=opaque; Path=/"),
                        ("set-cookie", "openslate_csrf=csrf; Path=/"),
                    ],
                )
            body = json.loads(request.content)
            if request.url.path == "/api/records":
                record = queues[body["module_id"]].pop(0)
                stored[record.logical_id] = _id(record.logical_id)
                return httpx.Response(201, json={"id": stored[record.logical_id], **body})
            assert request.url.path == "/api/relationships"
            assert {body["source_record_id"], body["target_record_id"]} <= set(stored.values())
            links.append((actor, body))
            return httpx.Response(201, json={"id": _id(f"edge:{len(links)}"), **body})

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
                "update_request": {"id": _id("field"), "relationship_multiple_targets": True}
            },
            actor_ids={actor: _id(actor) for actor in clients},
            clients=clients,
        )
    assert result.edge_count == len(links) == 9
    assert {actor for actor, _body in links} == {LEAD}
    assert [(body["source_record_id"], body["target_record_id"]) for _actor, body in links] == [
        (stored[edge.source_record_id], stored[edge.target_record_id]) for edge in dataset.edges
    ]
