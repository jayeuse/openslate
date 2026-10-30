"""Pack-derived read journeys for the additional UI control lane."""

from __future__ import annotations

import weakref
from collections.abc import Mapping

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.account import plan_account_controls
from operations.sample.episodes import plan_sessions
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _request,
    _request_object,
    _result,
)
from operations.sample.phases.plan import plan_phases

CONTROL_ROUTES = frozenset(
    {
        ("GET", "/api/users/{user_id}/sessions"),
        ("DELETE", "/api/users/{user_id}/sessions"),
    }
)


# The MFA, people-security and notification planners and plan_controls each ask for this
# target to keep it out of their own, and finding it replans every session. A dataset is
# frozen and a changed one is a new instance (dataclasses.replace or a deep copy), so the
# last answer is reused only for that same live instance.
_last_session_target: tuple[weakref.ref[SampleDataset], str] | None = None


def _session_target(dataset: SampleDataset) -> str:
    global _last_session_target
    last = _last_session_target
    if last is not None and last[0]() is dataset:
        return last[1]
    people = {person.key: person for person in dataset.organization.actors.people}
    phase_keys = {
        key
        for action in plan_phases(dataset)
        for key in (action.actor_key, action.target_key)
        if key in people
    }
    first_account_actor = plan_account_controls(dataset)[0].actor_key
    from operations.sample.controls.comms_structure import plan_structure_controls

    # These members join the partner organization; a pack administrator may not end the
    # sessions of an account that belongs to a second organization.
    from operations.sample.controls.comms_structure_common import member_keys

    shared = {key for action in plan_structure_controls(dataset) for key in member_keys(action)}
    completed_work = {session.creator_key for session in plan_sessions(dataset)}
    candidates = sorted(
        key
        for key, person in people.items()
        if person.role == "member"
        and person.status == "active"
        and key in completed_work
        and key != first_account_actor
        and key not in phase_keys
        and key not in shared
    )
    if not candidates:
        raise ValueError("Read controls require a separate active member with completed work")
    _last_session_target = (weakref.ref(dataset), candidates[0])
    return candidates[0]


def plan_read_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Plan the final bulk session revocation against a completed-work pack member."""
    pack = dataset.organization
    if pack.phases is None:
        return ()
    return (
        PhaseAction(
            key="control:revoke-user-sessions",
            phase="reorganization",
            kind="read_controls",
            actor_key="admin",
            target_key=_session_target(dataset),
            values={"operation": "revoke_user_sessions"},
            expected_status=204,
            expected_detail=None,
            expected_end_state={"sessions_revoked": True},
        ),
    )


def _session_ids(page: Mapping[str, object], *, step: str) -> tuple[str, ...]:
    rows = page.get("items")
    pagination = page.get("pagination")
    if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
        raise SamplePhaseActionError("User session readback is invalid", step=step)
    if not isinstance(pagination, Mapping):
        raise SamplePhaseActionError("User session pagination is invalid", step=step)
    count, total, limit, offset = (
        pagination.get("count"),
        pagination.get("total"),
        pagination.get("limit"),
        pagination.get("offset"),
    )
    if (
        type(count) is not int
        or type(total) is not int
        or type(limit) is not int
        or type(offset) is not int
        or count != len(rows)
        or total < count
        or limit != 100
        or offset != 0
        or total != count
    ):
        raise SamplePhaseActionError("User session readback is incomplete or ambiguous", step=step)
    ids = tuple(
        _id(row, "id", label="session", step=step) for row in rows if isinstance(row, Mapping)
    )
    if len(set(ids)) != len(ids):
        raise SamplePhaseActionError("User session readback is ambiguous", step=step)
    return ids


def execute_read_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    """Revoke all active sessions for the planned member and verify an empty list."""
    if action not in plan_read_controls(dataset) or action.values.get("operation") != (
        "revoke_user_sessions"
    ):
        raise SamplePhaseActionError(
            "Session control differs from the pack-derived plan", step="session_plan"
        )
    target_id = _id(
        context.user_ids, action.target_key, label="session target", step="session_target"
    )
    admin_id = _id(context.user_ids, action.actor_key, label="administrator", step="session_target")
    mapped_targets = [key for key, value in context.user_ids.items() if value == target_id]
    if (
        action.target_key == "admin"
        or target_id == admin_id
        or mapped_targets != [action.target_key]
    ):
        raise SamplePhaseActionError(
            "Planned session target mapping is ambiguous", step="session_target"
        )
    target = next(
        (
            person
            for person in dataset.organization.actors.people
            if person.key == action.target_key
        ),
        None,
    )
    if target is None or target.role != "member" or target.status != "active":
        raise SamplePhaseActionError(
            "Planned session target is not an active member", step="session_target"
        )

    path = f"/api/users/{target_id}/sessions"
    before = _request_object(
        action,
        context,
        [],
        actor_key=action.actor_key,
        path=path,
        step="list_user_sessions_before",
        params={"limit": 100, "offset": 0},
        on_substep=on_substep,
    )
    existing = _session_ids(before, step="list_user_sessions_before")
    if not existing:
        raise SamplePhaseActionError(
            "Planned user has no active sessions to revoke", step="list_user_sessions_before"
        )

    evidence: list[dict[str, object]] = []
    _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="DELETE",
        path=path,
        step="revoke_user_sessions",
        expected=204,
        on_substep=on_substep,
    )
    after = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path=path,
        step="list_user_sessions_after",
        params={"limit": 100, "offset": 0},
        on_substep=on_substep,
    )
    if _session_ids(after, step="list_user_sessions_after"):
        raise SamplePhaseActionError(
            "Active user sessions remain after revocation", step="list_user_sessions_after"
        )
    return _result(
        action,
        context,
        evidence,
        [],
        extra={"read_checks": 2, "sessions_revoked": True},
    )
