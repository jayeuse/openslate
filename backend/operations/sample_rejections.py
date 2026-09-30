"""Planned rejections: requests people make that the API must refuse before any write.

Each case records the actor, request, expected and actual status and detail, and the
request ID. A case that the API accepts stops the run, because it changed data.
"""

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
from operations.sample_population import SamplePopulationError
from operations.sample_verification import list_all_rows

_NEVER_AN_OPTION = str(uuid5(NAMESPACE_URL, "openslate:harbor-operations:not-an-option"))
_NEVER_A_FIELD = str(uuid5(NAMESPACE_URL, "openslate:harbor-operations:never-a-field"))
_FORBIDDEN, _HIDDEN = "Forbidden", "Module not found"
_BAD_CREDENTIALS = "Invalid authentication credentials"


@dataclass(frozen=True)
class RejectionCase:
    key: str
    actor_key: str
    needs: tuple[str, ...]
    expected_status: int
    expected_detail: str  # A detail string, a detail code, or a validation error code.


ACTIVITY_CASES = (
    RejectionCase("guest_creates_record", "guest_01", (), 403, _FORBIDDEN),
    RejectionCase("auditor_creates_invoice", "internal_sales_04", (), 403, _FORBIDDEN),
    RejectionCase("auditor_edits_invoice", "internal_sales_05", ("invoices:000003",), 403,
                  _FORBIDDEN),
    RejectionCase("record_in_hidden_department", "internal_sales_02", (), 404, _HIDDEN),
    RejectionCase("missing_required_field", "internal_sales_02", (), 422, "required_field"),
    RejectionCase("unknown_select_option", "internal_sales_03", (), 422, "invalid_field_value"),
    RejectionCase("wrong_value_type", "internal_sales_03", (), 422, "invalid_field_value"),
    RejectionCase("unknown_field", "internal_sales_02", (), 422, "unknown_field"),
    RejectionCase("duplicate_link", "internal_sales_02", ("customers:000001", "contacts:000001"),
                  409, "Relationship already exists"),
    RejectionCase("second_work_order_for_inspection", "internal_field_02",
                  ("work_orders:000002", "inspections:000001"), 409,
                  "Target already has a relationship source"),
    RejectionCase("stale_group_edit", "admin", (), 412, "Resource changed"),
)  # fmt: skip
CLOSING_CASES = (
    RejectionCase("stale_post_edit", "internal_sales_lead", (), 409, "stale_post_revision"),
    RejectionCase("pending_account_sign_in", "internal_pending_01", (), 401, _BAD_CREDENTIALS),
    RejectionCase("disabled_account_sign_in", "internal_disabled_01", (), 401, _BAD_CREDENTIALS),
)
# The generated record each record-payload case starts from.
_TEMPLATES = {
    "guest_creates_record": "customers:000002",
    "auditor_creates_invoice": "invoices:000002",
    "record_in_hidden_department": "work_orders:000002",
    "missing_required_field": "customers:000002",
    "unknown_select_option": "customers:000002",
    "wrong_value_type": "customers:000002",
    "unknown_field": "customers:000002",
}


