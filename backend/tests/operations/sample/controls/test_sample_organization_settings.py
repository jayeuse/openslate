"""Every registered pack can write its workspace settings (live Clinic run stopped here)."""

import pytest

from operations.sample.controls.manage import organization_settings
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.scenario import build_dataset


@pytest.mark.parametrize("pack", pack_keys())
def test_every_pack_has_an_iso_currency_for_its_workspace(pack: str) -> None:
    settings = organization_settings(build_dataset("small", organization=get_pack(pack)))

    assert len(settings["currency"]) == 3 and settings["currency"].isupper()
