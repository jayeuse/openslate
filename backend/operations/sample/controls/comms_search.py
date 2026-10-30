"""D21 search execution and current readback in explicitly owned primary/partner conversations."""

import re
from collections.abc import Mapping
from datetime import UTC
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx

from app.common.listing import StandardListResponse
from app.systems.comms.messages.schemas import LiveMessage, Tombstone
from app.systems.comms.search import SearchHit
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _record_mapping,
    _request,
    _result,
)


def plan_search_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-search",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:messages",
            values={
                "operation": "search_roundtrip" if org == "primary" else "partner_search_roundtrip",
                "organization": org,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"search_verified": True, "tombstone_hidden": True},
        )
        for org in ("primary", "partner")
    )


def _page(response: httpx.Response) -> StandardListResponse[SearchHit]:
    check(
        response.status_code == 200 and "no-store" in response.headers.get("Cache-Control", ""),
        "search_response",
    )
    return StandardListResponse[SearchHit].model_validate_json(response.content)


def execute_search_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_search_controls(dataset):
        raise SamplePhaseActionError("Unsupported search operation", step=action.key)
    organization = str(action.values["organization"])
    if organization == "partner":
        factory = context.private_values.get("partner_admin")
        if not callable(factory):
            raise SamplePhaseActionError("Partner client is unavailable", step=action.key)
        partner = factory()
        check(
            partner.organization_id != context.clients["admin"].organization_id, "partner_binding"
        )
        context = bound_context(context, {**context.clients, "admin": partner})
    client = context.clients["admin"]
    org = _id({"org": client.organization_id}, "org", label="organization", step=action.key)
    actor = _id(context.user_ids, "admin", label="actor", step=action.key)
    conversation = _mapped_id(context, "comms_conversations", action.target_key, step=action.key)
    collection = f"/api/comms/conversations/{conversation}/messages"
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []

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

    marker = "comms" + uuid4().hex
    body = "🧭 " + marker
    created = LiveMessage.model_validate_json(
        call(
            "POST",
            collection,
            "create_search_source",
            201,
            json_body={"client_key": str(uuid4()), "body": body},
            primary_entity_type="comms_messages",
            primary_action="create",
            expected_audit_rows=1,
        ).content
    )
    check(
        (str(created.org_id), str(created.conversation_id), str(created.author_id), created.body)
        == (org, conversation, actor, body),
        "search_source_binding",
    )
    evidence[-1]["primary_entity_id"] = str(created.id)
    _record_mapping(
        context,
        client,
        "comms_messages",
        f"{organization}:comms:search-proof",
        str(created.id),
        mappings,
    )
    params = {
        "q": marker,
        "from": actor,
        "in": conversation,
        "on": created.created_at.astimezone(UTC).date().isoformat(),
        "limit": 25,
        "sort_by": "created_at",
        "sort_order": "asc",
    }
    page = _page(call("GET", "/api/comms/search", "search_live", params=params))
    check(
        page.pagination.total == 1 and page.pagination.count == 1 and not page.pagination.has_more,
        "search_count",
    )
    hit = page.items[0]
    check(
        (
            hit.message_id,
            str(hit.conversation_id),
            str(hit.author_id),
            hit.seq,
            hit.excerpt,
            hit.parent_id,
        )
        == (created.id, conversation, actor, created.seq, body, None),
        "search_hit",
    )
    check(
        [match.model_dump() for match in hit.matches] == [{"start": 2, "end": 39}],
        "search_code_points",
    )
    deleted = Tombstone.model_validate_json(
        call(
            "DELETE",
            collection + f"/{created.id}",
            "delete_search_source",
            primary_entity_type="comms_messages",
            primary_entity_id=str(created.id),
            primary_action="delete",
            expected_audit_rows=1,
        ).content
    )
    check(deleted.id == created.id, "search_tombstone")
    absent = _page(call("GET", "/api/comms/search", "search_deleted", params=params))
    check(
        absent.items == [] and absent.pagination.total == 0 and absent.pagination.count == 0,
        "deleted_search",
    )
    result = _result(
        action,
        context,
        evidence,
        mappings,
        extra={
            "organization_id": org,
            "conversation_id": conversation,
            "message_id": str(created.id),
            "query": params,
            "search_verified": True,
            "tombstone_hidden": True,
        },
    )
    if verify_search_control(client, result, actor):
        raise SamplePhaseActionError("Search final readback differs", step=action.key)
    return result


