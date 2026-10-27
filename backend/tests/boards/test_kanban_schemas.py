"""Kanban request shapes refuse ambiguous or unbounded input before any database work."""

from typing import Any

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from app.systems.boards.kanban_schemas import (
    CardBatchDates,
    CardCreate,
    CardListRequest,
    CardPatch,
    ChecklistOrder,
    ChecklistPatch,
    LabelCreate,
    StageArchive,
    StageCreate,
    StagePatch,
)

ID = "0190a000-0000-7000-8000-000000000001"
OTHER = "0190a000-0000-7000-8000-000000000002"


def _validate(model: Any, payload: dict[str, Any]) -> Any:
    if isinstance(model, type) and issubclass(model, BaseModel):
        return model.model_validate(payload)
    return TypeAdapter(model).validate_python(payload)


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        pytest.param(StageCreate, {"name": "  "}, id="stage-blank-name"),
        pytest.param(StageCreate, {"name": "Doing", "color": "red"}, id="stage-color-series"),
        pytest.param(StageCreate, {"name": "Doing", "wip_limit": 0}, id="stage-wip-below-one"),
        pytest.param(StageCreate, {"name": "Doing", "card_sort": "random"}, id="stage-sort"),
        pytest.param(StagePatch, {"revision": 1, "name": None}, id="stage-null-name"),
        pytest.param(StagePatch, {"revision": 1, "position": 2}, id="stage-unknown-field"),
        pytest.param(StageArchive, {"revision": 1, "cards": "move"}, id="move-without-target"),
        pytest.param(
            StageArchive, {"revision": 1, "cards": "archive", "target_stage_id": ID},
            id="archive-with-target",
        ),
        pytest.param(LabelCreate, {"name": "Urgent"}, id="label-without-color"),
        pytest.param(CardCreate, {"kind": "objective", "stage_id": ID}, id="objective-no-title"),
        pytest.param(
            CardCreate, {"kind": "record", "stage_id": ID, "title": "x"}, id="record-without-id"
        ),
        pytest.param(
            CardCreate,
            {"kind": "objective", "stage_id": ID, "title": "x", "label_ids": [ID, ID]},
            id="repeated-label",
        ),
        pytest.param(
            CardCreate,
            {"kind": "objective", "stage_id": ID, "title": "x",
             "start_on": "2026-11-02", "due_on": "2026-11-01"},
            id="start-after-due",
        ),
        pytest.param(CardPatch, {"revision": 1, "title": None}, id="patch-null-title"),
        pytest.param(CardPatch, {"revision": 1, "stage_id": None}, id="patch-null-stage"),
        pytest.param(CardPatch, {"title": "x"}, id="patch-without-revision"),
        pytest.param(
            CardBatchDates,
            {"items": [{"card_id": ID, "revision": 1, "start_on": None, "due_on": None}] * 2},
            id="batch-repeated-card",
        ),
        pytest.param(CardBatchDates, {"items": []}, id="batch-empty"),
        pytest.param(
            CardBatchDates, {"items": [{"card_id": ID, "revision": 1}]}, id="batch-dates-omitted"
        ),
        pytest.param(
            CardListRequest, {"due_from": "2026-11-02", "due_to": "2026-11-01"},
            id="list-due-range-inverted",
        ),
        pytest.param(CardListRequest, {"assignee": "someone"}, id="list-assignee-word"),
        pytest.param(ChecklistPatch, {"revision": 1, "done": None}, id="checklist-null-done"),
        pytest.param(ChecklistOrder, {"item_ids": [ID, ID]}, id="checklist-repeated-item"),
    ],
)
def test_kanban_input_refuses_invalid_payloads(model: Any, payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        _validate(model, payload)


def test_kanban_input_accepts_each_card_kind_and_clearing_values() -> None:
    objective = _validate(CardCreate, {"kind": "objective", "stage_id": ID, "title": " Plan "})
    assert (objective.title, objective.position, objective.label_ids) == ("Plan", None, [])
    record = _validate(CardCreate, {"kind": "record", "stage_id": ID, "record_id": OTHER})
    assert str(record.record_id) == OTHER
    cleared = CardPatch.model_validate({"revision": 2, "assignee_id": None, "due_on": None})
    assert cleared.model_fields_set == {"revision", "assignee_id", "due_on"}
    assert CardListRequest.model_validate({"assignee": "me"}).assignee == "me"
    assert StagePatch.model_validate({"revision": 1, "wip_limit": None}).wip_limit is None
