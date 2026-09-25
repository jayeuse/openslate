"""Policy authorization boundaries for durable automation execution."""

from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import HTTPException, status
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.automations.publisher_policy as publisher_policy
import app.systems.sandbox.automations.runner as runner
from app.systems.access.policy.authorization import WorkspaceRoleChanged
from app.systems.access.users.permissions import Capability
from app.systems.sandbox.automations.execution import ClaimedAutomationEvent
from app.systems.sandbox.automations.models import (
    AutomationEventState,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records.models import Record


def _publishers() -> dict[UUID, publisher_policy.CandidatePublisher]:
    first_definition_id = uuid7()
    second_definition_id = uuid7()
    return {
        first_definition_id: publisher_policy.CandidatePublisher(uuid7(), uuid7()),
        second_definition_id: publisher_policy.CandidatePublisher(uuid7(), uuid7()),
    }


def test_candidate_policy_authorization_uses_publisher_and_role_and_keeps_denial_local(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    publishers = _publishers()
    denied_definition_id = next(reversed(publishers))
    db = Mock(spec=Session)
    calls: list[dict[str, object]] = []

    def authorize(_snapshot_db: Session, **kwargs: object) -> object:
        calls.append(kwargs)
        if kwargs["actor_id"] == publishers[denied_definition_id].publisher_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return object()

    monkeypatch.setattr(publisher_policy, "authorize_workspace_capabilities", authorize)

    authorized = publisher_policy.authorize_candidate_publishers(db, publishers)

    assert authorized == {
        definition_id: definition_id != denied_definition_id for definition_id in publishers
    }
    assert [call["actor_id"] for call in calls] == [
        publishers[definition_id].publisher_id for definition_id in sorted(publishers)
    ]
    assert [call["expected_role_id"] for call in calls] == [
        publishers[definition_id].expected_role_id for definition_id in sorted(publishers)
    ]
    assert all(call["capabilities"] == (Capability.RECORDS_WRITE,) for call in calls)
    db.rollback.assert_not_called()


def test_candidate_policy_unavailability_rolls_back_and_stops_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    monkeypatch.setattr(
        publisher_policy,
        "authorize_workspace_capabilities",
        Mock(side_effect=HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE)),
    )

    with pytest.raises(HTTPException) as unavailable:
        publisher_policy.authorize_candidate_publishers(db, _publishers())

    assert unavailable.value.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    db.rollback.assert_called_once_with()


def test_candidate_role_change_retries_without_suspending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    monkeypatch.setattr(
        publisher_policy,
        "authorize_workspace_capabilities",
        Mock(side_effect=WorkspaceRoleChanged()),
    )

    with pytest.raises(RuntimeError, match="Publisher role changed"):
        publisher_policy.authorize_candidate_publishers(db, _publishers())

    db.rollback.assert_called_once_with()


def test_execute_claim_authorizes_before_publisher_or_resource_write_locks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    claim = ClaimedAutomationEvent(id=uuid7(), lease_token=uuid7())
    definition_id = uuid7()
    publisher = publisher_policy.CandidatePublisher(uuid7(), uuid7())
    event = SimpleNamespace(
        module_id=uuid7(),
        event_kind="record-created",
        root_event_id=None,
        schedule_cursor_record_id=None,
        state=AutomationEventState.RUNNING,
        lease_token=claim.lease_token,
        lease_expires_at=object(),
    )
    steps: list[str] = []

    monkeypatch.setattr(runner, "_candidate_event", Mock(return_value=event))
    monkeypatch.setattr(
        runner,
        "_candidate_definition_ids",
        Mock(return_value=({definition_id}, {definition_id: publisher})),
    )
    def authorize(*_args: object, **_kwargs: object) -> object:
        steps.append("policy")
        return object()

    def lock_fields(_db: Session, _module_id: UUID) -> dict[UUID, Field]:
        steps.append("field-lock")
        return {}

    def records(_db: Session, _event: object) -> tuple[list[Record], bool]:
        steps.append("record-lock")
        return [], False

    def definitions(
        _db: Session, _event: object, _definition_ids: set[UUID]
    ) -> list[PublishedAutomationDefinition]:
        steps.append("definition-lock")
        return []

    monkeypatch.setattr(publisher_policy, "authorize_workspace_capabilities", authorize)
    monkeypatch.setattr(runner, "locked_claim", Mock(return_value=event))
    monkeypatch.setattr(runner, "_locked_root", Mock(return_value=event))
    monkeypatch.setattr(
        runner,
        "_lock_module_fields",
        lock_fields,
    )
    monkeypatch.setattr(
        runner,
        "_records",
        records,
    )
    monkeypatch.setattr(
        runner,
        "_definitions",
        definitions,
    )

    assert runner.execute_claim(db, claim)
    assert steps == ["policy", "field-lock", "record-lock", "definition-lock"]


def test_changed_definition_publisher_retries_before_suspending_or_applying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    claim = ClaimedAutomationEvent(id=uuid7(), lease_token=uuid7())
    definition_id = uuid7()
    candidate = publisher_policy.CandidatePublisher(uuid7(), uuid7())
    event = SimpleNamespace(module_id=uuid7(), root_event_id=None)
    definition = SimpleNamespace(id=definition_id, publisher_id=uuid7())
    monkeypatch.setattr(runner, "_candidate_event", Mock(return_value=event))
    monkeypatch.setattr(
        runner,
        "_candidate_definition_ids",
        Mock(return_value=({definition_id}, {definition_id: candidate})),
    )
    monkeypatch.setattr(
        runner,
        "authorize_candidate_publishers",
        Mock(return_value={definition_id: True}),
    )
    monkeypatch.setattr(runner, "locked_claim", Mock(return_value=event))
    monkeypatch.setattr(runner, "_locked_root", Mock(return_value=event))
    monkeypatch.setattr(runner, "_lock_module_fields", Mock(return_value={}))
    monkeypatch.setattr(runner, "_records", Mock(return_value=([], False)))
    monkeypatch.setattr(runner, "_definitions", Mock(return_value=[definition]))
    set_context = Mock()
    monkeypatch.setattr(runner, "_set_context", set_context)

    with pytest.raises(RuntimeError, match="publisher changed"):
        runner.execute_claim(db, claim)

    db.rollback.assert_called_once_with()
    set_context.assert_not_called()
