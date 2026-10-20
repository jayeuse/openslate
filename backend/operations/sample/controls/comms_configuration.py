"""Real primary/partner template, audit-history and managed-admission journeys."""

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


def plan_configuration_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = next(
        person.key
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active"
    )
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-configuration",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:configuration-disposable",
            values={
                "operation": "configuration_roundtrip"
                if org == "primary"
                else "partner_configuration_roundtrip",
                "organization": org,
                "member_key": member,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"configuration_verified": True},
        )
        for org in ("primary", "partner")
    )


def execute_configuration_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_configuration_controls(dataset):
        raise SamplePhaseActionError("Unsupported configuration operation", step=action.key)
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
    person = _id(context.user_ids, member, label="member", step=action.key)
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

    category = call(
        "POST",
        "/api/comms/categories",
        "owned_category",
        201,
        json_body={
            "name": "Owned configuration category",
            "position": 0,
            "department_id": None,
            "default_access": [],
        },
    ).json()
    rooms = [
        call(
            "POST",
            "/api/comms/conversations",
            f"owned_channel:{index}",
            201,
            json_body={
                "name": f"Owned configuration {index}",
                "scope": "members",
                "member_ids": [],
                "position": index,
                "topic": "",
                "category_id": category["id"],
            },
        ).json()
        for index in range(2)
    ]
    templates = "/api/comms/templates"
    document = {
        "name": "Owned configuration template",
        "description": "Actual validated JSON",
        "settings": {"allow_export": False},
        "capabilities": {"everyone": {"react": False}, "group_grants": []},
    }
    call("POST", templates, "member_template_denied", 403, actor=member, json_body=document)
    template = call("POST", templates, "create_template", 201, json_body=document)
    target = templates + "/" + template.json()["id"]
    check(template.json()["org_id"] == org, "template_org")
    single = call("GET", target, "read_template")
    saved = call(
        "PUT",
        target,
        "save_template",
        json_body={**document, "description": "Saved source"},
        headers={"If-Match": single.headers["ETag"]},
    )
    check(saved.json()["description"] == "Saved source", "saved_source")
    page = call(
        "GET", templates, "list_templates", params={"sort_order": "desc", "limit": 100}
    ).json()
    check(any(row["id"] == template.json()["id"] for row in page["items"]), "listed_source")
    selection = {
        "conversation_ids": [room["id"] for room in rooms],
        "keys": ["allow_export"],
        "capability_keys": ["react"],
    }
    preview = call("POST", target + "/application-preview", "template_preview", json_body=selection)
    check(len(preview.json()["items"]) == 2, "complete_preview")
    applied = call(
        "POST",
        target + "/applications",
        "template_apply",
        json_body=selection,
        headers={"If-Match": preview.headers["ETag"]},
    ).json()
    for item in applied["items"]:
        settings = call(
            "GET",
            "/api/comms/settings/channel/" + item["conversation_id"],
            "applied_settings:" + item["conversation_id"],
        ).json()
        if "allow_export" in item["applied_keys"]:
            check(settings["overrides"]["allow_export"] is False, "persisted_setting")
        else:
            check("allow_export" in item["skipped_locked_keys"], "truthful_setting_skip")
        capabilities = call(
            "GET",
            "/api/comms/settings/channel/" + item["conversation_id"] + "/capabilities",
            "applied_capabilities:" + item["conversation_id"],
        ).json()
        if "react" in item.get("applied_capabilities", []):
            check(capabilities["everyone"]["react"] is False, "persisted_capability")
        else:
            check("react" in item["skipped_locked_capabilities"], "truthful_capability_skip")

    scopes = (
        ("workspace", "/api/comms/settings/workspace"),
        ("category", "/api/comms/settings/category/" + category["id"]),
        ("channel", "/api/comms/settings/channel/" + rooms[0]["id"]),
    )
    for kind, settings_path in scopes:
        original_history = call(
            "GET",
            settings_path + "/history",
            "history_before:" + kind,
            params={"sort_order": "desc", "limit": 100},
        ).json()
        known = {row["id"] for row in original_history["items"]}
        current = call("GET", settings_path, "settings_before:" + kind)
        if kind != "workspace":
            check(
                "notification_sound" not in current.json()["locked_keys"],
                "owned_history_fixture_unlocked",
            )
        changed = call(
            "PATCH",
            settings_path,
            "history_change:" + kind,
            json_body={"notification_sound": not current.json()["effective"]["notification_sound"]},
            headers={"If-Match": current.headers["ETag"]},
        )
        history = call(
            "GET",
            settings_path + "/history",
            "history_after:" + kind,
            params={"sort_order": "desc", "limit": 100},
        ).json()
        new = [row for row in history["items"] if row["id"] not in known]
        check(len(new) == 1, "one_configuration_change")
        entry = call(
            "GET", settings_path + "/history/" + new[0]["id"], "history_detail:" + kind
        ).json()
        check(entry["org_id"] == org and entry["scope"]["kind"] == kind, "captured_scope")
        request = {"history_id": entry["id"], "password": context.admin_password}
        restore_preview = call(
            "POST",
            settings_path + "/restoration-preview",
            "restore_preview:" + kind,
            json_body=request,
            headers={"If-Match": changed.headers["ETag"]},
        )
        check(restore_preview.json()["after"] == entry["before"], "protected_prior_snapshot")
        restored = call(
            "POST",
            settings_path + "/restoration",
            "restore:" + kind,
            json_body={**request, "preview_digest": restore_preview.json()["preview_digest"]},
            headers={"If-Match": restore_preview.headers["ETag"]},
        ).json()
        check(restored == entry["before"], "restored_complete_snapshot")
    call("GET", "/api/comms/settings/workspace/history", "member_history_denied", 403, actor=member)

    for index, kind in enumerate(("request", "invitation")):
        root = "/api/comms/conversations/" + rooms[index]["id"]
        settings_path = "/api/comms/settings/channel/" + rooms[index]["id"]
        current = call("GET", settings_path, "admission_policy:" + kind)
        call(
            "PATCH",
            settings_path,
            "set_admission_policy:" + kind,
            json_body={"join_rule": "request" if kind == "request" else "invite"},
            headers={"If-Match": current.headers["ETag"]},
        )
        call("GET", root, "private_before_admission:" + kind, 404, actor=member)
        if kind == "request":
            for suffix, identity in (("unknown", str(uuid4())), ("known", rooms[index]["id"])):
                check(
                    call(
                        "POST",
                        "/api/comms/join-requests",
                        "join_request:" + suffix,
                        204,
                        actor=member,
                        json_body={"conversation_id": identity},
                    ).content
                    == b"",
                    "neutral_ack",
                )
        else:
            call("POST", root + "/invitations", "invite", 201, json_body={"user_id": person})
        admissions = call("GET", root + "/admissions", "admission_list:" + kind).json()["items"]
        check(len(admissions) == 1 and admissions[0]["kind"] == kind, "pending_admission")
        item_path = root + "/admissions/" + admissions[0]["id"]
        item = call("GET", item_path, "admission_detail:" + kind)
        accepted = call(
            "POST",
            item_path + "/decision",
            "admission_accept:" + kind,
            json_body={"decision": "accept"},
            headers={"If-Match": item.headers["ETag"]},
        ).json()
        check(
            accepted["status"] == "accepted" and accepted["resolved_at"] is not None,
            "resolved_admission",
        )
        call("GET", root, "new_member_reads:" + kind, actor=member)
        current = call("GET", root, "before_archive:" + kind)
        call(
            "POST",
            root + "/archive",
            "archive:" + kind,
            headers={"If-Match": current.headers["ETag"]},
        )
        impact = call("POST", root + "/purge/preview", "purge_preview:" + kind).json()
        call(
            "POST",
            root + "/purge",
            "purge:" + kind,
            json_body={
                "token": impact["token"],
                "confirmation_name": impact["confirmation_name"],
                "password": context.admin_password,
            },
        )
        call("GET", root, "owned_room_gone:" + kind, 404)
    return _result(
        action,
        context,
        evidence,
        [],
        extra={"organization_id": org, "configuration_verified": True},
    )
