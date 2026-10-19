"""Create owned partner rooms only after API admission and a bound-client identity check."""

from collections.abc import Mapping

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.comms_structure_common import (
    StructureRun,
    bound_context,
    check,
    member_keys,
)
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _read_json,
    _result,
)


def execute_partner(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    admin_factory, actor_factory = (
        context.private_values.get(key) for key in ("partner_admin", "partner_actor")
    )
    if not callable(admin_factory) or not callable(actor_factory):
        raise SamplePhaseActionError("Partner-bound clients are unavailable", step=action.key)
    admin: SampleClient = admin_factory()
    primary_org = context.clients["admin"].organization_id
    if admin.organization_id is None or admin.organization_id == primary_org:
        raise SamplePhaseActionError("Partner organization differs from plan", step=action.key)
    clients = {**context.clients, "admin": admin}
    run = StructureRun(action, bound_context(context, clients), on_substep)
    run.identity()
    keys = member_keys(action)
    first, second = keys
    people = [_id(context.user_ids, key, label="member", step=action.key) for key in keys]
    person = next(person for person in dataset.organization.actors.people if person.key == second)
    credentials = context.private_values.get("credentials")
    credential = credentials.get(second) if isinstance(credentials, Mapping) else None
    if credential is None or getattr(credential, "user_id", None) != people[1]:
        raise SamplePhaseActionError("Partner actor credential is unavailable", step=action.key)
    invited = _read_json(
        run.call(
            "POST",
            "/api/auth/invitations",
            "invite_partner_member",
            201,
            json_body={"email": credential.email, "username": person.username, "role": "member"},
        ),
        step="invite_partner_member",
    )
    check(
        invited.get("delivery") == "in_app" and invited.get("user", {}).get("id") == people[1],
        "invite_partner_member",
    )
    current = _read_json(
        run.call("GET", "/api/auth/me", "pending_partner_invitation", actor=second),
        step="pending_partner_invitation",
    )
    invitations = [
        row for row in current.get("pending_invitations", []) if row.get("org_id") == run.org
    ]
    check(len(invitations) == 1, "pending_partner_invitation")
    invitation = _id(invitations[0], "id", label="invitation", step="pending_partner_invitation")
    run.call(
        "POST",
        f"/api/auth/invitations/{invitation}/accept",
        "accept_partner_invitation",
        204,
        actor=second,
    )
    for org, step in ((run.org, "select_partner"), (primary_org, "restore_primary")):
        selected = _read_json(
            run.call(
                "POST",
                "/api/auth/session/organization",
                step,
                actor=second,
                json_body={"org_id": org},
            ),
            step=step,
        )
        check(
            selected.get("id") == people[1]
            and selected.get("current_organization", {}).get("org_id") == org,
            step,
        )
    for key in (first, second):
        client: SampleClient = actor_factory(key)
        check(client.organization_id == run.org, "bound_partner_client")
        clients[key] = client
        run.identity(key)
    root, prefix = "/api/comms", "partner:comms:"
    category = run.create(
        root + "/categories",
        "category",
        prefix + "category",
        {
            "name": action.values["category_name"],
            "position": 0,
            "department_id": None,
            "default_access": [],
        },
        "create_partner_category",
    )
    run.get(root + "/categories/" + category["id"], "category")
    channel = run.create(
        root + "/conversations",
        "conversation",
        prefix + "messages",
        {
            "name": action.values["channel_name"],
            "topic": "",
            "position": 0,
            "category_id": category["id"],
            "scope": "members",
            "member_ids": people,
        },
        "create_partner_channel",
    )
    path = root + "/conversations/" + channel["id"]
    run.get(path)
    for key in keys:
        row, _ = run.get(path, actor=key)
        check(row["level"] == "post" and row["member_role"] == "member", "partner_member_readback")
    direct = run.create(
        root + "/directs",
        "conversation",
        prefix + "direct",
        {"recipient_id": people[0]},
        "create_partner_direct",
    )
    found = run.resource(
        run.call(
            "POST", root + "/directs", "find_partner_direct", json_body={"recipient_id": people[0]}
        ),
        "conversation",
        "find_partner_direct",
    )
    check(found["id"] == direct["id"], "partner_direct_identity")
    run.get(root + "/conversations/" + direct["id"])
    group = run.create(
        root + "/groups",
        "conversation",
        prefix + "group",
        {
            "name": action.values["group_name"],
            "participant_ids": [context.user_ids["admin"], *people],
        },
        "create_partner_group",
    )
    check(
        set(run.get(root + "/conversations/" + group["id"])[0]["participant_ids"])
        == {context.user_ids["admin"], *people},
        "partner_group_readback",
    )
    return _result(
        action,
        context,
        run.evidence,
        run.mappings,
        extra={
            "organization_id": run.org,
            "conversation_id": channel["id"],
            "partner_members_verified": True,
            "member_ids": people,
        },
    )
