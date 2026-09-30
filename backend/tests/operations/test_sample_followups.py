"""A flagged follow-up starts after the human history that triggers it."""

from dataclasses import replace
from datetime import date

import pytest

from operations.sample_activity import create_data
from operations.sample_episodes import plan_sessions
from operations.sample_history import plan_history
from operations.sample_packs.interface import PackLinks
from operations.sample_packs.types import FieldSpec
from operations.sample_scenario import build_dataset
from tests.operations.test_sample_packs import _TINY_PACK, _tiny_value


def _counter_pack():
    requests, updates = _TINY_PACK.catalog.modules
    requests = replace(
        requests,
        fields=(
            *requests.fields,
            FieldSpec("counter", "Consecutive days absent", "Integer", "counter", minimum=0),
        ),
    )

    def value(pack, module, field, index, seed, anchor, counts):
        return (
            5
            if field.key == "counter"
            else _tiny_value(pack, module, field, index, seed, anchor, counts)
        )

    return replace(
        _TINY_PACK,
        catalog=replace(_TINY_PACK.catalog, modules=(requests, updates)),
        generators=replace(_TINY_PACK.generators, field_value=value),
        history=replace(
            _TINY_PACK.history,
            field_paths={
                "requests:000001": {"counter": (3, 5)},
            },
        ),
        links=replace(
            _TINY_PACK.links,
            after_history={
                "updates:000001": ("requests:000001",),
            },
        ),
    )


def test_counter_history_starts_below_the_threshold_and_crosses_it_once():
    dataset = build_dataset("small", 17, date(2026, 9, 30), organization=_counter_pack())
    histories = plan_history(dataset)
    record = next(record for record in dataset.records if record.logical_id == "requests:000001")
    data = create_data(dataset, record, histories[record.logical_id])
    assert data[dataset.field_ids["requests"]["counter"]] == 3
    assert [
        getattr(step, "values", {}).get("counter")
        for step in histories[record.logical_id].steps
        if "counter" in getattr(step, "values", {})
    ] == [5]


def test_followup_creation_waits_for_the_parents_complete_history():
    dataset = build_dataset("small", 17, date(2026, 9, 30), organization=_counter_pack())
    sessions = plan_sessions(dataset)
    parent_updates = [
        position
        for position, session in enumerate(sessions)
        if any(logical == "requests:000001" for logical, _ in session.steps)
    ]
    child = next(
        position
        for position, session in enumerate(sessions)
        if "updates:000001" in session.record_ids
    )
    assert parent_updates
    assert max(parent_updates) < child


@pytest.mark.parametrize("event_stage", ("history", "creation"))
@pytest.mark.parametrize("delivers_flag", (True, False))
def test_a_followup_waits_for_the_flag_and_stops_if_it_does_not_arrive(
    tmp_path, monkeypatch, event_stage, delivers_flag
):
    import json
    from uuid import uuid4

    import httpx
    import pytest

    from operations import sample_activity
    from operations.sample_client import SampleClient
    from operations.sample_population import SamplePopulationError

    pack = _counter_pack()
    pack = replace(
        pack,
        history=replace(
            pack.history,
            field_paths={
                "requests:000001": {"counter": (3, 5), "flag": (False,)},
            },
        ),
        blueprint=replace(pack.blueprint, record_created_trigger_keys=()),
        rejections=replace(pack.rejections, activity_cases=()),
    )
    if event_stage == "creation":
        pack = replace(
            pack,
            history=replace(
                pack.history,
                field_paths={
                    "requests:000001": {"flag": (False,)},
                },
            ),
            links=PackLinks(
                pack.links.reference_fields,
                pack.links.parent_indices,
                pack.links.reference_parents,
                after_flags={"updates:000001": ("requests:000001",)},
            ),
        )
    dataset = build_dataset("small", 17, date(2026, 9, 30), organization=pack)
    counter, flag = (dataset.field_ids["requests"][key] for key in ("counter", "flag"))
    rows = {}
    parent_id = None
    polls = 0
    followups = []
    monkeypatch.setattr(sample_activity, "_RULE_WAIT_SECONDS", 0.0 if not delivers_flag else 1.0)
    monkeypatch.setattr(sample_activity.time, "sleep", lambda _seconds: None)

    def handler(request):
        nonlocal parent_id, polls
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, json={}, headers={"set-cookie": "openslate_csrf=c; Path=/"})
        body = json.loads(request.content) if request.content else {}
        if request.method == "POST" and request.url.path == "/api/records":
            if body["module_id"] == dataset.module_ids["updates"]:
                assert parent_id and rows[parent_id]["data"][flag] is True
                followups.append(body)
            record_id = str(uuid4())
            rows[record_id] = {"id": record_id, **body}
            if parent_id is None:
                parent_id = record_id
            return httpx.Response(201, json=rows[record_id])
        if request.url.path.startswith("/api/records/"):
            record_id = request.url.path.rsplit("/", 1)[1]
            if request.method == "PATCH":
                rows[record_id]["data"] = body["data"]
            elif record_id == parent_id and rows[record_id]["data"][counter] == 5:
                polls += 1
                if delivers_flag and polls >= 2:
                    rows[record_id]["data"][flag] = True
            return httpx.Response(200, json=rows[record_id])
        return httpx.Response(201, json={"id": str(uuid4())})

    with SampleClient(
        "https://api.example.test",
        "https://ui.example.test",
        tmp_path / f"requests-{delivers_flag}.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("person@northside.example", "fixture-value")
        kwargs = {
            "modules": {key: {"id": value} for key, value in dataset.module_ids.items()},
            "field_ids": {
                key: {value: value for value in fields.values()}
                for key, fields in dataset.field_ids.items()
            },
            "relationship_fields": {
                "request_updates": {
                    "id": dataset.relationship_ids["request_updates"],
                    "relationship_multiple_targets": True,
                }
            },
            "actor_ids": {"internal_ops_lead": str(uuid4())},
            "clients": {"internal_ops_lead": client},
        }
        if delivers_flag:
            sample_activity.run_activity(dataset, plan_sessions(dataset), **kwargs)
            assert followups
            assert polls >= 2
        else:
            with pytest.raises(SamplePopulationError, match="automation"):
                sample_activity.run_activity(dataset, plan_sessions(dataset), **kwargs)
            assert not followups
