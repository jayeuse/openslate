"""Existing message APIs prove default-off projection; no remote fixture or fabricated journal."""

from typing import Any
from uuid import uuid4

import httpx

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _request,
    _result,
)


def plan_preview_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = next(
        person.key
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active"
    )
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-preview-default",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:preview-default",
            values={
                "operation": "link_preview_default_off"
                if org == "primary"
                else "partner_link_preview_default_off",
                "organization": org,
                "member_key": member,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"default_off_verified": True},
        )
        for org in ("primary", "partner")
    )


def execute_preview_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_preview_controls(dataset):
        raise SamplePhaseActionError("Unsupported preview operation", step=action.key)
    member = str(action.values["member_key"])
    if action.values["organization"] == "partner":
        admin_factory, actor_factory = (
            context.private_values.get(key) for key in ("partner_admin", "partner_actor")
        )
        if not callable(admin_factory) or not callable(actor_factory):
            raise SamplePhaseActionError("Partner clients are unavailable", step=action.key)
        admin, peer = admin_factory(), actor_factory(member)
        check(
            admin.organization_id == peer.organization_id
            and admin.organization_id != context.clients["admin"].organization_id,
            "partner_org",
        )
        context = bound_context(context, {**context.clients, "admin": admin, member: peer})
    org = _id(
        {"org": context.clients["admin"].organization_id}, "org", label="org", step=action.key
    )
    _id(context.user_ids, member, label="member", step=action.key)
    evidence: list[dict[str, object]] = []

    def call(
        method: str, path: str, step: str, expected: int = 200, actor: str = "admin", **kwargs: Any
    ) -> httpx.Response:
        return _request(
            action,
            context,
            evidence,
            actor_key=actor,
            method=method,
            path=path,
            step=step,
            expected=expected,
            on_substep=on_substep,
            **kwargs,
        )

    room = call(
        "POST",
        "/api/comms/conversations",
        "owned_preview_channel",
        201,
        json_body={
            "name": "Owned default-off preview",
            "scope": "organization",
            "position": 0,
            "topic": "",
            "category_id": None,
        },
    ).json()
    settings = call("GET", "/api/comms/settings/channel/" + room["id"], "preview_default").json()
    check(settings["effective"]["link_previews"] is False, "default_off_required")
    root = "/api/comms/conversations/" + room["id"] + "/messages"
    source = call(
        "POST",
        root,
        "default_off_send",
        201,
        actor=member,
        json_body={
            "client_key": str(uuid4()),
            "body": "https://preview.example.com/default-off",
        },
    ).json()
    retained = call("GET", root + "/" + source["id"], "default_off_read", actor=member).json()
    check(
        retained["id"] == source["id"] and retained["link_previews"] == [], "no_preview_projection"
    )
    return _result(
        action,
        context,
        evidence,
        [],
        extra={
            "organization_id": org,
            "conversation_id": room["id"],
            "message_id": source["id"],
            "default_off_verified": True,
        },
    )
