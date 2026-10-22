"""Bounded direct-candidate API evidence in each organization, never a user-directory shortcut."""

from typing import Any

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


def plan_candidate_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = next(
        person.key
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active"
    )
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-candidates",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:candidates-disposable",
            values={
                "operation": "direct_candidates"
                if org == "primary"
                else "partner_direct_candidates",
                "organization": org,
                "member_key": member,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"candidates_verified": True},
        )
        for org in ("primary", "partner")
    )


def execute_candidate_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_candidate_controls(dataset):
        raise SamplePhaseActionError("Unsupported candidate operation", step=action.key)
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
        {"org": context.clients["admin"].organization_id},
        "org",
        label="organization",
        step=action.key,
    )
    person = _id(context.user_ids, member, label="member", step=action.key)
    administrator = _id(context.user_ids, "admin", label="admin", step=action.key)
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

    created = call(
        "POST",
        "/api/comms/conversations",
        "create_owned_sharing",
        201,
        json_body={
            "name": "Owned candidate check",
            "scope": "organization",
            "position": 0,
            "topic": "",
            "category_id": None,
        },
    ).json()
    check(created["org_id"] == org, "bound_org")
    root = "/api/comms/conversations/" + created["id"]
    card = call("GET", f"/api/users/{administrator}/card", "known_person_name", actor=member).json()
    name = card["display_name"]
    check(isinstance(name, str) and bool(name.strip()), "named_fixture")
    query = {"q": name[:100], "limit": 20}
    settings = call("GET", "/api/comms/settings/workspace", "current_direct_rule").json()
    enabled = settings["dm_rule"] != "none"

    def candidates(step: str, admitted: bool) -> None:
        response = call("GET", "/api/comms/direct-candidates", step, actor=member, params=query)
        body = response.json()
        check(set(body) == {"items"} and len(body["items"]) <= 20, "bounded_items")
        ids = [item["user_id"] for item in body["items"]]
        check(len(ids) == len(set(ids)) and person not in ids, "distinct_others")
        check((administrator in ids) == admitted, "current_admission")
        check(
            all(set(item) == {"user_id", "display_name", "avatar_url"} for item in body["items"]),
            "public_dto_only",
        )
        check("no-store" in response.headers.get("Cache-Control", ""), "no_store")

    candidates("initial_candidates", enabled)
    for actor, target in ((member, administrator), ("admin", person)):
        call(
            "POST",
            "/api/comms/direct-blocks",
            "block:" + actor,
            204,
            actor=actor,
            json_body={"blocked_user_id": target},
        )
        candidates("blocked_candidates:" + actor, False)
        call("DELETE", "/api/comms/direct-blocks/" + target, "unblock:" + actor, 204, actor=actor)
        candidates("restored_candidates:" + actor, enabled)
    current = call("GET", root, "before_archive")
    call("POST", root + "/archive", "archive", headers={"If-Match": current.headers["ETag"]})
    preview = call("POST", root + "/purge/preview", "purge_preview").json()
    call(
        "POST",
        root + "/purge",
        "purge",
        json_body={
            "token": preview["token"],
            "confirmation_name": preview["confirmation_name"],
            "password": context.admin_password,
        },
    )
    call("GET", root, "room_gone", 404)
    return _result(
        action,
        context,
        evidence,
        [],
        extra={
            "organization_id": org,
            "candidates_verified": True,
        },
    )
