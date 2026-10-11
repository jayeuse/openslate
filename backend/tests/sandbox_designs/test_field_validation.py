"""Branch-level contracts for portable Sandbox field values and mappings."""

from dataclasses import replace

import pytest

from app.systems.sandbox.designs.field_validation import (
    DocumentValueError,
    FieldMetadata,
    Scalar,
    validate_mapping,
    validate_value,
)


def _field(**changes: object) -> FieldMetadata:
    base = FieldMetadata(
        config_kind="text",
        required=False,
        closed=False,
        select_options=frozenset(),
        select_labels=frozenset(),
        max_length=None,
        minimum=None,
        maximum=None,
        step=None,
        earliest=None,
        latest=None,
    )
    if "select_options" in changes and "select_labels" not in changes:
        changes["select_labels"] = changes["select_options"]
    return replace(base, **changes)


@pytest.mark.parametrize(
    ("value", "metadata"),
    (
        pytest.param(None, _field(), id="null-optional"),
        pytest.param(True, _field(config_kind="checkbox"), id="checkbox"),
        pytest.param(4, _field(config_kind="integer"), id="integer"),
        pytest.param(4.5, _field(config_kind="number"), id="number"),
        pytest.param(
            "Open", _field(config_kind="select", select_options=frozenset({"Open"})), id="select"
        ),
        pytest.param(
            "2026-09-21",
            _field(config_kind="date", earliest="2026-01-01", latest="2026-12-31"),
            id="date-in-range",
        ),
        pytest.param(
            "2026-09-21T09:30:00Z",
            _field(config_kind="datetime", earliest="2026-01-01", latest="2026-12-31"),
            id="datetime-in-range",
        ),
        pytest.param("owner@example.com", _field(config_kind="email"), id="email"),
        pytest.param("https://example.com/item", _field(config_kind="url"), id="url"),
        pytest.param(
            10**500, _field(config_kind="integer", minimum=0, step=2), id="huge-integer-on-step"
        ),
        pytest.param(0, _field(config_kind="number", minimum=0, maximum=10), id="at-minimum"),
        pytest.param(10, _field(config_kind="number", minimum=0, maximum=10), id="at-maximum"),
        pytest.param("abc", _field(max_length=3), id="text-at-max-length"),
        pytest.param("", _field(config_kind="email"), id="optional-empty-email"),
        pytest.param("", _field(config_kind="url"), id="optional-empty-url"),
        pytest.param("http://example.com", _field(config_kind="url"), id="http-url"),
        pytest.param(
            "2c0f1ab0-6d4e-4c1b-9a43-2f0e5d6c7b8a", _field(config_kind="user"), id="user-id"
        ),
    ),
)
def test_portable_values_accept_each_supported_type_within_its_constraints(
    value: Scalar, metadata: FieldMetadata
) -> None:
    validate_value(value, metadata)


