"""D21 structure planner, API-only primary executor and current-state verification."""

from collections.abc import Mapping
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.comms_structure_common import StructureRun, check, member_keys
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _read_json,
    _result,
)

ROOT = "/api/comms"
PRIMARY_STEPS = (
    "create_category",
    "update_category",
    "create_messages",
    "create_access",
    "set_access",
    "move_channel",
    "archive",
    "restore",
    "set_role",
    "remove_member",
    "duplicate",
    "create_direct",
    "find_direct",
    "create_group",
    "block",
    "unblock",
)


def plan_structure_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    members = [
        person.key
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active"
    ][:2]
    if len(members) != 2:
        raise ValueError("Comms sample requires two active member actors")
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-structure",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:messages",
            values={
                "operation": operation,
                "organization": org,
                "member_keys": [*members],
                "category_name": f"{dataset.organization.identity.workspace_name} Comms",
                "channel_name": "Team conversation",
                "group_name": "Coordination",
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "structure_verified" if org == "primary" else "partner_members_verified": True
            },
        )
        for org, operation in (
            ("primary", "structure_roundtrip"),
            ("partner", "partner_conversations"),
        )
    )


def execute_structure_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_structure_controls(dataset):
        raise SamplePhaseActionError("Unsupported structure operation", step=action.key)
    if action.values["operation"] == "partner_conversations":
        from operations.sample.controls.comms_partner import execute_partner

        return execute_partner(action, dataset, context, on_substep=on_substep)
    run = StructureRun(action, context, on_substep)
    people = [
        _id(context.user_ids, key, label="member", step=action.key) for key in member_keys(action)
    ]
    prefix = "primary:comms:"
    category_body = {
        "name": action.values["category_name"],
        "position": 0,
        "department_id": None,
        "default_access": [],
    }
    category = run.create(
        ROOT + "/categories", "category", prefix + "category", category_body, "create_category"
    )
    category_path = ROOT + "/categories/" + category["id"]
    _, tag = run.get(category_path, "category")
    changed_category = {**category_body, "position": 1}
    run.resource(
        run.call(
            "PUT",
            category_path,
            "update_category",
            headers={"If-Match": tag},
            json_body=changed_category,
            primary_entity_type="comms_categories",
            primary_entity_id=category["id"],
            primary_action="update",
            expected_audit_rows=1,
        ),
        "category",
        "update_category",
    )
    check(run.get(category_path, "category")[0]["position"] == 1, "category_readback")
    check(
        any(
            row["id"] == category["id"]
            for row in run.page(
                ROOT + "/categories", "category", params={"search": category_body["name"]}
            )
        ),
        "category_list",
    )
    common = {
        "name": action.values["channel_name"],
        "topic": "",
        "category_id": category["id"],
        "position": 0,
    }
    messages = run.create(
        ROOT + "/conversations",
        "conversation",
        prefix + "messages",
        {**common, "scope": "members", "member_ids": people},
        "create_messages",
    )
    path = ROOT + "/conversations/" + messages["id"]
    access_channel = run.create(
        ROOT + "/conversations",
        "conversation",
        prefix + "access",
        {**common, "name": "Shared announcements", "scope": "groups", "access": []},
        "create_access",
    )
    access_path = ROOT + "/conversations/" + access_channel["id"]
    _, tag = run.get(access_path)
    access = [{"subject": "everyone", "level": "read"}]
    run.resource(
        run.call(
            "PUT",
            access_path + "/access",
            "set_access",
            headers={"If-Match": tag},
            json_body={"access": access},
            primary_entity_type="comms_conversations",
            primary_entity_id=access_channel["id"],
            primary_action="update",
            expected_audit_rows=1,
            related_entity_types=("comms_conversation_groups",),
        ),
        "conversation",
        "set_access",
    )
    check(run.get(access_path)[0]["access"] == access, "access_readback")
    _, tag = run.get(path)
    run.resource(
        run.call(
            "PATCH",
            path,
            "move_channel",
            headers={"If-Match": tag},
            json_body={"category_id": None, "position": 2, "topic": "Coordination updates"},
            primary_entity_type="comms_conversations",
            primary_entity_id=messages["id"],
            primary_action="update",
            expected_audit_rows=1,
        ),
        "conversation",
        "move_channel",
    )
    current, _ = run.get(path)
    check(
        current["category_id"] is None
        and current["position"] == 2
        and current["topic"] == "Coordination updates",
        "move_readback",
    )
    for operation in ("archive", "restore"):
        _, tag = run.get(path)
        run.resource(
            run.call(
                "POST",
                path + "/" + operation,
                operation,
                headers={"If-Match": tag},
                primary_entity_type="comms_conversations",
                primary_entity_id=messages["id"],
                primary_action="update",
                expected_audit_rows=1,
            ),
            "conversation",
            operation,
        )
        check(
            (run.get(path)[0]["archived_at"] is None) == (operation == "restore"),
            operation + "_readback",
        )
    members = run.page(path + "/members", "member")
    check({row["user_id"] for row in members} >= {context.user_ids["admin"], *people}, "members")
    _, tag = run.get(path)
    target = path + "/members/" + people[1]
    assigned = _read_json(
        run.call(
            "PUT",
            target,
            "set_role",
            headers={"If-Match": tag},
            json_body={"role": "manager"},
            primary_entity_type="comms_conversations",
            primary_entity_id=messages["id"],
            primary_action="update",
            expected_audit_rows=1,
            related_entity_types=("comms_members",),
        ),
        step="set_role",
    )
    check(
        assigned.get("user_id") == people[1] and assigned.get("member_role") == "manager",
        "set_role",
    )
    check(
        any(
            row["user_id"] == people[1] and row["member_role"] == "manager"
            for row in run.page(path + "/members", "member")
        ),
        "role_readback",
    )
    _, tag = run.get(path)
    run.call(
        "DELETE",
        target,
        "remove_member",
        204,
        headers={"If-Match": tag},
        primary_entity_type="comms_conversations",
        primary_entity_id=messages["id"],
        primary_action="update",
        expected_audit_rows=1,
        related_entity_types=("comms_members",),
    )
    check(
        all(row["user_id"] != people[1] for row in run.page(path + "/members", "member")),
        "remove_readback",
    )
    _, tag = run.get(access_path)
    copied_response = run.call(
        "POST",
        access_path + "/duplicates",
        "duplicate",
        201,
        headers={"If-Match": tag},
        json_body={"name": "Announcement template", "category_id": category["id"]},
        primary_entity_type="comms_conversations",
        primary_action="create",
        expected_audit_rows=1,
        related_entity_types=(
            "comms_members",
            "comms_conversation_groups",
            "comms_settings",
            "comms_capability_grants",
        ),
    )
    copied = run.resource(copied_response, "conversation", "duplicate")
    check(
        copied_response.headers.get("Location") == ROOT + "/conversations/" + copied["id"],
        "duplicate",
    )
    run.evidence[-1]["primary_entity_id"] = copied["id"]
    from operations.sample.phases.actions import _record_mapping

    _record_mapping(
        context, run.client, "comms_conversations", prefix + "duplicate", copied["id"], run.mappings
    )
    check(run.get(ROOT + "/conversations/" + copied["id"])[0]["access"] == access, "copy_readback")
    direct = run.create(
        ROOT + "/directs",
        "conversation",
        prefix + "direct",
        {"recipient_id": people[0]},
        "create_direct",
    )
    found = run.resource(
        run.call("POST", ROOT + "/directs", "find_direct", json_body={"recipient_id": people[0]}),
        "conversation",
        "find_direct",
    )
    check(found["id"] == direct["id"], "direct_identity")
    group = run.create(
        ROOT + "/groups",
        "conversation",
        prefix + "group",
        {
            "name": action.values["group_name"],
            "participant_ids": [context.user_ids["admin"], *people],
        },
        "create_group",
    )
    check(
        set(run.get(ROOT + "/conversations/" + group["id"])[0]["participant_ids"])
        == {context.user_ids["admin"], *people},
        "group_readback",
    )
    run.call(
        "POST",
        ROOT + "/direct-blocks",
        "block",
        204,
        json_body={"blocked_user_id": people[0]},
        primary_entity_type="comms_direct_blocks",
        primary_action="create",
        expected_audit_rows=1,
    )
    check(
        any(
            row["blocked_user_id"] == people[0]
            for row in run.page(ROOT + "/direct-blocks", "block")
        ),
        "block_readback",
    )
    run.call(
        "DELETE",
        ROOT + "/direct-blocks/" + people[0],
        "unblock",
        204,
        primary_entity_type="comms_direct_blocks",
        primary_action="delete",
        expected_audit_rows=1,
    )
    check(
        all(
            row["blocked_user_id"] != people[0]
            for row in run.page(ROOT + "/direct-blocks", "block")
        ),
        "unblock_readback",
    )
    check(
        any(
            row["id"] == messages["id"]
            for row in run.page(
                ROOT + "/conversations", "conversation", params={"search": common["name"]}
            )
        ),
        "conversation_list",
    )
    return _result(
        action,
        context,
        run.evidence,
        run.mappings,
        extra={
            "organization_id": run.org,
            "conversation_id": messages["id"],
            "structure_verified": True,
        },
    )


