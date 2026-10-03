"""Execute and verify planned requests that an organization expects the API to refuse."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from uuid import NAMESPACE_URL, uuid5

import httpx

from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient
from operations.sample_packs import default_pack
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.types import RejectionCase
from operations.sample_population import SamplePopulationError, _record_if_match
from operations.sample_verification import list_all_rows


@dataclass
class RejectionContext:
    """What running a case needs: sessions, the private roster and server IDs."""

    dataset: SampleDataset
    admin: SampleClient
    clients: Mapping[str, SampleClient]
    new_client: Callable[[], SampleClient]
    roster_path: Path
    mappings: Callable[[], Mapping[str, Mapping[str, str]]]
    build_payload: Callable[[str], dict[str, Any]]
    field_map: Callable[[str], Mapping[str, str]]
    results: list[dict[str, Any]]
    save: Callable[[list[dict[str, Any]]], None] = lambda _results: None


def _roster_account(context: RejectionContext, key: str) -> Mapping[str, Any]:
    accounts = json.loads(context.roster_path.read_text(encoding="utf-8"))["accounts"]
    account = next((row for row in accounts if row.get("key") == key), None)
    if not isinstance(account, dict):
        raise SamplePopulationError(f"Rejection actor is missing from the roster: {key}")
    return cast(Mapping[str, Any], account)


def _session(context: RejectionContext, key: str) -> SampleClient:
    if key == "admin":
        return context.admin
    if key in context.clients:
        return context.clients[key]
    account = _roster_account(context, key)
    client = context.new_client()
    if client.login(str(account["email"]), str(account["password"])).status_code != 200:
        raise SamplePopulationError(f"Rejection actor could not sign in: {key}")
    return client


def invalid_record_data(
    dataset: SampleDataset,
    case: RejectionCase | str,
    data: dict[str, Any],
    field_map: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Apply one pack-described invalid field to a valid generated record payload."""
    if isinstance(case, str):
        cases = (
            *dataset.organization.rejections.activity_cases,
            *dataset.organization.rejections.closing_cases,
        )
        selected = next((item for item in cases if item.key == case), None)
        if selected is None:
            raise SamplePopulationError(f"Unknown rejection case: {case}")
        case = selected
    broken = dict(data)
    action = case.invalid_field_action
    if action is None:
        return broken
    if case.template_record_id is None:
        raise SamplePopulationError("Invalid record rejection has no template record")
    module_key = case.template_record_id.split(":", maxsplit=1)[0]

    def api_field(key: str) -> str:
        document_id = dataset.field_ids[module_key][key]
        return field_map[document_id] if field_map is not None else document_id

    if action == "remove" and case.field_key is not None:
        broken.pop(api_field(case.field_key), None)
    elif action == "invalid-option" and case.field_key is not None:
        key = dataset.organization.rejections.invalid_option_key
        broken[api_field(case.field_key)] = str(uuid5(NAMESPACE_URL, key))
    elif action == "set" and case.field_key is not None:
        broken[api_field(case.field_key)] = case.field_value
    elif action == "add-unknown-field":
        key = dataset.organization.rejections.invalid_field_key
        broken[str(uuid5(NAMESPACE_URL, key))] = case.field_value
    else:
        raise SamplePopulationError("Invalid record rejection is missing its field rule")
    return broken


def outcome_matches(case: RejectionCase, status: int, body: Any) -> bool:
    """Require the expected status and its specific detail, never the status alone."""
    if status != case.expected_status or not isinstance(body, Mapping):
        return False
    detail = body.get("detail")
    if detail == case.expected_detail:
        return True
    if isinstance(detail, Mapping):
        errors = detail.get("errors")
        codes = (
            [item.get("code") for item in errors if isinstance(item, Mapping)]
            if isinstance(errors, list)
            else []
        )
        return case.expected_detail == detail.get("code") or case.expected_detail in codes
    return False


def _logical_record_id(value: str | None, label: str) -> str:
    if not value:
        raise SamplePopulationError(f"Rejection case is missing its {label}")
    return value