@pytest.mark.parametrize(
    ("value", "metadata", "message"),
    (
        pytest.param(None, _field(required=True), "required field cannot use null", id="null"),
        pytest.param("value", _field(closed=True), "closed fields", id="closed-field"),
        pytest.param("   ", _field(required=True), "empty string", id="blank-required"),
        pytest.param(1, _field(config_kind="checkbox"), "checkbox field", id="checkbox-integer"),
        pytest.param(True, _field(config_kind="integer"), "integer field", id="integer-boolean"),
        pytest.param(
            "Missing",
            _field(config_kind="select", select_options=frozenset({"Open"})),
            "select field",
            id="select-unknown-option",
        ),
        pytest.param("bad", _field(config_kind="date"), "date field", id="date-text"),
        pytest.param("2026-02-30", _field(config_kind="date"), "date field", id="date-no-day"),
        pytest.param("bad", _field(config_kind="datetime"), "datetime field", id="datetime-text"),
        pytest.param(
            "2026-01-01T25:00", _field(config_kind="datetime"), "datetime field", id="hour-25"
        ),
        pytest.param(
            "2026-02-30T12:00",
            _field(config_kind="datetime"),
            "datetime field",
            id="datetime-no-day",
        ),
        pytest.param(
            float("inf"), _field(config_kind="number"), "number field", id="infinite-number"
        ),
        pytest.param("long", _field(max_length=3), "maxLength", id="text-too-long"),
        pytest.param(
            -1, _field(config_kind="number", minimum=0), "below field minimum", id="below-minimum"
        ),
        pytest.param(
            11, _field(config_kind="number", maximum=10), "above field maximum", id="above-maximum"
        ),
        pytest.param(
            3,
            _field(config_kind="number", minimum=0, step=2),
            "does not match field step",
            id="off-step",
        ),
        pytest.param(
            10**500 + 1,
            _field(config_kind="integer", minimum=0, step=2),
            "does not match field step",
            id="huge-integer-off-step",
        ),
        pytest.param(
            4, _field(config_kind="number", step=0), "does not match field step", id="zero-step"
        ),
        pytest.param(
            "2027-01-01",
            _field(config_kind="date", latest="2026-12-31"),
            "date field",
            id="date-after-latest",
        ),
        pytest.param("owner@example", _field(config_kind="email"), "email field", id="email-host"),
        pytest.param(
            "ftp://example.com/item", _field(config_kind="url"), "url field", id="url-scheme"
        ),
        pytest.param("https://", _field(config_kind="url"), "url field", id="url-without-host"),
        pytest.param(
            "2C0F1AB0-6D4E-4C1B-9A43-2F0E5D6C7B8A",
            _field(config_kind="user"),
            "user field",
            id="user-id-uppercase",
        ),
        pytest.param("not-an-id", _field(config_kind="user"), "user field", id="user-not-uuid"),
        pytest.param(5, _field(config_kind="user"), "user field", id="user-integer"),
    ),
)
def test_portable_values_refuse_each_invalid_type_constraint_and_date(
    value: Scalar, metadata: FieldMetadata, message: str
) -> None:
    with pytest.raises(DocumentValueError, match=message):
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


@pytest.mark.parametrize(
    ("source", "target", "relationship_id"),
    (
        pytest.param(
            _field(config_kind="select", select_options=frozenset({"Open"})),
            _field(config_kind="select", select_options=frozenset({"Open", "Done"})),
            "select",
            id="select-subset",
        ),
        pytest.param(
            _field(config_kind="integer", minimum=0, maximum=10, step=2),
            _field(config_kind="number", minimum=0, maximum=10, step=1),
            "number",
            id="integer-into-number",
        ),
        pytest.param(
            _field(config_kind="number", minimum=0, maximum=10),
            _field(config_kind="number", minimum=0, maximum=10),
            "unconstrained-step",
            id="number-without-step",
        ),
        pytest.param(
            _field(config_kind="date", earliest="2026-02-01", latest="2026-10-01"),
            _field(config_kind="date", earliest="2026-01-01", latest="2026-12-31"),
            "date",
            id="date-within-range",
        ),
        pytest.param(
            _field(config_kind="checkbox"), _field(config_kind="checkbox"), "flag", id="checkbox"
        ),
        pytest.param(
            _field(config_kind="email", max_length=80),
            _field(config_kind="text", max_length=100),
            "email-text",
            id="email-into-longer-text",
        ),
        pytest.param(
            _field(config_kind="text"),
            _field(config_kind="long-text"),
            "unbounded-text",
            id="text-into-unbounded-long-text",
        ),
        pytest.param(
            _field(config_kind="integer", minimum=5, step=4),
            _field(config_kind="number", minimum=1, step=4),
            "offset-step",
            id="stepped-integer-offset-by-one-step",
        ),
        pytest.param(
            _field(
                config_kind="datetime", earliest="2026-02-01T00:00Z", latest="2026-10-01T00:00Z"
            ),
            _field(
                config_kind="datetime", earliest="2026-01-01T00:00Z", latest="2026-12-31T00:00Z"
            ),
            "datetime",
            id="datetime-within-range",
        ),
        pytest.param(
            _field(config_kind="long-text"),
            _field(config_kind="long-text"),
            "notes",
            id="long-text-into-long-text",
        ),
        pytest.param(
            _field(config_kind="url", max_length=80),
            _field(config_kind="url", max_length=100),
            "link",
            id="url-into-longer-url",
        ),
        pytest.param(
            _field(config_kind="url", max_length=80),
            _field(config_kind="text", max_length=100),
            "link-text",
            id="url-into-longer-text",
        ),
        pytest.param(
            _field(config_kind="long-text", max_length=80),
            _field(config_kind="text", max_length=100),
            "notes-text",
            id="bounded-long-text-into-longer-text",
        ),
    ),
)
def test_portable_mapping_accepts_each_directionally_safe_pair(
    source: FieldMetadata, target: FieldMetadata, relationship_id: str
) -> None:
    validate_mapping(source, target, relationship_id)


