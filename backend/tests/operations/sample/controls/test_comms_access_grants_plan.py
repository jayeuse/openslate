from datetime import date

from operations.sample.controls.actions import plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.scenario import build_dataset


def test_access_grant_journey_is_planned():
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    operations = {row.values.get("operation") for row in plan_controls(dataset)}
    assert "access_grants_roundtrip" in operations
