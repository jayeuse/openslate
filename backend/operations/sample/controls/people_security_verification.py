"""Retained People recovery evidence and independent final readback."""

import json
from collections.abc import Callable, Mapping
from typing import Any, cast
from uuid import UUID

import httpx
from pydantic import BaseModel, ValidationError

from app.common.listing import PaginationMetadata, StandardListResponse
from app.systems.access.users.schemas import (
    AuthMeResponse,
    DirectoryRowResponse,
    UserListResponse,
    UserRecoveryResponse,
    UserResponse,
    UserSummaryResponse,
)
from app.systems.access.users.sessions_schemas import AdminSessionListResponse, AdminSessionResponse
from app.systems.manage.audit.schemas import SecurityEventListResponse, SecurityEventResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError

Read = Callable[[str, Mapping[str, Any] | None, str], httpx.Response]


def _require(condition: bool, step: str) -> None:
    if not condition:
        raise SamplePhaseActionError("People control state differs from its contract", step=step)


def _uuid(value: object, step: str) -> str:
    _require(isinstance(value, str), step)
    try:
        parsed = str(UUID(str(value)))
    except ValueError:
        raise SamplePhaseActionError("People control identity is invalid", step=step) from None
    _require(parsed == value, step)
    return parsed


def _dto[T: BaseModel](response: httpx.Response, model: type[T], step: str) -> T:
    _require(response.status_code == 200, step)
    try:
        return model.model_validate_json(response.content, strict=True)
    except ValidationError:
        raise SamplePhaseActionError("People response is invalid", step=step) from None


def _pages[T: BaseModel](
    read: Read, path: str, params: Mapping[str, Any], model: type[T], step: str
) -> tuple[list[T], int]:
    output: list[T] = []
    seen: set[str] = set()
    total: int | None = None
    for index in range(100):
        offset = len(output)
        response = read(path, {**params, "limit": 1, "offset": offset}, f"{step}:{index}")
        schemas: dict[type[BaseModel], type[BaseModel]] = {
            DirectoryRowResponse: UserListResponse,
            AdminSessionResponse: AdminSessionListResponse,
            SecurityEventResponse: SecurityEventListResponse,
        }
        page = cast(StandardListResponse[T], _dto(response, schemas[model], step))
        metadata: PaginationMetadata = page.pagination
        _require(
            metadata.limit == 1
            and metadata.offset == offset
            and metadata.count == len(page.items)
            and metadata.count == min(1, max(metadata.total - offset, 0))
            and metadata.has_more is (metadata.total > offset + metadata.count)
            and (total is None or total == metadata.total),
            step,
        )
        total = metadata.total
        for item in page.items:
            identifier = _uuid(item.model_dump(mode="json").get("id"), step)
            _require(identifier not in seen, step)
            seen.add(identifier)
            output.append(item)
        if not metadata.has_more:
            return output, index + 1
    raise SamplePhaseActionError("People pagination exceeds its finite bound", step=step)


def _person(person: UserResponse | AuthMeResponse, target: str, email: str, step: str) -> None:
    _require(
        str(person.id) == target
        and person.email == email
        and person.role is not None and person.role.value == "member"
        and person.status.value == "active"
        and person.is_deleted is False
        and person.deleted_at is None,
        step,
    )


def _events(
    read: Read,
    receipt: Mapping[str, Any],
    descriptor: Mapping[str, Any],
    admin_id: str,
    target: str,
    revoke: bool,
) -> tuple[list[str], int]:
    operation = _uuid(receipt.get("operation_id"), "people_events")
    rows, pages = _pages(
        read,
        "/api/security-events",
        {
            "operation_id": operation,
            "person_id": target,
            "event_type": "identity.recovery",
            "sort_by": "occurred_at",
            "sort_order": "asc",
        },
        SecurityEventResponse,
        "people_events:" + operation,
    )
    _require(
        len(rows) == 2 and {r.outcome.value for r in rows} == {"attempt", "success"},
        "people_events",
    )
    for row in rows:
        success = row.outcome.value == "success"
        metadata = {
            "email_request": "accepted" if success else "not_attempted",
            "local_revocation": "committed"
            if revoke and success
            else "unconfirmed"
            if revoke
            else "not_requested",
            "revoked_sessions": receipt["revoked_sessions"] if revoke and success else 0,
            "factors_cleared": None,
        }
        _require(
            row.event_type == "identity.recovery"
            and row.source == "access.users"
            and str(row.operation_id) == operation
            and str(row.actor_id) == admin_id
            and str(row.subject_id) == target
            and str(row.request_id) == descriptor["request_id"]
            and row.request_method == "POST"
            and row.request_path == descriptor["path"]
            and row.metadata == metadata
            and all(type(row.metadata.get(k)) is type(v) for k, v in metadata.items()),
            "people_events",
        )
        detail = _dto(
            read(f"/api/security-events/{row.id}", None, f"people_event_detail:{row.id}"),
            SecurityEventResponse,
            "people_event_detail",
        )
        _require(detail == row, "people_event_detail")
    return [str(row.id) for row in rows], pages


