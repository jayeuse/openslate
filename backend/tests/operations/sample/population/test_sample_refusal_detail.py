"""A refused population write names the API code and fields, never the value (live Clinic 422)."""

import httpx

from operations.sample.population.run import refusal_detail

FIELD = "0190a000-0000-7000-8000-000000000001"


def test_refusal_detail_names_the_code_and_field_rules_without_values() -> None:
    response = httpx.Response(422, json={"detail": {
        "code": "record_validation_failed", "message": "Invalid record",
        "errors": [{"field_id": FIELD, "message": "value is above field maximum",
                    "value": "private-value"}], "truncated": False,
    }})  # fmt: skip

    detail = refusal_detail(response)

    assert detail == f" (record_validation_failed; {FIELD}: value is above field maximum)"
    assert "private-value" not in detail


def test_refusal_detail_is_empty_for_a_plain_or_unreadable_body() -> None:
    assert refusal_detail(httpx.Response(422, text="no json")) == ""
    assert refusal_detail(httpx.Response(422, json={"detail": "Validation failed"})) == ""
