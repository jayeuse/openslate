"""Branch-level contracts for portable Sandbox field values and mappings."""

from dataclasses import replace

import pytest

from app.systems.sandbox.designs.field_validation import (
    DocumentValueError,
    FieldMetadata,
    validate_mapping,
    validate_value,
)


def _field(**changes: object) -> FieldMetadata:
    base = FieldMetadata(
        config_kind="text",
        required=False,
        closed=False,
        select_options=frozenset(),
        max_length=None,
        minimum=None,
        maximum=None,
        step=None,
        earliest=None,
        latest=None,
    )
    return replace(base, **changes)


def test_portable_values_cover_supported_types_constraints_and_invalid_dates() -> None:
    validate_value(None, _field())
    validate_value(True, _field(config_kind="checkbox"))
    validate_value(4, _field(config_kind="integer"))
    validate_value(4.5, _field(config_kind="number"))
    validate_value(
        "Open",
        _field(config_kind="select", select_options=frozenset({"Open"})),
    )
    validate_value(
        "2026-09-21",
        _field(config_kind="date", earliest="2026-01-01", latest="2026-12-31"),
    )
    validate_value(
        "2026-09-21T09:30:00Z",
        _field(config_kind="datetime", earliest="2026-01-01", latest="2026-12-31"),
    )
    validate_value("owner@example.com", _field(config_kind="email"))
    validate_value("https://example.com/item", _field(config_kind="url"))
    validate_value(10**500, _field(config_kind="integer", minimum=0, step=2))

    invalid = [
        (None, _field(required=True)),
        ("value", _field(closed=True)),
        ("   ", _field(required=True)),
        (1, _field(config_kind="checkbox")),
        (True, _field(config_kind="integer")),
        ("Missing", _field(config_kind="select", select_options=frozenset({"Open"}))),
        ("bad", _field(config_kind="date")),
        ("2026-02-30", _field(config_kind="date")),
        ("bad", _field(config_kind="datetime")),
        ("2026-01-01T25:00", _field(config_kind="datetime")),
        ("2026-02-30T12:00", _field(config_kind="datetime")),
        (float("inf"), _field(config_kind="number")),
        ("long", _field(max_length=3)),
        (-1, _field(config_kind="number", minimum=0)),
        (11, _field(config_kind="number", maximum=10)),
        (3, _field(config_kind="number", minimum=0, step=2)),
        (10**500 + 1, _field(config_kind="integer", minimum=0, step=2)),
    ]
    for value, metadata in invalid:
        with pytest.raises(DocumentValueError):
            validate_value(value, metadata)


def test_datetime_values_accept_designer_syntax_and_compare_timezone_offsets_as_instants() -> None:
    bounded = _field(
        config_kind="datetime",
        earliest="2026-01-01T00:00Z",
        latest="2026-01-01T01:00Z",
    )

    validate_value("2026-01-01T00:30", bounded)
    validate_value("2025-12-31T19:30:00-05:00", bounded)

    with pytest.raises(DocumentValueError, match="incompatible"):
        validate_value("2025-12-31T18:59:00-05:00", bounded)


def test_portable_mapping_compatibility_is_directional_and_constraint_safe() -> None:
    with pytest.raises(DocumentValueError, match="closed"):
        validate_mapping(_field(closed=True), _field(), "closed")
    with pytest.raises(DocumentValueError, match="optional"):
        validate_mapping(_field(), _field(required=True), "required")

    validate_mapping(
        _field(config_kind="select", select_options=frozenset({"Open"})),
        _field(config_kind="select", select_options=frozenset({"Open", "Done"})),
        "select",
    )
    with pytest.raises(DocumentValueError, match="incompatible"):
        validate_mapping(
            _field(config_kind="select", select_options=frozenset({"Missing"})),
            _field(config_kind="select", select_options=frozenset({"Open"})),
            "select",
        )

    validate_mapping(
        _field(config_kind="integer", minimum=0, maximum=10, step=2),
        _field(config_kind="number", minimum=0, maximum=10, step=1),
        "number",
    )
    validate_mapping(
        _field(config_kind="number", minimum=0, maximum=10),
        _field(config_kind="number", minimum=0, maximum=10),
        "unconstrained-step",
    )
    for source, target in [
        (_field(config_kind="number"), _field(config_kind="integer")),
        (
            _field(config_kind="number", minimum=0, maximum=10),
            _field(config_kind="number", minimum=0, maximum=10, step=2),
        ),
        (
            _field(config_kind="integer", minimum=0, maximum=10),
            _field(config_kind="integer", minimum=0, maximum=10, step=2),
        ),
    ]:
        with pytest.raises(DocumentValueError, match="incompatible"):
            validate_mapping(source, target, "number")

    validate_mapping(
        _field(config_kind="date", earliest="2026-02-01", latest="2026-10-01"),
        _field(config_kind="date", earliest="2026-01-01", latest="2026-12-31"),
        "date",
    )
    with pytest.raises(DocumentValueError, match="incompatible"):
        validate_mapping(
            _field(config_kind="date", earliest="2025-01-01"),
            _field(config_kind="date", earliest="2026-01-01"),
            "date",
        )

    validate_mapping(_field(config_kind="checkbox"), _field(config_kind="checkbox"), "flag")
    validate_mapping(
        _field(config_kind="email", max_length=80),
        _field(config_kind="text", max_length=100),
        "email-text",
    )
    validate_mapping(
        _field(config_kind="text"),
        _field(config_kind="long-text"),
        "unbounded-text",
    )
    with pytest.raises(DocumentValueError, match="incompatible"):
        validate_mapping(
            _field(config_kind="text"),
            _field(config_kind="text", max_length=10),
            "bounded-text",
        )
