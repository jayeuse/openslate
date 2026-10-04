"""Context and safe request primitives for one planned phase action."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import UUID

import httpx

from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset

PhaseSubstep = Callable[[str], None]


class SamplePhaseActionError(RuntimeError):
    """A safe phase failure containing no response body or secret value."""

    def __init__(
        self,
        message: str,
        *,
        step: str,
        status_code: int | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.step = step
        self.status_code = status_code
        self.request_id = request_id


@dataclass
class PhaseExecutionContext:
    """Live identities and logical mappings retained only for one run."""

    clients: Mapping[str, SampleClient]
    user_ids: Mapping[str, str]
    group_ids: Mapping[str, str]
    department_ids: Mapping[str, str]
    module_ids: Mapping[str, str]
    field_ids: Mapping[str, str]
    mappings: Mapping[str, Mapping[str, str]]
    admin_password: str = field(repr=False)
    runtime_mappings: dict[str, dict[str, str]] = field(default_factory=dict)
    private_values: dict[str, Any] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        if not self.runtime_mappings:
            self.runtime_mappings = {kind: dict(values) for kind, values in self.mappings.items()}


def _client(context: PhaseExecutionContext, actor_key: str, *, step: str) -> SampleClient:
    client = context.clients.get(actor_key)
    if client is None:
        raise SamplePhaseActionError(f"Planned phase actor is unavailable: {actor_key}", step=step)
    return client


def _id(values: Mapping[str, object], key: str, *, label: str, step: str) -> str:
    value = values.get(key)
    if not isinstance(value, str):
        raise SamplePhaseActionError(f"Planned {label} mapping is missing or invalid", step=step)
    try:
        return str(UUID(value))
    except ValueError:
        raise SamplePhaseActionError(
            f"Planned {label} mapping is missing or invalid", step=step
        ) from None


def _mapped_id(context: PhaseExecutionContext, kind: str, logical_id: str, *, step: str) -> str:
    bucket = context.runtime_mappings.get(kind, {})
    if logical_id in bucket:
        return _id(bucket, logical_id, label=kind, step=step)
    direct: Mapping[str, str] | None = {
        "user": context.user_ids,
        "group": context.group_ids,
        "department": context.department_ids,
        "modules": context.module_ids,
        "fields": context.field_ids,
    }.get(kind)
    if direct is not None:
        return _id(direct, logical_id, label=kind, step=step)
    raise SamplePhaseActionError(f"Planned {kind} mapping is missing or invalid", step=step)


def _request_id(response: httpx.Response) -> str | None:
    try:
        return str(UUID(response.headers.get("X-Request-ID", "")))
    except ValueError:
        return None


def _read_json(
    response: httpx.Response,
    *,
    step: str,
    request_id: str | None = None,
) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        raise SamplePhaseActionError(
            "The planned phase response was not valid JSON",
            step=step,
            status_code=response.status_code,
            request_id=request_id,
        ) from None
    if not isinstance(body, dict):
        raise SamplePhaseActionError(
            "The planned phase response was not an object",
            step=step,
            status_code=response.status_code,
            request_id=request_id,
        )
    return body


def _error_detail(response: httpx.Response) -> str | None:
    if (
        response.headers.get("content-type", "").partition(";")[0].strip().lower()
        != "application/json"
        or len(response.content) > 512
    ):
        return None
    try:
        payload = response.json()
    except ValueError:
        return None
    detail = payload.get("detail") if isinstance(payload, dict) else None
    return detail if isinstance(detail, str) else None


def _request(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    actor_key: str,
    method: str,
    path: str,
    step: str,
    expected: int,
    on_substep: PhaseSubstep | None,
    json_body: Mapping[str, Any] | None = None,
    params: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
    expected_detail: str | None = None,
    primary_entity_type: str | None = None,
    primary_entity_id: str | None = None,
    primary_action: str | None = None,
    expected_audit_rows: int | None = None,
    related_entity_types: tuple[str, ...] = (),
    refresh_first: bool = True,
) -> httpx.Response:
    if on_substep is not None:
        on_substep(step)
    client = _client(context, actor_key, step=step)
    actor_id = _id(context.user_ids, actor_key, label="user", step=step)
    response = client.request(
        method,
        path,
        json_body=json_body,
        params=params,
        headers=headers,
        refresh_first=refresh_first,
    )
    request_id = _request_id(response)
    is_write = method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
    if is_write:
        evidence.append(
            {
                "step": step,
                "actor_key": actor_key,
                "actor_id": actor_id,
                "method": method.upper(),
                "path": path,
                "expected_status": expected,
                "status_code": response.status_code,
                "request_id": request_id,
                "primary_entity_type": primary_entity_type,
                "primary_entity_id": primary_entity_id,
                "primary_action": primary_action,
                "expected_audit_rows": expected_audit_rows or 0,
                "related_entity_types": list(related_entity_types),
            }
        )
    if response.status_code != expected:
        raise SamplePhaseActionError(
            f"Planned phase request returned HTTP {response.status_code}",
            step=step,
            status_code=response.status_code,
            request_id=request_id,
        )
    if expected_detail is not None and _error_detail(response) != expected_detail:
        raise SamplePhaseActionError(
            "Planned refusal returned an unexpected response",
            step=step,
            status_code=response.status_code,
            request_id=request_id,
        )
    if is_write and request_id is None:
        raise SamplePhaseActionError(
            "Mutation response did not include its request ID for audit reconciliation",
            step=step,
            status_code=response.status_code,
        )
    return response


def _request_object(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    actor_key: str,
    path: str,
    step: str,
    on_substep: PhaseSubstep | None,
    params: Mapping[str, Any] | None = None,
    refresh_first: bool = True,
) -> dict[str, Any]:
    response = _request(
        action,
        context,
        evidence,
        actor_key=actor_key,
        method="GET",
        path=path,
        step=step,
        expected=200,
        on_substep=on_substep,
        params=params,
        refresh_first=refresh_first,
    )
    return _read_json(response, step=step, request_id=_request_id(response))


def _record_mapping(
    context: PhaseExecutionContext,
    client: SampleClient,
    kind: str,
    logical_id: str,
    server_id: str,
    output: list[dict[str, str]],
) -> None:
    normalized = _id({logical_id: server_id}, logical_id, label=kind, step="record_mapping")
    client.record_mapping(kind, logical_id, normalized)
    context.runtime_mappings.setdefault(kind, {})[logical_id] = normalized
    output.append({"kind": kind, "logical_id": logical_id, "server_id": normalized})


def _result(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    outcome: str = "completed",
    extra: Mapping[str, object] | None = None,
) -> dict[str, object]:
    result: dict[str, object] = {
        "action_key": action.key,
        "actor_key": action.actor_key,
        "actor_id": _id(context.user_ids, action.actor_key, label="user", step=action.key),
        "target_key": action.target_key,
        "outcome": outcome,
        "request_evidence": evidence,
        "mappings": mappings,
    }
    if extra:
        result.update(extra)
    return result


def execute_phase_action(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    """Execute exactly one planned action; unknown writes propagate without replay."""
    if action.kind.endswith("_controls"):
        from operations.sample.controls.actions import execute_control_action

        return execute_control_action(action, dataset, context, on_substep=on_substep)
    if action.kind.startswith("sandbox_"):
        from operations.sample.phases.design import execute_design_phase_action

        return execute_design_phase_action(action, dataset, context, on_substep=on_substep)
    from operations.sample.phases.action_routes import execute_route_phase_action

    return execute_route_phase_action(action, context, on_substep=on_substep)
