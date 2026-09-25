from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.systems.access.policy.schemas import (
    AccessRuleCreate,
    AccessRuleDecision,
    AccessRuleListRequest,
    AccessRuleResponse,
    AccessRuleScopeKind,
    AccessRuleSubjectKind,
    AccessRuleUpdate,
)
from app.systems.access.users.permissions import Capability


def _rule() -> dict[str, object]:
    return {
        "subject_kind": "everyone",
        "subject_id": None,
        "scope_kind": "workspace",
        "scope_id": None,
        "permission_id": "records.read",
        "decision": "allow",
    }


def test_rule_create_is_strict_and_validates_shapes_capability_and_window() -> None:
    rule = _rule()
    created = AccessRuleCreate.model_validate({**rule, "locked": True})
    assert created.decision is AccessRuleDecision.ALLOW
    assert created.locked is True
    for invalid in (
        {**rule, "unexpected": True},
        {**rule, "subject_id": uuid4()},
        {**rule, "scope_id": uuid4()},
        {**rule, "permission_id": "boards.read"},
        {**rule, "decision": "maybe"},
        {**rule, "starts_at": datetime.now()},
    ):
        with pytest.raises(ValidationError):
            AccessRuleCreate.model_validate(invalid)
    start = datetime.now(UTC)
    with pytest.raises(ValidationError):
        AccessRuleCreate.model_validate({**rule, "starts_at": start, "ends_at": start})
    assert AccessRuleCreate.model_validate(
        {**rule, "starts_at": start, "ends_at": start + timedelta(minutes=1)}
    ).scope_kind is AccessRuleScopeKind.WORKSPACE


def test_rule_update_distinguishes_omission_from_explicit_null() -> None:
    with pytest.raises(ValidationError):
        AccessRuleUpdate.model_validate({})
    with pytest.raises(ValidationError):
        AccessRuleUpdate.model_validate({"decision": None})
    assert AccessRuleUpdate.model_validate({"decision": "deny"}).model_fields_set == {"decision"}
    assert AccessRuleUpdate.model_validate(
        {"subject_kind": "everyone", "subject_id": None}
    ).subject_id is None
    assert AccessRuleUpdate.model_validate(
        {"scope_kind": "workspace", "scope_id": None}
    ).scope_id is None
    cleared_patch = AccessRuleUpdate.model_validate({"starts_at": None, "ends_at": None})
    assert cleared_patch.model_fields_set == {"starts_at", "ends_at"}
    with pytest.raises(ValidationError):
        AccessRuleUpdate.model_validate({"starts_at": datetime.now()})
    current = AccessRuleCreate.model_validate(
        {
            **_rule(),
            "starts_at": datetime.now(UTC),
            "ends_at": datetime.now(UTC) + timedelta(days=1),
        }
    )
    cleared_rule = cleared_patch.merge_with(current)
    assert cleared_rule.starts_at is None
    assert cleared_rule.ends_at is None
    with pytest.raises(ValidationError):
        AccessRuleUpdate.model_validate({"subject_kind": "group"}).merge_with(current)
    with pytest.raises(ValidationError):
        AccessRuleUpdate.model_validate({"scope_kind": "department"}).merge_with(current)


def test_rule_list_filters_are_typed() -> None:
    subject_id = uuid4()
    scope_id = uuid4()
    params = AccessRuleListRequest.model_validate(
        {
            "subject_kind": "service",
            "subject_id": subject_id,
            "scope_kind": "field",
            "scope_id": scope_id,
            "decision": "inherit",
            "locked": True,
        }
    )
    assert params.subject_kind is AccessRuleSubjectKind.SERVICE
    assert params.subject_id == subject_id
    assert params.scope_id == scope_id
    assert params.locked is True
    with pytest.raises(ValidationError):
        AccessRuleListRequest.model_validate({"subject_kind": "admin"})
    for capability in Capability:
        assert AccessRuleCreate.model_validate(
            {**_rule(), "permission_id": capability.value}
        ).permission_id is capability
    with pytest.raises(ValidationError):
        AccessRuleListRequest.model_validate({"permission_id": "boards.read"})
    permission_schema = AccessRuleCreate.model_json_schema()["properties"]["permission_id"]
    assert permission_schema == {"$ref": "#/$defs/Capability"}
    assert AccessRuleCreate.model_json_schema()["$defs"]["Capability"]["enum"] == [
        capability.value for capability in Capability
    ]


def test_rule_response_revalidates_full_state_and_positive_version() -> None:
    now = datetime.now(UTC)
    response = {
        **_rule(),
        "locked": False,
        "starts_at": None,
        "ends_at": None,
        "id": uuid4(),
        "policy_version": 1,
        "created_at": now,
        "updated_at": now,
        "deleted_at": None,
        "is_deleted": False,
        "performed_by": None,
    }
    assert AccessRuleResponse.model_validate(response).policy_version == 1
    response_schema = AccessRuleResponse.model_json_schema()
    for field in ("subject_id", "scope_id", "starts_at", "ends_at", "locked"):
        assert field in response_schema["required"]
        with pytest.raises(ValidationError):
            AccessRuleResponse.model_validate(
                {key: value for key, value in response.items() if key != field}
            )
    with pytest.raises(ValidationError):
        AccessRuleResponse.model_validate({**response, "policy_version": 0})
    with pytest.raises(ValidationError):
        AccessRuleResponse.model_validate(
            {**response, "subject_kind": "group", "subject_id": None}
        )
