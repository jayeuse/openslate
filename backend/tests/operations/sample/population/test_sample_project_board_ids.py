"""Project Board journal IDs are safe for every pack's project names."""

from __future__ import annotations

import pytest

from operations.sample.client import _SAFE_MAPPING_VALUE
from operations.sample.packs.registry import get_pack
from operations.sample.population.boards import project_board_logical_id

PACKS = ("harbor", "school")


@pytest.mark.parametrize("pack_key", PACKS)
def test_every_project_board_id_is_a_valid_journal_mapping(pack_key: str) -> None:
    for name, department_key in get_pack(pack_key).content.data.projects:
        logical = project_board_logical_id(department_key, name)
        assert _SAFE_MAPPING_VALUE.fullmatch(logical), logical


def test_punctuation_in_a_project_name_does_not_reach_the_journal_id() -> None:
    assert (
        project_board_logical_id("academic", "Parents' Evening Planning")
        == "project:academic:parents-evening-planning"
    )


def test_existing_harbor_project_ids_do_not_change() -> None:
    assert project_board_logical_id("sales", "Customer Renewal") == (
        "project:sales:customer-renewal"
    )
