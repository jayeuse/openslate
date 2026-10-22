"""Owned primary/partner presence, typing and B8 HTTP receipts; no browser leader engine."""

from app.systems.comms.messages.schemas import BootstrapResponse
from app.systems.comms.realtime.schemas import HeartbeatResponse, PresenceSnapshot
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _request,
    _result,
)


def plan_presence_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-presence",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:messages",
            values={
                "operation": "presence_roundtrip"
                if org == "primary"
                else "partner_presence_roundtrip",
                "organization": org,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"presence_verified": True, "typing_verified": True},
        )
        for org in ("primary", "partner")
    )


def execute_presence_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_presence_controls(dataset):
        raise SamplePhaseActionError("Unsupported presence operation", step=action.key)
    if action.values["organization"] == "partner":
        factory = context.private_values.get("partner_admin")
        if not callable(factory):
            raise SamplePhaseActionError("Partner client is unavailable", step=action.key)
        client = factory()
        check(client.organization_id != context.clients["admin"].organization_id, "partner_binding")
        context = bound_context(context, {**context.clients, "admin": client})
    org = _id(
        {"org": context.clients["admin"].organization_id},
        "org",
        label="organization",
        step=action.key,
    )
    actor = _id(context.user_ids, "admin", label="actor", step=action.key)
    conversation = _mapped_id(context, "comms_conversations", action.target_key, step=action.key)
    evidence: list[dict[str, object]] = []
    response = _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="POST",
        path="/api/comms/presence",
        step="heartbeat",
        expected=200,
        on_substep=on_substep,
        expected_audit_rows=0,
        json_body={"state": "online"},
    )
    check(response.headers.get("Cache-Control") == "no-store", "heartbeat_cache")
    heartbeat = HeartbeatResponse.model_validate_json(response.content)
    check((str(heartbeat.org_id), str(heartbeat.user_id)) == (org, actor), "heartbeat_binding")
    ids = [str(item.conversation_id) for item in heartbeat.changed]
    check(ids == sorted(set(ids)), "heartbeat_order")
    if heartbeat.truncated:
        # Explicit complete fallback, never treat the first hundred as a complete set.
        response = _request(
            action,
            context,
            evidence,
            actor_key="admin",
            method="GET",
            path="/api/comms/bootstrap",
            step="overflow_bootstrap",
            expected=200,
            on_substep=on_substep,
        )
        complete = BootstrapResponse.model_validate_json(response.content)
        check(
            str(complete.org_id) == org
            and any(str(row.conversation.id) == conversation for row in complete.conversations),
            "bootstrap_binding",
        )
    else:
        response = _request(
            action,
            context,
            evidence,
            actor_key="admin",
            method="POST",
            path="/api/comms/presence",
            step="known_heartbeat",
            expected=200,
            on_substep=on_substep,
            expected_audit_rows=0,
            json_body={
                "state": "online",
                "known_sequences": [row.model_dump(mode="json") for row in heartbeat.changed],
            },
        )
        known = HeartbeatResponse.model_validate_json(response.content)
        check(known.changed == [] and not known.truncated, "known_heartbeat")
    response = _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="GET",
        path="/api/comms/presence",
        params={"user_ids": [actor]},
        step="presence_snapshot",
        expected=200,
        on_substep=on_substep,
    )
    snapshot = PresenceSnapshot.model_validate_json(response.content)
    check(
        str(snapshot.org_id) == org
        and [row.model_dump(mode="json") for row in snapshot.items]
        == [{"user_id": actor, "state": "online"}],
        "presence_snapshot",
    )
    response = _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="POST",
        path=f"/api/comms/conversations/{conversation}/typing",
        step="typing",
        expected=204,
        on_substep=on_substep,
        expected_audit_rows=0,
    )
    check(response.content == b"", "typing_response")
    return _result(
        action,
        context,
        evidence,
        [],
        extra={
            "organization_id": org,
            "presence_verified": True,
            "typing_verified": True,
            "overflow_recovered": heartbeat.truncated,
        },
    )
