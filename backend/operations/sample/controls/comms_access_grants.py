"""D45 channel and category access grants, and the candidate search, through the API only."""

from typing import Any

import httpx

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.comms_structure_common import check
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _request,
    _result,
)

ROOT = "/api/comms"
GRANT_KEYS = {
    "subject",
    "subject_id",
    "display_name",
    "departments",
    "level",
    "source",
    "created_at",
    "updated_at",
}


def plan_access_grant_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    member = next(
        person.key
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active"
    )
    group = sorted(dataset.organization.actors.group_access)[0]
    return (
        PhaseAction(
            key="control:comms:primary-access-grants",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key="primary:comms:access-grants",
            values={
                "operation": "access_grants_roundtrip",
                "organization": "primary",
                "member_key": member,
                "group_key": group,
                # The sample population names each group after its key.
                "group_name": " ".join(word.capitalize() for word in group.split("-")),
                "department_key": dataset.organization.catalog.departments[0][0],
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"access_grants_verified": True},
        ),
    )


def execute_access_grant_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_access_grant_controls(dataset):
        raise SamplePhaseActionError("Unsupported access grant operation", step=action.key)
    values = action.values
    org = _id(
        {"org": context.clients["admin"].organization_id}, "org", label="organization", step="org"
    )
    person = _id(context.user_ids, str(values["member_key"]), label="member", step=action.key)
    group = _id(context.group_ids, str(values["group_key"]), label="group", step=action.key)
    department = _id(
        context.department_ids, str(values["department_key"]), label="department", step=action.key
    )
    evidence: list[dict[str, object]] = []

    def call(
        method: str, path: str, step: str, expected: int = 200, **kwargs: Any
    ) -> httpx.Response:
        return _request(
            action,
            context,
            evidence,
            actor_key="admin",
            method=method,
            path=path,
            step=step,
            expected=expected,
            on_substep=on_substep,
            **kwargs,
        )

    def grants(target: str, step: str) -> tuple[list[dict[str, Any]], str]:
        response = call("GET", target + "/access-grants", step)
        body = response.json()
        check(set(body) == {"items"}, "grant_list_shape")
        check(all(set(item) == GRANT_KEYS for item in body["items"]), "grant_item_shape")
        check("no-store" in response.headers.get("Cache-Control", ""), "no_store")
        return body["items"], response.headers["ETag"]

    def write(
        method: str,
        target: str,
        subject: str,
        subject_id: str,
        step: str,
        expected: int,
        **body: str,
    ) -> httpx.Response:
        _, tag = grants(target, "tag:" + step)
        response: httpx.Response = call(
            method,
            f"{target}/access-grants/{subject}/{subject_id}",
            step,
            expected,
            headers={"If-Match": tag},
            json_body=body or None,
        )
        if method == "PUT":
            item = response.json()
            source = "channel" if "/conversations/" in target else "category"
            check(set(item) == GRANT_KEYS, "grant_shape")
            check(
                (item["subject"], item["subject_id"], item["level"], item["source"])
                == (subject, subject_id, body["level"], source),
                "grant_written",
            )
        return response

    def rows(items: list[dict[str, Any]]) -> list[tuple[str, str, str, str]]:
        return [(i["source"], i["subject"], i["subject_id"], i["level"]) for i in items]

    category = call(
        "POST",
        ROOT + "/categories",
        "create_category",
        201,
        json_body={"name": "Shared access", "position": 0, "department_id": department},
    ).json()
    channel = call(
        "POST",
        ROOT + "/conversations",
        "create_department_channel",
        201,
        json_body={
            "name": "Shared access",
            "topic": "",
            "position": 0,
            "category_id": category["id"],
            "scope": "department",
            "department_id": department,
        },
    ).json()
    check(channel["org_id"] == org and category["org_id"] == org, "bound_org")
    channel_path = ROOT + "/conversations/" + channel["id"]
    category_path = ROOT + "/categories/" + category["id"]

    check(grants(channel_path, "channel_empty")[0] == [], "channel_empty")
    created = write("PUT", channel_path, "group", group, "channel_group", 201, level="read")
    check(
        created.headers.get("Location") == f"{channel_path}/access-grants/group/{group}",
        "grant_location",
    )
    person_grant = write("PUT", channel_path, "user", person, "channel_user", 201, level="post")
    # The grant names the person, so the search needs no other directory read.
    name = person_grant.json()["display_name"]
    check(isinstance(name, str) and bool(name.strip()), "named_person")
    for target, kind, query, found in (
        (channel_path, "user", name[:100], person),
        (category_path, "group", str(values["group_name"]), group),
    ):
        response = call(
            "GET",
            target + "/access-candidates",
            "candidates:" + kind,
            params={"q": query, "kind": kind, "limit": 20},
        )
        body = response.json()
        check(set(body) == {"people", "groups"}, "candidate_shape")
        people, groups = body["people"], body["groups"]
        check(len(people) <= 20 and len(groups) <= 20, "candidate_limit")
        check(all(set(p) == {"user_id", "display_name", "departments"} for p in people), "person")
        check(all(set(g) == {"id", "name"} for g in groups), "group")
        listed = [p["user_id"] for p in people] if kind == "user" else [g["id"] for g in groups]
        check(found in listed and (groups if kind == "user" else people) == [], "candidate_kind")
        check("no-store" in response.headers.get("Cache-Control", ""), "no_store")

    write("PUT", channel_path, "user", person, "channel_user_level", 200, level="read")
    check(grants(category_path, "category_empty")[0] == [], "category_empty")
    write("PUT", category_path, "group", group, "category_group", 201, level="post")
    write("PUT", category_path, "user", person, "category_user", 201, level="read")
    # Channel items come first, then the inherited category items; groups before people.
    check(
        rows(grants(channel_path, "channel_with_inherited")[0])
        == [
            ("channel", "group", group, "read"),
            ("channel", "user", person, "read"),
            ("category", "group", group, "post"),
            ("category", "user", person, "read"),
        ],
        "inherited_grants",
    )
    for target, prefix in ((category_path, "category"), (channel_path, "channel")):
        write("DELETE", target, "user", person, prefix + "_revoke_user", 204)
        write("DELETE", target, "group", group, prefix + "_revoke_group", 204)
    check(grants(channel_path, "channel_revoked")[0] == [], "channel_revoked")
    check(grants(category_path, "category_revoked")[0] == [], "category_revoked")
    return _result(
        action,
        context,
        evidence,
        [],
        extra={
            "organization_id": org,
            "conversation_id": channel["id"],
            "access_grants_verified": True,
        },
    )
