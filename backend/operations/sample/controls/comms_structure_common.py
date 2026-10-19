"""Observed HTTP and shape/identity checks shared by the two owned structure journeys."""

from dataclasses import replace
from typing import Any

import httpx
from pydantic import TypeAdapter, ValidationError

from app.common.listing import StandardListResponse
from app.systems.comms.conversations.schemas import DirectBlockResponse, MemberResponse
from app.systems.comms.messages.schemas import Category, Conversation
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _read_json,
    _record_mapping,
    _request,
)

CONVERSATION: TypeAdapter[Any] = TypeAdapter(Conversation)
PAGES: dict[str, TypeAdapter[Any]] = {
    "category": TypeAdapter(StandardListResponse[Category]),
    "conversation": TypeAdapter(StandardListResponse[Conversation]),
    "member": TypeAdapter(StandardListResponse[MemberResponse]),
    "block": TypeAdapter(StandardListResponse[DirectBlockResponse]),
}


def member_keys(action: PhaseAction) -> tuple[str, str]:
    values = action.values["member_keys"]
    if (
        not isinstance(values, list)
        or len(values) != 2
        or not all(isinstance(key, str) for key in values)
    ):
        raise SamplePhaseActionError("Invalid planned member keys", step=action.key)
    left, right = values
    assert isinstance(left, str) and isinstance(right, str)
    return left, right


def bound_context(
    context: PhaseExecutionContext, clients: dict[str, SampleClient]
) -> PhaseExecutionContext:
    value = replace(context, clients=clients)
    value.runtime_mappings = context.runtime_mappings
    return value


class StructureRun:
    def __init__(
        self, action: PhaseAction, context: PhaseExecutionContext, on_substep: PhaseSubstep | None
    ) -> None:
        self.action, self.context, self.on_substep = action, context, on_substep
        self.client = context.clients["admin"]
        self.org = _id(
            {"org": self.client.organization_id}, "org", label="organization", step=action.key
        )
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []

    def call(
        self,
        method: str,
        path: str,
        step: str,
        expected: int = 200,
        actor: str = "admin",
        **kwargs: Any,
    ) -> httpx.Response:
        return _request(
            self.action,
            self.context,
            self.evidence,
            actor_key=actor,
            method=method,
            path=path,
            step=step,
            expected=expected,
            on_substep=self.on_substep,
            **kwargs,
        )

    def resource(self, response: httpx.Response, kind: str, step: str) -> dict[str, Any]:
        try:
            row = (
                Category.model_validate_json(response.content)
                if kind == "category"
                else CONVERSATION.validate_json(response.content)
            )
        except ValidationError as exc:
            raise SamplePhaseActionError("Invalid structure response", step=step) from exc
        tag = response.headers.get("ETag", "")
        if str(row.org_id) != self.org or not (
            tag.startswith('"') and tag.endswith('"') and len(tag) > 2
        ):
            raise SamplePhaseActionError("Structure identity or validator differs", step=step)
        return row.model_dump(mode="json")

    def create(
        self, path: str, kind: str, key: str, body: dict[str, Any], step: str
    ) -> dict[str, Any]:
        entity = "comms_categories" if kind == "category" else "comms_conversations"
        response = self.call(
            "POST",
            path,
            step,
            201,
            json_body=body,
            primary_entity_type=entity,
            primary_action="create",
            expected_audit_rows=1,
            related_entity_types=(
                "comms_members",
                "comms_conversation_groups",
                "comms_settings",
                "comms_capability_grants",
            ),
        )
        row = self.resource(response, kind, step)
        location = "/api/comms/categories/" if kind == "category" else "/api/comms/conversations/"
        if response.headers.get("Location") != location + row["id"]:
            raise SamplePhaseActionError("Structure location differs", step=step)
        self.evidence[-1]["primary_entity_id"] = row["id"]
        _record_mapping(self.context, self.client, entity, key, row["id"], self.mappings)
        return row

    def get(
        self, path: str, kind: str = "conversation", *, actor: str = "admin"
    ) -> tuple[dict[str, Any], str]:
        response = self.call("GET", path, "read_structure", actor=actor)
        row = self.resource(response, kind, "read_structure")
        if path.rsplit("/", 1)[-1] != row["id"]:
            raise SamplePhaseActionError(
                "Structure readback identity differs", step="read_structure"
            )
        return row, response.headers["ETag"]

    def page(self, path: str, kind: str, **kwargs: Any) -> list[dict[str, Any]]:
        response = self.call("GET", path, "list_structure", **kwargs)
        try:
            page = PAGES[kind].validate_json(response.content)
        except ValidationError as exc:
            raise SamplePhaseActionError("Invalid structure page", step="list_structure") from exc
        if kind in ("conversation", "category") and any(
            str(row.org_id) != self.org for row in page.items
        ):
            raise SamplePhaseActionError(
                "Structure page organization differs", step="list_structure"
            )
        return [row.model_dump(mode="json") for row in page.items]

    def identity(self, actor: str = "admin") -> None:
        row = _read_json(
            self.call("GET", "/api/auth/me", "bound_identity", actor=actor), step="bound_identity"
        )
        if (
            row.get("id") != self.context.user_ids[actor]
            or row.get("current_organization", {}).get("org_id") != self.org
        ):
            raise SamplePhaseActionError("Bound partner identity differs", step="bound_identity")


def check(condition: bool, step: str) -> None:
    if not condition:
        raise SamplePhaseActionError("Structure readback differs", step=step)