def verify_structure_controls(
    client: SampleClient, dataset: SampleDataset, manifest: Mapping[str, Any], admin_id: str
) -> tuple[dict[str, int], list[str]]:
    issues = []
    action = plan_structure_controls(dataset)[0]
    matches = [
        row for row in manifest.get("control_results", []) if row.get("action_key") == action.key
    ]
    if len(matches) != 1:
        return {"comms_structure_verified": 0}, ["Structure result is missing or duplicated"]
    row = matches[0]
    receipts = row.get("request_evidence", [])
    if (
        row.get("structure_verified") is not True
        or row.get("actor_id") != admin_id
        or row.get("organization_id") != manifest.get("organization_id")
        or tuple(r.get("step") for r in receipts) != PRIMARY_STEPS
        or any(
            r.get("status_code") != r.get("expected_status") or not r.get("request_id")
            for r in receipts
        )
    ):
        issues.append("Structure execution evidence differs")
    identity = (
        manifest.get("mappings", {}).get("comms_conversations", {}).get("primary:comms:messages")
    )
    if identity != row.get("conversation_id"):
        issues.append("Owned message mapping differs")
    response = client.request("GET", ROOT + "/conversations/" + str(identity))
    if response.status_code != 200:
        issues.append("Owned structure readback unavailable")
    else:
        current = _read_json(response, step="structure_verify")
        if (
            current.get("id") != identity
            or current.get("org_id") != manifest.get("organization_id")
            or current.get("archived_at") is not None
            or current.get("topic") != "Coordination updates"
        ):
            issues.append("Owned structure readback differs")
    return {"comms_structure_verified": 0 if issues else 1}, issues
