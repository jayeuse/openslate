from datetime import date

import pytest
from pydantic import ValidationError
from uuid6 import uuid7

from app.systems.openview.charts.schemas import ChartPreferenceConfig


def test_chart_preferences_accept_bounded_versioned_categorical_settings() -> None:
    dimension_id = uuid7()
    date_field_id = uuid7()
    preference = ChartPreferenceConfig.model_validate(
        {
            "version": 1,
            "module_id": uuid7(),
            "chart_type": "bar",
            "dimension_id": dimension_id,
            "date_field_id": date_field_id,
            "aggregation": "count",
            "filter_logic": "or",
            "filters": [],
            "from_date": date(2026, 9, 1),
            "to_date": date(2026, 9, 30),
            "top": 5,
            "show_legend": False,
            "show_values": True,
        }
    )

    assert preference.version == 1
    assert preference.filter_logic == "or"
    assert preference.from_date == date(2026, 9, 1)
    assert preference.top == 5


def test_chart_preferences_reject_incomplete_or_oversized_windows_and_invalid_modes() -> None:
    common = {
        "version": 1,
        "module_id": uuid7(),
        "chart_type": "bar",
        "dimension_id": uuid7(),
        "aggregation": "count",
        "filter_logic": "and",
        "filters": [],
        "top": None,
        "show_legend": True,
        "show_values": True,
    }
    with pytest.raises(ValidationError):
        ChartPreferenceConfig.model_validate(
            {**common, "date_field_id": uuid7(), "from_date": "2026-09-01"}
        )
    with pytest.raises(ValidationError):
        ChartPreferenceConfig.model_validate(
            {
                **common,
                "date_field_id": uuid7(),
                "from_date": "2026-01-01",
                "to_date": "2027-01-02",
            }
        )
    with pytest.raises(ValidationError):
        ChartPreferenceConfig.model_validate(
            {
                **common,
                "chart_type": "line",
                "dimension_id": None,
                "date_field_id": uuid7(),
                "from_date": None,
                "to_date": None,
            }
        )
