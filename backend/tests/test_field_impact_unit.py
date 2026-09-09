"""Unit tests for bounded field-impact query construction and iteration."""

from collections.abc import Iterator
from typing import Any
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.fields.impact import RECORD_IMPACT_BATCH_SIZE, validate_change_impact
from app.systems.fields.models import Field, FieldType
from app.systems.records.models import Record


class _TrackingResult:
    def __init__(self, rows: list[tuple[bool, Any]]) -> None:
        self.rows = rows
        self.batch_size: int | None = None
        self.consumed = 0
        self.closed = False

    def yield_per(self, batch_size: int) -> "_TrackingResult":
        self.batch_size = batch_size
        return self

    def __iter__(self) -> Iterator[tuple[bool, Any]]:
        for row in self.rows:
            self.consumed += 1
            yield row

    def close(self) -> None:
        self.closed = True


def _make_field() -> Field:
    field = Field(
        module_id=uuid7(),
        name="Title",
        type=FieldType.TEXT,
        required=False,
        position=0,
        config={},
    )
    field.id = uuid7()
    return field


def test_impact_query_selects_only_presence_and_value_and_uses_250_batch_size() -> None:
    field = _make_field()
    result = _TrackingResult([(True, "ok")])
    database = Mock(spec=Session)
    database.execute.return_value = result

    assert validate_change_impact(
        database,
        field,
        FieldType.TEXT,
        required=False,
        config={"minLength": 1},
    ) == {"minLength": 1}

    statement = database.execute.call_args.args[0]
    assert len(statement.selected_columns) == 2
    assert all(column is not Record.data for column in statement.selected_columns)
    assert result.batch_size == RECORD_IMPACT_BATCH_SIZE == 250
    assert result.closed is True


@pytest.mark.parametrize(
    ("required", "row", "message"),
    [
        (True, (False, None), "Field change would invalidate active records"),
        (True, (True, None), "Field change would invalidate active records"),
        (False, (False, None), None),
    ],
)
def test_impact_validation_handles_required_missing_and_null_values(
    required: bool,
    row: tuple[bool, Any],
    message: str | None,
) -> None:
    field = _make_field()
    result = _TrackingResult([row])
    database = Mock(spec=Session)
    database.execute.return_value = result

    if message is None:
        validate_change_impact(database, field, FieldType.TEXT, required, {"minLength": 1})
    else:
        with pytest.raises(ValueError, match=message):
            validate_change_impact(database, field, FieldType.TEXT, required, {})

    assert result.closed is True


def test_impact_validation_closes_stream_immediately_after_first_invalid_value() -> None:
    field = _make_field()
    result = _TrackingResult([(True, "too long"), (True, "never consumed")])
    database = Mock(spec=Session)
    database.execute.return_value = result

    with pytest.raises(ValueError, match="Field change would invalidate active records"):
        validate_change_impact(
            database,
            field,
            FieldType.TEXT,
            required=False,
            config={"maxLength": 3},
        )

    assert result.closed is True


def test_impact_validation_reaches_an_invalid_value_after_four_250_row_batches() -> None:
    field = _make_field()
    result = _TrackingResult([(True, "ok")] * 1000 + [(True, "too long")])
    database = Mock(spec=Session)
    database.execute.return_value = result

    with pytest.raises(ValueError, match="Field change would invalidate active records"):
        validate_change_impact(
            database,
            field,
            FieldType.TEXT,
            required=False,
            config={"maxLength": 3},
        )

    assert result.batch_size == 250
    assert result.consumed == 1001
    assert result.closed is True
