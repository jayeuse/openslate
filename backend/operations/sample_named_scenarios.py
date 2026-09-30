"""Verify pack-defined named records, values, calculations and links."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from operations.sample_blueprint import SampleDataset


def named_scenario_issues(
    dataset: SampleDataset,
    records_by_id: Mapping[str, Mapping[str, Any]],
    record_ids: Mapping[str, str],
    field_ids: Mapping[str, str],
    relationship_fields: Mapping[str, str],
    actual_edges: set[tuple[str, str, str]],
) -> list[str]:
    issues: list[str] = []
    for scenario in dataset.named_scenarios:
        for field_check in scenario.field_checks:
            server_id = record_ids.get(field_check.logical_record_id)
            module_key = field_check.logical_record_id.split(":", maxsplit=1)[0]
            field_id = field_ids.get(f"{module_key}:{field_check.field_key}")
            row = records_by_id.get(server_id, {}) if server_id else {}
            data = row.get("data")
            actual = data.get(field_id) if isinstance(data, Mapping) and field_id else None
            expected = scenario.expected.get(field_check.expected_key)
            if not server_id or not field_id or actual != expected:
                issues.append(
                    f"named scenario {scenario.key} field {field_check.expected_key} differs"
                )

        for relationship_check in scenario.relationship_checks:
            relationship_id = relationship_fields.get(relationship_check.relationship_key)
            source_id = record_ids.get(relationship_check.source_record_id)
            target_id = record_ids.get(relationship_check.target_record_id)
            if (
                not relationship_id
                or not source_id
                or not target_id
                or (relationship_id, source_id, target_id) not in actual_edges
            ):
                issues.append(f"named scenario {scenario.key} relationship is missing")

        for calculation_check in scenario.calculation_checks:
            values = [scenario.expected.get(key) for key in calculation_check.operand_keys]
            expected = scenario.expected.get(calculation_check.expected_key)
            numeric: list[int | float] = []
            for value in (*values, expected):
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    numeric = []
                    break
                numeric.append(value)
            if not numeric or len(numeric) != len(values) + 1:
                issues.append(f"named scenario {scenario.key} calculation inputs are invalid")
                continue
            operands = numeric[:-1]
            expected_number = numeric[-1]
            if calculation_check.operator == "subtract" and len(operands) == 2:
                actual = operands[0] - operands[1]
            elif calculation_check.operator == "add":
                actual = sum(operands)
            else:
                issues.append(f"named scenario {scenario.key} calculation rule is invalid")
                continue
            if actual != expected_number:
                issues.append(
                    f"named scenario {scenario.key} calculation "
                    f"{calculation_check.expected_key} differs"
                )
    return issues