def _request_contract(
    action: PhaseAction,
    result: Mapping[str, Any],
    target: str,
) -> dict[str, tuple[str, str, str]]:
    summary = UserSummaryResponse.model_validate_json(
        json.dumps(result.get("summary")), strict=True
    )
    _require(summary.inactive_days == 30 and summary.as_of.tzinfo is not None, "people_result")
    categories = {
        "without": summary.admins_without_mfa,
        "unknown": summary.admins_mfa_unknown,
        "no-recorded-sign-in": summary.no_recorded_sign_in,
        "inactive": summary.inactive_people,
    }
    pages = result.get("directory_pages")
    _require(
        isinstance(pages, Mapping)
        and set(pages) == set(categories)
        and all(
            type(pages[k]) is int and pages[k] == max(1, n) and pages[k] <= 100
            for k, n in categories.items()
        ),
        "people_result",
    )
    pages = cast(Mapping[str, int], pages)
    captured = result.get("captured_session_ids")
    _require(isinstance(captured, list) and 1 <= len(captured) <= 100, "people_result")
    captured = cast(list[Any], captured)
    _require(len({_uuid(v, "people_result") for v in captured}) == len(captured), "people_result")
    expected = {
        "people_owner": ("admin", "GET", "/api/auth/me"),
        "people_target": ("admin", "GET", f"/api/users/{target}"),
        "people_security": ("admin", "GET", f"/api/users/{target}/security"),
        "people_summary": ("admin", "GET", "/api/users/summary"),
        "people_primary_revoked": (action.target_key, "GET", "/api/auth/session"),
        "people_restore_primary": (action.target_key, "POST", "/api/auth/login"),
    }
    for category in categories:
        for index in range(pages[category]):
            expected[f"people_directory:{category}:{index}"] = ("admin", "GET", "/api/users")
    for prefix in ("people_primary_before", "people_primary_preserved", "people_primary_restored"):
        expected[prefix] = (action.target_key, "GET", "/api/auth/session")
        expected[prefix + ":me"] = (action.target_key, "GET", "/api/auth/me")
    for prefix, count in (
        ("people_sessions_before", len(captured)),
        ("people_sessions_after:false", len(captured)),
        ("people_sessions_after:true", 1),
    ):
        for index in range(count):
            expected[f"{prefix}:{index}"] = ("admin", "GET", f"/api/users/{target}/sessions")
    receipts = result.get("recoveries")
    _require(isinstance(receipts, list) and len(receipts) == 2, "people_receipts")
    receipts = cast(list[Any], receipts)
    operations: set[str] = set()
    event_ids: set[str] = set()
    for revoke, receipt in zip((False, True), receipts, strict=True):
        _require(isinstance(receipt, Mapping), "people_receipts")
        body = {
            key: receipt.get(key)
            for key in (
                "operation_id",
                "user_id",
                "email_request",
                "local_revocation",
                "revoked_sessions",
            )
        }
        parsed = UserRecoveryResponse.model_validate_json(json.dumps(body), strict=True)
        operation = str(parsed.operation_id)
        _require(
            operation not in operations
            and receipt.get("revoke_sessions") is revoke
            and str(parsed.user_id) == target
            and parsed.local_revocation == ("committed" if revoke else "not_requested")
            and (
                parsed.revoked_sessions is not None and parsed.revoked_sessions >= len(captured)
                if revoke
                else parsed.revoked_sessions is None
            )
            and type(receipt.get("event_pages")) is int
            and receipt["event_pages"] == 2,
            "people_receipts",
        )
        operations.add(operation)
        identifiers = receipt.get("event_ids")
        _require(isinstance(identifiers, list) and len(identifiers) == 2, "people_receipts")
        for identifier in identifiers:
            identifier = _uuid(identifier, "people_receipts")
            _require(identifier not in event_ids, "people_receipts")
            event_ids.add(identifier)
            expected[f"people_event_detail:{identifier}"] = (
                "admin",
                "GET",
                f"/api/security-events/{identifier}",
            )
        for index in range(2):
            expected[f"people_events:{operation}:{index}"] = (
                "admin",
                "GET",
                "/api/security-events",
            )
        expected["people_recovery:" + str(revoke).lower()] = (
            "admin",
            "POST",
            f"/api/users/{target}/recovery",
        )
    return expected