def invalid_record_data(
    dataset: SampleDataset,
    case_key: str,
    data: dict[str, Any],
    field_map: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Break exactly one record rule; `field_map` turns document field IDs into API IDs."""
    fields = dataset.field_ids["customers"]

    def api(key: str) -> str:
        return field_map[fields[key]] if field_map is not None else fields[key]

    broken = dict(data)
    if case_key == "missing_required_field":
        broken.pop(api("name"), None)
    elif case_key == "unknown_select_option":
        broken[api("segment")] = _NEVER_AN_OPTION
    elif case_key == "wrong_value_type":
        broken[api("credit_limit")] = "about fifty thousand"
    elif case_key == "unknown_field":
        broken[_NEVER_A_FIELD] = "Regional account"
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
    # Saves results as they happen, so a stopped run keeps its rejection evidence.
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


def _request(context: RejectionContext, case: RejectionCase) -> httpx.Response:
    maps = context.mappings()
    records, fields = maps.get("record", {}), maps.get("relationships", {})
    if case.key in {"pending_account_sign_in", "disabled_account_sign_in"}:
        account = _roster_account(context, case.actor_key)
        password = str(account.get("password") or "Not-the-right-password-2026")
        return context.new_client().login(str(account["email"]), password)
    client = _session(context, case.actor_key)
    if case.key in _TEMPLATES:
        payload = context.build_payload(_TEMPLATES[case.key])
        module_key = _TEMPLATES[case.key].split(":")[0]
        payload["data"] = invalid_record_data(
            context.dataset, case.key, payload["data"], context.field_map(module_key)
        )
        return client.request("POST", "/api/records", json_body=payload)
    if case.key == "auditor_edits_invoice":
        record_id = records["invoices:000003"]
        current = client.request("GET", f"/api/records/{record_id}").json()
        return client.request(
            "PATCH", f"/api/records/{record_id}", json_body={"data": current["data"]}
        )
    if case.key == "duplicate_link":
        body = {
            "field_id": fields["customer_contacts"],
            "source_record_id": records["customers:000001"],
            "target_record_id": records["contacts:000001"],
        }
        return client.request("POST", "/api/relationships", json_body=body)
    if case.key == "second_work_order_for_inspection":
        path = (f"/api/relationships/fields/{fields['work_order_inspections']}"
                f"/sources/{records['work_orders:000002']}")  # fmt: skip
        return client.request(
            "PUT", path, json_body={"target_record_id": records["inspections:000001"]}
        )
    if case.key == "stale_group_edit":
        group_id = maps.get("group", {})["sales-desk"]
        current = client.request("GET", f"/api/access/groups/{group_id}")
        etag = current.headers.get("ETag", "")
        tag_id, _, revision = etag.strip('"').rpartition(":")
        if not tag_id or not revision.isdigit() or int(revision) < 1:
            raise SamplePopulationError("The group's version tag could not be read")
        stale = f'"{tag_id}:{int(revision) - 1}"'
        description = current.json().get("description") or "Sales team"
        return client.request(
            "PATCH",
            f"/api/access/groups/{group_id}",
            headers={"If-Match": stale},
            json_body={"description": description},
        )
    if case.key == "stale_post_edit":
        board_id, post_id = (
            maps["boards"]["department:sales"],
            maps["posts"]["department:sales:post:03"],
        )
        board = client.request("GET", f"/api/boards/{board_id}").json()
        post_path = f"/api/boards/{board_id}/posts/{post_id}"
        # The edited post is published, so its current revision is in the editable view.
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
    raise SamplePopulationError(f"Unknown rejection case: {case.key}")


def run_rejection(context: RejectionContext, case: RejectionCase) -> None:
    """Send one refused request, record it, and stop the run if it was accepted."""
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
        }  # fmt: skip
    )
    context.save(context.results)
    if request_id:
        context.admin.record_mapping("expected_failure", case.key, request_id)
    if response.status_code < 400:
        raise SamplePopulationError(f"The API accepted a request it must refuse: {case.key}")


def check_rejections(
    results: Sequence[Mapping[str, Any]], audit_rows: Sequence[Mapping[str, Any]]
) -> list[str]:
    """Every planned case ran and matched, and no refused request left an audit row."""
    issues = []
    expected = {case.key for case in (*ACTIVITY_CASES, *CLOSING_CASES)}
    if sorted(str(item.get("case")) for item in results) != sorted(expected):
        issues.append("planned rejections did not all run exactly once")
    if any(item.get("outcome") != "matched" for item in results):
        issues.append("a planned rejection returned an unexpected status or detail")
    refused = {str(item.get("request_id")) for item in results if item.get("request_id")}
    if any(str(row.get("request_id")) in refused for row in audit_rows):
        issues.append("a refused request left audit evidence of a change")
    return issues


def verify_rejections(
    client: SampleClient, *, results: Sequence[Mapping[str, Any]], started_at: str, finished_at: str
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
    return {"planned_rejections_matched": matched}, check_rejections(results, rows)
