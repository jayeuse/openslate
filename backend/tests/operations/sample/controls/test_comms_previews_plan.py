from datetime import date

from operations.sample.controls.actions import plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.scenario import build_dataset


def test_both_organization_default_off_preview_journeys_are_planned():
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack("harbor"))
    operations = {row.values.get("operation") for row in plan_controls(dataset)}
    assert {"link_preview_default_off", "partner_link_preview_default_off"} <= operations
