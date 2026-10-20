"""Both owned organization journeys must reach the extended existing notification API."""

from datetime import date

from operations.sample.controls.actions import plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.scenario import build_dataset


def test_comms_notification_controls_are_planned_for_both_organizations():
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    operations = {row.values.get("operation") for row in plan_controls(dataset)}
    assert {"notification_roundtrip", "partner_notification_roundtrip"} <= operations
