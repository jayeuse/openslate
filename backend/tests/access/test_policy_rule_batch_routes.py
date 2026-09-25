"""HTTP contracts for Access rule batch preview and apply."""

from importlib import import_module
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import Response

from app.main import create_app
from app.systems.access.policy import router as policy_router
from app.systems.access.policy.rule_batch_router import router as batch_router
from app.systems.access.policy.rule_batch_service import RuleBatchApplyResult, RuleBatchPlan
from app.systems.access.policy.rules_router import router as management_router
from app.systems.access.policy.schemas import AccessRuleBatchBlocker, AccessRuleBatchCounts


def _preview_payload() -> dict[str, object]:
    return {
        "base_revision": 3,
        "operations": [
            {
                "type": "create",
                "rule": {
                    "subject_kind": "everyone",
                    "subject_id": None,
                    "scope_kind": "workspace",
                    "scope_id": None,
                    "permission_id": "records.read",
                    "decision": "allow",
                },
            }
        ],
    }


def test_batch_routes_register_before_dynamic_rule_route_with_conditional_openapi() -> None:
    app = create_app()
    paths = app.openapi()["paths"]
    preview = "/api/access/rules/impact-preview"
    apply = "/api/access/rules/apply"
    dynamic = "/api/access/rules/{rule_id}"

    assert {preview, apply, dynamic} <= set(paths)
    assert "ETag" in paths[preview]["post"]["responses"]["200"]["headers"]
    assert "ETag" in paths[apply]["post"]["responses"]["200"]["headers"]
    assert {"409", "412", "428"} <= set(paths[apply]["post"]["responses"])
    for response_code in ("409", "412", "428"):
        assert "ETag" in paths[apply]["post"]["responses"][response_code]["headers"]
    assert "ETag" in paths[preview]["post"]["responses"]["409"]["headers"]
    included = [route.original_router for route in policy_router.routes]
    assert included.index(batch_router) < included.index(management_router)


def test_preview_and_apply_are_private_exact_admin_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    router = import_module("app.systems.access.policy.rule_batch_router")
    db = Mock()
    admin = SimpleNamespace(id=uuid4())
    payload = router.AccessRuleBatchPreviewRequest.model_validate(_preview_payload())
    plan = RuleBatchPlan(
        revision=3,
        digest="a" * 64,
        items=(),
        blockers=(
            AccessRuleBatchBlocker(
                operation_index=0,
                code="reference_unavailable",
                message="Rule subject or scope is unavailable",
            ),
        ),
        counts=AccessRuleBatchCounts(created=1, updated=0, deleted=0, unchanged=0),
        affected_principals=None,
    )
    calls: list[object] = []
    monkeypatch.setattr(router, "require_fresh_exact_admin", lambda *_args: calls.append("admin"))
    monkeypatch.setattr(
        router,
        "preview_rule_batch",
        lambda *_args: calls.append("preview") or plan,
    )
    monkeypatch.setattr(
        router,
        "apply_rule_batch",
        lambda *_args, **kwargs: calls.append(kwargs) or RuleBatchApplyResult(
            revision=4,
            digest="a" * 64,
            counts=AccessRuleBatchCounts(created=1, updated=0, deleted=0, unchanged=0),
            affected_principals=2,
        ),
    )

    preview_response = Response()
    preview = router.preview_rule_batch_route(payload, admin, db, preview_response)
    assert preview.can_apply is False
    assert preview.blockers[0].code == "reference_unavailable"
    assert preview_response.headers["ETag"] == '"workspace:3"'
    assert preview_response.headers["Cache-Control"] == "private, no-store"

    apply_payload = router.AccessRuleBatchApplyRequest.model_validate(
        {**_preview_payload(), "digest": "a" * 64}
    )
    apply_response = Response()
    applied = router.apply_rule_batch_route(
        apply_payload,
        admin,
        db,
        apply_response,
        '"workspace:3"',
    )
    assert applied.current_revision == 4
    assert apply_response.headers["ETag"] == '"workspace:4"'
    assert apply_response.headers["Cache-Control"] == "private, no-store"
    assert calls == [
        "admin",
        "preview",
        "admin",
        {"digest": "a" * 64, "if_match": '"workspace:3"', "actor_id": admin.id},
    ]
