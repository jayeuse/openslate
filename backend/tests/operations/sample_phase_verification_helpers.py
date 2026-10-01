"""Transport and audit fixtures for the phase verifier's offline regressions."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy.orm import Session

from app.common.dependencies import CurrentIdentity
from app.core.middleware.request_context import (
    RequestContext,
    bind_request_context,
    reset_request_context,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users import sessions_router
from app.systems.access.users.models import User
from app.systems.manage.audit.listeners import _is_audited
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.audit.schemas import SecurityEventResponse
from operations.sample_client import SampleClient
from operations.sample_packs.phase_types import PhaseAction

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
MEMBER_ID = "9ec0d287-ae14-4603-91c2-f9a4d7b73c0a"
DOCUMENT_AUDIT_ID = "389d3df3-0527-4b50-88c1-fcb64b854782"


def _server_revocation_event(
    monkeypatch: pytest.MonkeyPatch,
    *,
    actor_id: str,
    person_id: str,
    session_id: str,
    request_id: str,
) -> dict[str, Any]:
    """Capture the real route's event writer with storage/auth lookup boundaries only."""
    session = IdentitySession(id=UUID(session_id), user_id=UUID(person_id), revoked_at=None)
    target = User(id=UUID(person_id))
    identity = CurrentIdentity(
        user=User(id=UUID(actor_id)),
        session_id=uuid4(),
        cookie_authenticated=True,
        setup_only=False,
    )

    class Capture:
        def __init__(self) -> None:
            self.events: list[SecurityEvent] = []
            self.committed = False

        def get(
            self, model: type[IdentitySession], key: UUID, *, with_for_update: bool
        ) -> IdentitySession:
            assert model is IdentitySession and key == session.id and with_for_update
            return session

        def add(self, event: SecurityEvent) -> None:
            assert isinstance(event, SecurityEvent)
            self.events.append(event)

        def commit(self) -> None:
            self.committed = True

    capture = Capture()
    path = f"/api/users/{person_id}/sessions/{session_id}"
    token = bind_request_context(
        RequestContext(request_id=UUID(request_id), method="DELETE", path=path)
    )
    try:
        with monkeypatch.context() as lookup:
            lookup.setattr(sessions_router, "_require_admin", lambda _identity, _db: UUID(actor_id))
            lookup.setattr(sessions_router, "load_user", lambda _db, _user_id: target)
            response = sessions_router.revoke_user_session(
                UUID(person_id), UUID(session_id), identity, cast(Session, capture)
            )
    finally:
        reset_request_context(token)
    assert response.status_code == 204 and session.revoked_at is not None
    assert capture.committed and len(capture.events) == 1
    assert _is_audited(session) is False
    return SecurityEventResponse.model_validate(capture.events[0]).model_dump(
        mode="json", by_alias=True
    )


def _request(
    action: PhaseAction,
    step: str,
    method: str,
    path: str,
    *,
    actor: str | None = None,
    status: int | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    audit: str | None = None,
    audit_count: int = 0,
    related: list[str] | None = None,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    actor = actor or action.actor_key
    evidence: dict[str, object] = {
        "step": step,
        "actor_key": actor,
        "actor_id": ADMIN_ID if actor == "admin" else MEMBER_ID,
        "method": method,
        "path": path,
        "status_code": status or action.expected_status,
        "expected_status": status or action.expected_status,
        "request_id": str(uuid4()),
    }
    evidence.update(
        {
            "primary_entity_type": entity,
            "primary_entity_id": entity_id,
            "primary_action": audit,
            "expected_audit_rows": audit_count,
            "related_entity_types": related or [],
        }
    )
    rows = (
        [
            {
                "action": audit,
                "entity_type": entity,
                "entity_id": DOCUMENT_AUDIT_ID if entity == "sandbox_documents" else entity_id,
                "performed_by": evidence["actor_id"],
                "request_id": evidence["request_id"],
                "request_method": method,
                "request_path": path,
            }
        ]
        if audit_count
        else []
    )
    return evidence, rows


def _request_spec(
    action: PhaseAction, spec: str
) -> tuple[dict[str, object], list[dict[str, object]]]:
    step, method, path, status, entity, entity_id, audit, count, actor = spec.split("|")
    related = ["identity_sessions"] if entity == "users" and action.kind == "disable_user" else []
    if entity == "sandbox_versions":
        related = ["sandbox_publications"]
    return _request(
        action,
        step,
        method,
        path,
        actor=actor,
        status=int(status),
        entity=entity or None,
        entity_id=entity_id or None,
        audit=audit or None,
        audit_count=int(count),
        related=related,
    )


def _list_payload(request: httpx.Request, rows: list[dict[str, object]]) -> dict[str, object]:
    offset = int(request.url.params.get("offset", "0"))
    limit = int(request.url.params.get("limit", "100"))
    items = rows[offset : offset + limit]
    return {
        "items": items,
        "pagination": {
            "offset": offset,
            "limit": limit,
            "count": len(items),
            "total": len(rows),
            "has_more": offset + len(items) < len(rows),
        },
    }


def _client(
    tmp_path: Path,
    audits: Mapping[str, list[dict[str, object]]],
    reads: Mapping[str, object] | None = None,
) -> SampleClient:
    reads = reads or {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/audit-logs":
            rows = audits.get(request.url.params.get("request_id", ""), [])
            return httpx.Response(200, json=_list_payload(request, rows))
        result = reads.get(request.url.path)
        if isinstance(result, httpx.Response):
            return result
        if result is None:
            return httpx.Response(404)
        if isinstance(result, list):
            return httpx.Response(200, json=_list_payload(request, result))
        return httpx.Response(200, json=result)

    return SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "phase-verification-requests.jsonl",
        transport=httpx.MockTransport(handler),
    )
