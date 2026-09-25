"""Contract tests for bounded Access rule batch commands."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.systems.access.policy.schemas import (
    AccessRuleBatchApplyRequest,
    AccessRuleBatchPreviewRequest,
)


def _create() -> dict[str, object]:
    return {
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


def test_batch_request_is_strict_discriminated_and_bounded() -> None:
    request = AccessRuleBatchPreviewRequest.model_validate(
        {"base_revision": 4, "operations": [_create()]}
    )
    assert request.operations[0].type == "create"

    with pytest.raises(ValidationError):
        AccessRuleBatchPreviewRequest.model_validate({"base_revision": 4, "operations": []})
    with pytest.raises(ValidationError):
        AccessRuleBatchPreviewRequest.model_validate(
            {"base_revision": 4, "operations": [{"type": "move"}]}
        )
    with pytest.raises(ValidationError):
        AccessRuleBatchPreviewRequest.model_validate(
            {"base_revision": 4, "operations": [{**_create(), "unexpected": True}]}
        )


def test_batch_digest_input_preserves_explicit_null_and_normalizes_utc() -> None:
    rule_id = uuid4()
    request = AccessRuleBatchPreviewRequest.model_validate(
        {
            "base_revision": 2,
            "operations": [
                {
                    "type": "update",
                    "rule_id": rule_id,
                    "patch": {
                        "starts_at": datetime(2026, 9, 23, 8, tzinfo=UTC),
                        "ends_at": None,
                    },
                }
            ],
        }
    )

    update = request.operations[0]
    assert update.patch.model_fields_set == {"starts_at", "ends_at"}

    apply = AccessRuleBatchApplyRequest.model_validate(
        {
                **request.model_dump(mode="json", exclude_unset=True),
            "digest": "a" * 64,
        }
    )
    assert apply.digest == "a" * 64
    with pytest.raises(ValidationError):
        AccessRuleBatchApplyRequest.model_validate(
            {**request.model_dump(mode="json", exclude_unset=True), "digest": "not-a-digest"}
        )