@pytest.mark.parametrize(
    ("source", "target", "relationship_id", "message"),
    (
        pytest.param(_field(closed=True), _field(), "closed", "closed", id="closed-source"),
        pytest.param(
            _field(), _field(required=True), "required", "optional", id="optional-into-required"
        ),
        pytest.param(
            _field(config_kind="select", select_options=frozenset({"Missing"})),
            _field(config_kind="select", select_options=frozenset({"Open"})),
            "select",
            "incompatible",
            id="select-option-missing",
        ),
        pytest.param(
            _field(config_kind="number"),
            _field(config_kind="integer"),
            "number",
            "incompatible",
            id="number-into-integer",
        ),
        pytest.param(
            _field(config_kind="number", minimum=0, maximum=10),
            _field(config_kind="number", minimum=0, maximum=10, step=2),
            "number",
            "incompatible",
            id="unstepped-number-into-stepped",
        ),
        pytest.param(
            _field(config_kind="integer", minimum=0, maximum=10),
            _field(config_kind="integer", minimum=0, maximum=10, step=2),
            "number",
            "incompatible",
            id="unstepped-integer-into-stepped",
        ),
        pytest.param(
            _field(config_kind="date", earliest="2025-01-01"),
            _field(config_kind="date", earliest="2026-01-01"),
            "date",
            "incompatible",
            id="date-starts-earlier",
        ),
        pytest.param(
            _field(config_kind="text"),
            _field(config_kind="text", max_length=10),
            "bounded-text",
            "incompatible",
            id="unbounded-into-bounded-text",
        ),
        pytest.param(
            _field(config_kind="date", latest="2026-12-31"),
            _field(config_kind="date", latest="2026-10-01"),
            "date",
            "incompatible",
            id="date-ends-later",
        ),
        pytest.param(
            _field(config_kind="datetime"),
            _field(config_kind="date"),
            "date",
            "incompatible",
            id="datetime-into-date",
        ),
        pytest.param(
            _field(config_kind="number", minimum=0),
            _field(config_kind="number", minimum=0, maximum=10),
            "number",
            "incompatible",
            id="unbounded-number-into-bounded",
        ),
        pytest.param(
            _field(config_kind="number", minimum=0, maximum=10),
            _field(config_kind="number", minimum=5, maximum=10),
            "number",
            "incompatible",
            id="number-starts-lower",
        ),
        pytest.param(
            _field(config_kind="integer"),
            _field(config_kind="number", step=0),
            "number",
            "incompatible",
            id="target-step-zero",
        ),
    ),
)
def test_portable_mapping_refuses_each_closed_required_or_widening_pair(
    source: FieldMetadata, target: FieldMetadata, relationship_id: str, message: str
) -> None:
    with pytest.raises(DocumentValueError, match=message):
        validate_mapping(source, target, relationship_id)