def verify_search_control(
    client: SampleClient, result: Mapping[str, Any], admin_id: str
) -> list[str]:
    issues = []
    try:
        conversation = _id(result, "conversation_id", label="conversation", step="search_verify")
        message = _id(result, "message_id", label="message", step="search_verify")
        collection = f"/api/comms/conversations/{conversation}/messages"
        item = collection + "/" + message
        expected = [
            ("create_search_source", "POST", collection, 201),
            ("delete_search_source", "DELETE", item, 200),
        ]
        receipts = result.get("request_evidence", [])
        if (
            [
                (row.get("step"), row.get("method"), row.get("path"), row.get("status_code"))
                for row in receipts
            ]
            != expected
            or any(row.get("actor_id") != admin_id or not row.get("request_id") for row in receipts)
            or result.get("actor_id") != admin_id
            or result.get("organization_id") != client.organization_id
            or result.get("search_verified") is not True
            or result.get("tombstone_hidden") is not True
        ):
            issues.append("Search execution evidence differs")
        query = result["query"]
        check(
            query["from"] == admin_id
            and query["in"] == conversation
            and re.fullmatch(r"comms[0-9a-f]{32}", query["q"]) is not None,
            "search_query_binding",
        )
        page = _page(client.request("GET", "/api/comms/search", params=query))
        check(
            page.items == [] and page.pagination.total == page.pagination.count == 0,
            "search_deleted",
        )
        response = client.request("GET", item)
        check(response.status_code == 200, "search_tombstone_read")
        tombstone = Tombstone.model_validate_json(response.content)
        check(
            (str(tombstone.id), str(tombstone.org_id), str(tombstone.conversation_id))
            == (message, client.organization_id, conversation),
            "search_tombstone_binding",
        )
    except (ValueError, KeyError, TypeError, SamplePhaseActionError):
        issues.append("Search retained readback differs")
    return issues


def verify_search_runs(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    *,
    api_url: str,
    origin: str,
    journal: Path,
    operator_login: tuple[str, str],
    operator_id: str,
) -> tuple[dict[str, int], list[str]]:
    actions = plan_search_controls(dataset)
    rows = manifest.get("control_results", [])
    if not any(
        isinstance(row, Mapping) and row.get("action_key") in {action.key for action in actions}
        for row in rows
    ):
        return {}, []
    count, issues = 0, []
    for action in actions:
        matches = [
            row for row in rows if isinstance(row, Mapping) and row.get("action_key") == action.key
        ]
        if len(matches) != 1:
            issues.append("Search execution result is missing or duplicated")
            continue
        result = matches[0]
        if action.values["organization"] == "primary":
            current = verify_search_control(client, result, admin_id)
        else:
            try:
                org = str(UUID(str(manifest.get("partner_organization_id"))))
            except ValueError:
                issues.append("Search partner organization is invalid")
                continue
            if org == client.organization_id or result.get("organization_id") != org:
                issues.append("Search partner binding differs")
                continue
            with SampleClient(api_url, origin, journal, org) as partner:
                if partner.login(*operator_login).status_code != 200:
                    issues.append("Search partner verification sign-in failed")
                    continue
                try:
                    current = verify_search_control(partner, result, operator_id)
                finally:
                    partner.request("POST", "/api/auth/logout")
        issues.extend(current)
        count += not current
    return {"comms_search_verified": count}, issues
