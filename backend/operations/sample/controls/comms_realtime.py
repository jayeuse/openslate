"""S20A API-only token receipts; never persist a channel token in sample state."""

from uuid import UUID

import jwt

from app.systems.platform.realtime.schemas import RealtimeTokenRead
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


def plan_token_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-token",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:messages",
            values={
                "operation": "token_roundtrip" if org == "primary" else "partner_token_roundtrip",
                "organization": org,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"token_verified": True},
        )
        for org in ("primary", "partner")
    )


def execute_token_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_token_controls(dataset):
        raise SamplePhaseActionError("Unsupported token operation", step=action.key)
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
        path="/api/realtime/token",
        step="issue_channel_token",
        expected=200,
        on_substep=on_substep,
        expected_audit_rows=0,
    )
    check(response.headers.get("Cache-Control") == "no-store", "token_cache")
    token = RealtimeTokenRead.model_validate_json(response.content)
    claims = jwt.decode(token.access_token, options={"verify_signature": False})
    # This is receipt validation, not an authorization decision or a signature-verifier substitute.
    check(jwt.get_unverified_header(token.access_token)["alg"] == "ES256", "token_algorithm")
    check(
        (claims.get("sub"), claims.get("org_id"), claims.get("purpose")) == (actor, org, "realtime")
        and "aud" not in claims,
        "token_identity",
    )
    check(
        claims["exp"] - claims["iat"] == 300 and token.expires_at.timestamp() == claims["exp"],
        "token_lifetime",
    )
    prefix = f"org:{org}:"
    check(
        token.topic_prefix == prefix
        and token.conversation_topics == sorted(set(token.conversation_topics)),
        "token_topics",
    )
    for topic in token.conversation_topics:
        suffix = topic.removeprefix(prefix + "conversation:")
        check(str(UUID(suffix)) == suffix, "token_topic_binding")
    check(
        prefix + "conversation:" + conversation in token.conversation_topics,
        "token_owned_conversation",
    )
    return _result(
        action,
        context,
        evidence,
        [],
        extra={
            "organization_id": org,
            "token_verified": True,
            "conversation_count": len(token.conversation_topics),
        },
    )
