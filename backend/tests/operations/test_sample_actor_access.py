"""Offline actor plans must honour each module's grants and account state."""

from dataclasses import replace
from datetime import date

import pytest

from operations.sample.actors import assignee_key, creator_keys
from operations.sample.episodes import plan_sessions
from operations.sample.history import plan_history
from operations.sample.packs.types import PersonSpec
from operations.sample.scenario import build_dataset
from tests.operations.test_sample_packs import _TINY_PACK


def _restricted_pack():
    lead = replace(_TINY_PACK.actors.people[0], groups=("lead-grants",))
    clerk = PersonSpec(
        "internal_ops_02",
        "taylor.reed@northside.example",
        "taylor_reed",
        "Taylor Reed",
        "Operations Clerk",
        "member",
        "active",
        ("clerk-grants",),
    )
    guest = replace(_TINY_PACK.actors.people[1], groups=("guest-managers",))
    disabled = replace(clerk, key="internal_ops_03", status="disabled")
    actors = replace(
        _TINY_PACK.actors,
        team_keys={"ops": (lead.key, clerk.key, guest.key, disabled.key)},
        people=(lead, clerk, guest, disabled),
        group_access={
            "lead-grants": (("ops", None, "manage"), ("ops", "updates", "read")),
            "clerk-grants": (("ops", None, "read"), ("ops", "updates", "write")),
            "guest-managers": (("ops", None, "manage"),),
        },
    )
    return replace(_TINY_PACK, actors=actors)


@pytest.mark.parametrize(
    "module,writer", [("requests", "internal_ops_lead"), ("updates", "internal_ops_02")]
)
def test_creators_and_assignees_use_only_active_internal_module_writers(module, writer):
    pack = _restricted_pack()
    assert set(creator_keys(module, "ops", 60, 17, pack)) == {writer}
    assert {assignee_key(module, "ops", index, 17, pack) for index in range(60)} == {writer}


def test_histories_use_the_same_module_write_boundary():
    dataset = build_dataset("small", 17, date(2026, 9, 30), organization=_restricted_pack())
    histories = plan_history(dataset)
    assert histories
    for logical_id, history in histories.items():
        writer = "internal_ops_lead" if logical_id.startswith("requests:") else "internal_ops_02"
        assert {step.updater_key for step in history.steps} == {writer}
        assert history.initial_assignee in {None, writer}


def test_a_module_without_an_eligible_writer_stops_planning():
    pack = _restricted_pack()
    pack = replace(pack, actors=replace(pack.actors, group_access={}))
    with pytest.raises(ValueError, match="active.*writer"):
        creator_keys("requests", "ops", 5, 17, pack)


def test_one_module_writer_still_works_in_short_interleaved_sessions():
    dataset = build_dataset(
        "small",
        17,
        date(2026, 9, 30),
        organization=_restricted_pack(),
        module_counts_override={"requests": 17, "updates": 3},
    )
    sessions = [
        session
        for session in plan_sessions(dataset)
        if session.kind == "create" and session.module_key == "requests"
    ]
    assert all(2 <= len(session.record_ids) <= 6 for session in sessions)
    assert sum(len(session.record_ids) for session in sessions) == 17
    assert {session.creator_key for session in sessions} == {"internal_ops_lead"}