def _request(context: RejectionContext, case: RejectionCase) -> httpx.Response:
    maps = context.mappings()
    records = maps.get("record", {})
    relationships = maps.get("relationships", {})
    operation = case.operation

    if operation == "sign-in":
        account = _roster_account(context, case.actor_key)
        password = str(account.get("password") or "Not-the-right-password-2026")
        return context.new_client().login(str(account["email"]), password)

    client = _session(context, case.actor_key)
    if operation == "create-record":
        logical_id = _logical_record_id(case.template_record_id, "record template")
        payload = context.build_payload(logical_id)
        if case.invalid_field_action is not None:
            module_key = logical_id.split(":", maxsplit=1)[0]
            payload["data"] = invalid_record_data(
                context.dataset, case, payload["data"], context.field_map(module_key)
            )
        return client.request("POST", "/api/records", json_body=payload)

    if operation == "read-record":
        logical_id = _logical_record_id(case.target_record_id, "record")
        return client.request("GET", f"/api/records/{records[logical_id]}")

    if operation == "edit-record":
        logical_id = _logical_record_id(case.target_record_id, "record")
        record_id = records[logical_id]
        current = client.request("GET", f"/api/records/{record_id}").json()
        return client.request(
            "PATCH",
            f"/api/records/{record_id}",
            json_body={"data": current["data"]},
            headers=_record_if_match(current),
        )

    if operation == "unversioned-record-edit":
        # The same save as edit-record, without If-Match: refused with 428, no write.
        logical_id = _logical_record_id(case.target_record_id, "record")
        record_id = records[logical_id]
        current = client.request("GET", f"/api/records/{record_id}").json()
        return client.request(
            "PATCH", f"/api/records/{record_id}", json_body={"data": current["data"]}
        )

    if operation in {"create-relationship", "replace-relationship"}:
        relationship_key = _logical_record_id(case.relationship_key, "relationship")
        source = _logical_record_id(case.source_record_id, "source record")
        target = _logical_record_id(case.target_record_id, "target record")
        field_id = relationships[relationship_key]
        source_id, target_id = records[source], records[target]
        if operation == "create-relationship":
            body = {
                "field_id": field_id,
                "source_record_id": source_id,
                "target_record_id": target_id,
            }
            return client.request("POST", "/api/relationships", json_body=body)
        path = f"/api/relationships/fields/{field_id}/sources/{source_id}"
        return client.request("PUT", path, json_body={"target_record_id": target_id})

    if operation == "stale-group-edit":
        group_key = _logical_record_id(case.group_key, "group")
        group_id = maps.get("group", {})[group_key]
        current = client.request("GET", f"/api/access/groups/{group_id}")
        etag = current.headers.get("ETag", "")
        tag_id, _, revision = etag.strip('"').rpartition(":")
        if not tag_id or not revision.isdigit() or int(revision) < 1:
            raise SamplePopulationError("The group's version tag could not be read")
        stale = f'"{tag_id}:{int(revision) - 1}"'
        description = current.json().get("description") or case.fallback_description or "Team group"
        return client.request(
            "PATCH",
            f"/api/access/groups/{group_id}",
            headers={"If-Match": stale},
            json_body={"description": description},
        )

    if operation == "stale-post-edit":
        board_key = _logical_record_id(case.board_key, "Board")
        post_key = _logical_record_id(case.post_key, "post")
        board_id, post_id = maps["boards"][board_key], maps["posts"][post_key]
        board = client.request("GET", f"/api/boards/{board_id}").json()
        post_path = f"/api/boards/{board_id}/posts/{post_id}"
        post_response = client.request("GET", post_path, params={"view": "editable"})
        post = post_response.json() if post_response.status_code == 200 else {}
        revision = post.get("post_revision")
        if (
            not isinstance(revision, int)
            or revision < 2
            or not isinstance(board.get("revision"), int)
        ):
            raise SamplePopulationError("The edited post's revisions could not be read")
        edit: dict[str, Any] = {
            "board_revision": board["revision"],
            "post_revision": revision - 1,
            "title": post.get("title"),
        }
        return client.request("PATCH", post_path, json_body=edit)

    raise SamplePopulationError("Unknown rejection operation")


def run_rejection(context: RejectionContext, case: RejectionCase) -> None:
    """Send one refused request, record it, and stop if the API accepted it."""
    response = _request(context, case)
    try:
        body: Any = response.json()
    except ValueError:
        body = None
    request_id = response.headers.get("X-Request-ID", "")
    matched = outcome_matches(case, response.status_code, body)
    context.results.append(
        {
            "case": case.key,
            "actor": case.actor_key,
            "expected_status": case.expected_status,
            "actual_status": response.status_code,
            "request_id": request_id,
            "outcome": "matched" if matched else "mismatch",
        }
    )
    context.save(context.results)
    if request_id:
        context.admin.record_mapping("expected_failure", case.key, request_id)
    if response.status_code < 400:
        raise SamplePopulationError(f"The API accepted a request it must refuse: {case.key}")


def check_rejections(
    results: Sequence[Mapping[str, Any]],
    audit_rows: Sequence[Mapping[str, Any]],
    organization: OrganizationPack | None = None,
) -> list[str]:
    """Require every pack-planned case and no audit trace from a refused request."""
    pack = organization or default_pack()
    cases = (*pack.rejections.activity_cases, *pack.rejections.closing_cases)
    issues = []
    expected = {case.key for case in cases}
    if sorted(str(item.get("case")) for item in results) != sorted(expected):
        issues.append("planned rejections did not all run exactly once")
    if any(item.get("outcome") != "matched" for item in results):
        issues.append("a planned rejection returned an unexpected status or detail")
    refused = {str(item.get("request_id")) for item in results if item.get("request_id")}
    if any(str(row.get("request_id")) in refused for row in audit_rows):
        issues.append("a refused request left audit evidence of a change")
    return issues


def verify_rejections(
    client: SampleClient,
    *,
    results: Sequence[Mapping[str, Any]],
    started_at: str,
    finished_at: str,
    organization: OrganizationPack | None = None,
) -> tuple[dict[str, int], list[str]]:
    rows: list[Mapping[str, Any]] = []
    for entity_type in ("records", "relationship_edges", "groups", "board_posts"):
        rows.extend(
            list_all_rows(
                client,
                "/api/audit-logs",
                params={
                    "entity_type": entity_type,
                    "created_after": started_at,
                    "created_before": finished_at,
                },
            )
        )
    matched = sum(item.get("outcome") == "matched" for item in results)
    return {"planned_rejections_matched": matched}, check_rejections(results, rows, organization)


def __getattr__(name: str) -> Any:
    pack = default_pack()
    if name == "ACTIVITY_CASES":
        return pack.rejections.activity_cases
    if name == "CLOSING_CASES":
        return pack.rejections.closing_cases
    raise AttributeError(name)
