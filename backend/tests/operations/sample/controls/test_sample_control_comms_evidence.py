"""Comms control evidence proves each declared actor and each planned refusal (F12)."""

from datetime import date
from uuid import uuid4

import pytest

from operations.sample.controls.actions import plan_controls
from operations.sample.controls.request_verification import verify_request_evidence
from operations.sample.packs.registry import get_pack
from operations.sample.scenario import build_dataset

ADMIN = str(uuid4())
EXPORTS = "/api/comms/exports"
SCHEDULES = "/api/comms/scheduled-messages"


def _setup():
    dataset = build_dataset("small", 42, date(2026, 9, 30), organization=get_pack("school"))
    action = next(a for a in plan_controls(dataset) if a.key == "control:comms:primary-jobs")
    member = action.values["member_key"]
    outsider = next(
        p.key for p in dataset.organization.actors.people if p.key != member and p.role == "member"
    )
    actors = {member: str(uuid4()), outsider: str(uuid4())}
    return dataset, action, member, outsider, actors


def _row(step, actor_key, actor_id, path, expected, status):
    return {
        "step": step,
        "actor_key": actor_key,
        "actor_id": actor_id,
        "method": "POST",
        "path": path,
        "expected_status": expected,
        "status_code": status,
        "request_id": str(uuid4()),
    }


def _verify(dataset, action, actors, rows):
    issues: list[str] = []
    observed = {"control_requests_verified": 0}
    verify_request_evidence(
        dataset,
        {"actor_ids": actors},
        action,
        {"request_evidence": rows},
        actors,
        ADMIN,
        set(),
        observed,
        issues,
    )
    return issues, observed


def _journey(member, actors):
    return [
        _row("schedule", member, actors[member], SCHEDULES, 201, 201),
        _row("member_export_denied", member, actors[member], EXPORTS, 403, 403),
        _row("export:csv", "admin", ADMIN, EXPORTS, 201, 201),
    ]


def test_comms_evidence_accepts_the_declared_member_and_planned_refusal() -> None:
    # Comms controls act as members and record planned 403s; the generic check
    # accepted only the admin and 2xx, so every live run failed verification.
    dataset, action, member, _, actors = _setup()

    issues, observed = _verify(dataset, action, actors, _journey(member, actors))

    assert issues == []
    assert observed["control_requests_verified"] == 3


@pytest.mark.parametrize(
    "fault,issue",
    [
        ("member_id", "actor differs"),
        ("outsider", "actor differs"),
        ("undeclared_refusal", "status is invalid"),
        ("refusal_server_error", "status is invalid"),
        ("refusal_succeeded", "status is invalid"),
    ],
)
def test_comms_evidence_still_rejects_wrong_actors_and_unplanned_refusals(fault, issue) -> None:
    dataset, action, member, outsider, actors = _setup()
    rows = _journey(member, actors)
    if fault == "member_id":
        rows[0]["actor_id"] = actors[outsider]
    elif fault == "outsider":
        rows[0].update(actor_key=outsider, actor_id=actors[outsider])
    elif fault == "undeclared_refusal":
        rows[0].update(expected_status=403, status_code=403)
    elif fault == "refusal_server_error":
        rows[1].update(expected_status=500, status_code=500)
    else:
        rows[1]["status_code"] = 201

    issues, _ = _verify(dataset, action, actors, rows)

    assert any(issue in text for text in issues)
