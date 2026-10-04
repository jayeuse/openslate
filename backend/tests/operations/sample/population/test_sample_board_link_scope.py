"""A Board link step checks only the scenario records it links."""

from __future__ import annotations

from typing import Any

import pytest

from operations.sample.packs.registry import get_pack
from operations.sample.population.board_entries import validate_board_scenarios
from operations.sample.population.content import SampleContentError

ASSESSMENT_ID = "00000000-0000-4000-8000-000000000101"
PAYMENT_ID = "00000000-0000-4000-8000-000000000102"
FIELDS = {
    "fee_assessments": [{"id": "00000000-0000-4000-8000-000000000201", "name": "Net due £"}],
    "payments": [{"id": "00000000-0000-4000-8000-000000000202", "name": "Amount £"}],
}


def _finance_records(paid: int = 1_600) -> dict[str, dict[str, Any]]:
    return {
        "fee_assessments:000001": {
            "id": ASSESSMENT_ID,
            "module_key": "fee_assessments",
            "data": {"00000000-0000-4000-8000-000000000201": 4_200},
        },
        "payments:000001": {
            "id": PAYMENT_ID,
            "module_key": "payments",
            "data": {"00000000-0000-4000-8000-000000000202": paid},
        },
    }


def test_finance_link_does_not_wait_for_academic_scenario_records() -> None:
    # Class sections are created later in the run than finance records.
    result = validate_board_scenarios(
        _finance_records(),
        FIELDS,
        organization=get_pack("school"),
        only=("fee_assessments:000001", "payments:000001"),
    )
    assert result["record_ids"] == {
        "fee_assessments:000001": ASSESSMENT_ID,
        "payments:000001": PAYMENT_ID,
    }


def test_finance_link_still_checks_the_settled_amounts() -> None:
    with pytest.raises(SampleContentError):
        validate_board_scenarios(
            _finance_records(paid=1_500),
            FIELDS,
            organization=get_pack("school"),
            only=("fee_assessments:000001", "payments:000001"),
        )


def test_full_validation_still_requires_every_scenario_record() -> None:
    with pytest.raises(SampleContentError):
        validate_board_scenarios(_finance_records(), FIELDS, organization=get_pack("school"))