def verify_people_security_evidence(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.controls.people_security import plan_people_security_controls

    try:
        _require(action in plan_people_security_controls(dataset), "people_result")
        actors = manifest.get("actor_ids")
        mappings = manifest.get("mappings")
        users = mappings.get("user") if isinstance(mappings, Mapping) else None
        target = _uuid(result.get("target_id"), "people_result")
        _require(
            isinstance(actors, Mapping)
            and isinstance(users, Mapping)
            and actors.get(action.target_key) == users.get(action.target_key) == target
            and target != admin_id
            and result.get("actor_id") == admin_id
            and result.get("action_key") == action.key
            and result.get("actor_key") == "admin"
            and result.get("target_key") == action.target_key
            and result.get("outcome") == "completed"
            and result.get("primary_session_authenticated") is True
            and result.get("recoveries_verified") == 2,
            "people_result",
        )
        rows = result.get("request_evidence")
        _require(isinstance(rows, list) and bool(rows), "people_requests")
        rows = cast(list[Any], rows)
        expected = _request_contract(action, result, target)
        steps: set[str] = set()
        writes: list[str] = []
        for row in rows:
            _require(isinstance(row, Mapping), "people_requests")
            request_id = _uuid(row.get("request_id"), "people_requests")
            actor = row.get("actor_key")
            step = row.get("step")
            _require(
                isinstance(step, str) and step in expected and step not in steps, "people_requests"
            )
            steps.add(step)
            _require(
                set(row)
                == {
                    "step",
                    "actor_key",
                    "actor_id",
                    "method",
                    "path",
                    "expected_status",
                    "status_code",
                    "request_id",
                }
                and actor in {"admin", action.target_key}
                and row.get("actor_id") == (admin_id if actor == "admin" else target)
                and type(row.get("status_code")) is int
                and type(row.get("expected_status")) is int
                and row["status_code"] == row["expected_status"] == 200
                and request_id not in seen_request_ids,
                "people_requests",
            )
            seen_request_ids.add(request_id)
            _require(
                (actor, row.get("method"), row.get("path")) == expected[step], "people_requests"
            )
            if row.get("method") == "POST":
                writes.append(row.get("step"))
                _require(
                    (actor == "admin" and row.get("path") == f"/api/users/{target}/recovery")
                    or (actor == action.target_key and row.get("path") == "/api/auth/login"),
                    "people_requests",
                )
            else:
                _require(row.get("method") == "GET", "people_requests")
        _require(
            writes == ["people_recovery:false", "people_recovery:true", "people_restore_primary"],
            "people_requests",
        )
        _require(steps == set(expected), "people_requests")
        observed["control_requests_verified"] = observed.get("control_requests_verified", 0) + len(
            rows
        )
    except (SamplePhaseActionError, KeyError, TypeError, ValueError):
        issues.append("People control plan, identity or retained request evidence differs")


def verify_people_security_controls(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    from operations.sample.controls.people_security import plan_people_security_controls

    counts = {"people_recoveries_verified": 0, "control_requests_verified": 0}
    issues: list[str] = []
    action = plan_people_security_controls(dataset)[0]
    raw = manifest.get("control_results")
    results = (
        [r for r in raw if isinstance(r, Mapping) and r.get("action_key") == action.key]
        if isinstance(raw, list)
        else []
    )
    if len(results) != 1:
        return counts, ["People control result is missing or duplicated"]
    result = results[0]
    verify_people_security_evidence(
        dataset, manifest, action, result, admin_id, set(), counts, issues
    )
    if issues:
        return counts, issues

    def read(path: str, params: Mapping[str, Any] | None, step: str) -> httpx.Response:
        return client.request("GET", path, params=params)

    try:
        target = result["target_id"]
        person = next(p for p in dataset.organization.actors.people if p.key == action.target_key)
        _person(
            _dto(read(f"/api/users/{target}", None, "people_final"), UserResponse, "people_final"),
            target,
            person.email,
            "people_final",
        )
        for receipt in result["recoveries"]:
            descriptor = next(
                r
                for r in result["request_evidence"]
                if r["step"] == f"people_recovery:{str(receipt['revoke_sessions']).lower()}"
            )
            identifiers, _ = _events(
                read, receipt, descriptor, admin_id, target, receipt["revoke_sessions"]
            )
            _require(identifiers == receipt["event_ids"], "people_final_events")
            counts["people_recoveries_verified"] += 1
    except (
        SampleClientError,
        SamplePhaseActionError,
        KeyError,
        TypeError,
        ValueError,
        StopIteration,
    ):
        issues.append("People final identity or recovery events differ from actual receipts")
    return counts, issues
