"""The sauce plant pack's identity, budget, calendar and supporting counts."""

from __future__ import annotations

from datetime import date
from importlib import import_module

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.packs.manufacturer import PACK
from operations.sample.packs.manufacturer.realism import (
    BOARD_OBJECTIVES,
    BOARD_STAGES,
    holidays,
)
from operations.sample.population.board_kanban import card_target
from operations.sample.population.openview import _dashboard_widgets, _source_plans
from operations.sample.scenario import build_dataset
from tests.operations.sample.packs.sample_pack_manufacturer_chain import validate_dates
from tests.operations.sample.packs.sample_pack_openview_preflight import _api_structures

ANCHOR = date(2026, 9, 30)


def test_manufacturer_is_a_us_plant_with_the_approved_budget() -> None:
    identity = PACK.identity
    assert (identity.locale, identity.timezone, identity.currency_symbol,
            identity.currency_code) == ("en-US", "America/Chicago", "$", "USD")  # fmt: skip
    assert [name for _key, name in PACK.catalog.departments] == [
        "Sales and Customer Service",
        "Planning and Purchasing",
        "Warehouse and Logistics",
        "Production",
        "Quality and Food Safety",
        "Maintenance",
        "Finance",
    ]
    assert len(PACK.catalog.modules) == 24
    assert sum(PACK.catalog.counts_by_profile["standard"].values()) == 5_885


@pytest.mark.parametrize(
    ("day", "closed"),
    [
        (date(2026, 5, 25), True),  # Memorial Day, the last Monday of May.
        (date(2026, 7, 3), True),  # Independence Day falls on a Saturday: observed Friday.
        (date(2026, 9, 7), True),  # Labor Day.
        (date(2026, 11, 26), True),  # Thanksgiving.
        (date(2026, 11, 27), True),  # The day after Thanksgiving.
        (date(2026, 12, 24), True),  # Christmas Eve.
        (date(2026, 10, 12), False),  # The plant works on Columbus Day.
        (date(2026, 11, 11), False),  # And on Veterans Day.
    ],
)
def test_the_plant_closes_on_us_manufacturing_holidays(day: date, closed: bool) -> None:
    assert (day in holidays(ANCHOR)) is closed


@pytest.mark.parametrize("profile", ["standard", "large"])
def test_plant_records_are_dated_on_or_after_the_records_they_follow(profile: str) -> None:
    validate_dates(build_dataset(profile, 42, ANCHOR, organization=PACK))


def test_supporting_counts_match_the_boards_kanbans_and_openview_it_plans() -> None:
    dataset = build_dataset("small", 42, ANCHOR, organization=PACK)
    content = PACK.content.data
    kanban = content.kanban
    assert kanban is not None
    departments = [key for key, _name in PACK.catalog.departments]
    others = [key for key in departments if f"department:{key}" != kanban.board]
    plans = _source_plans(
        *_api_structures(dataset, SandboxDocument.model_validate(dataset.document)),
        organization=PACK,
    )
    boards = 1 + len(departments) + len(content.projects)
    counts = PACK.content.supporting_counts
    assert counts["boards"] == boards
    assert counts["posts"] == boards * content.posts_per_board
    assert counts["events"] == boards * content.events_per_board
    assert counts["attachments"] == len(content.board_files)
    assert counts["kanban_stages"] == len(kanban.stages) + sum(
        len(BOARD_STAGES[key]) for key in others
    )
    assert counts["kanban_labels"] == len(kanban.labels) + 3 * len(others)
    assert counts["kanban_cards"] == card_target(len(dataset.records)) * len(departments)
    assert counts["kanban_checklist_items"] == sum(len(card.checklist) for card in kanban.cards)
    assert counts["views"] == len(content.layouts) * len(departments)
    assert counts["dashboards"] == len(departments)
    assert counts["dashboard_widgets"] == sum(
        len(_dashboard_widgets(plans[key], ANCHOR)) for key in departments
    )
    assert counts["reports"] == sum(len(plans[key]) for key in departments)
    assert set(BOARD_STAGES) == set(BOARD_OBJECTIVES) == set(departments)


def test_seeded_files_use_every_allowed_type_away_from_the_control_board() -> None:
    content = PACK.content.data
    anchor = PACK.phases.existing_project_board if PACK.phases else ("", "")
    extensions = {spec.filename.rsplit(".", 1)[1] for spec in content.board_files}
    assert extensions == {"pdf", "png", "jpg", "jpeg", "docx", "xlsx", "pptx"}
    assert all(spec.index <= 5 for spec in content.board_files if spec.kind == "post")
    assert not [spec for spec in content.board_files if spec.board.endswith(
        anchor[0].lower().replace(" ", "-"))]  # fmt: skip


def test_realism_rates_are_found_by_pack_key() -> None:
    # The shared Kanban, later posts and the realism report import the pack's own rates.
    realism = import_module(f"operations.sample.packs.{PACK.identity.key}.realism")
    assert realism.BOARD_STAGES is BOARD_STAGES
