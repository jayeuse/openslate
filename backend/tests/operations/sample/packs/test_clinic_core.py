"""The Clinic pack's identity, budget, calendar and supporting counts."""

from __future__ import annotations

from datetime import date
from importlib import import_module

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.packs.clinic import PACK
from operations.sample.packs.clinic.realism import BOARD_OBJECTIVES, BOARD_STAGES, holidays
from operations.sample.population.board_kanban import card_target
from operations.sample.population.openview import _dashboard_widgets, _source_plans
from operations.sample.scenario import build_dataset
from tests.operations.sample.packs.sample_pack_clinic_chain import validate_dates
from tests.operations.sample.packs.sample_pack_openview_preflight import _api_structures

ANCHOR = date(2026, 9, 30)


def test_clinic_is_a_us_outpatient_clinic_with_the_approved_budget() -> None:
    assert (PACK.identity.locale, PACK.identity.timezone, PACK.identity.currency_symbol) == (
        "en-US",
        "America/Chicago",
        "$",
    )
    assert [name for _key, name in PACK.catalog.departments] == [
        "Patient Access",
        "Clinical Services",
        "Laboratory",
        "Pharmacy",
        "Revenue Cycle",
        "Operations and Supply",
        "Quality and Compliance",
    ]
    assert len(PACK.catalog.modules) == 24
    assert sum(PACK.catalog.counts_by_profile["standard"].values()) == 6_072


@pytest.mark.parametrize(
    ("day", "closed"),
    [
        (date(2026, 7, 3), True),  # Independence Day falls on a Saturday.
        (date(2026, 9, 7), True),  # Labor Day.
        (date(2026, 11, 26), True),  # Thanksgiving Day.
        (date(2027, 12, 24), True),  # Christmas Day falls on a Saturday.
        (date(2026, 11, 27), False),
        (date(2026, 10, 1), False),
    ],
)
def test_clinic_closes_on_us_federal_holidays(day: date, closed: bool) -> None:
    assert (day in holidays(date(2026, 9, 30))) is closed


@pytest.mark.parametrize("profile", ["standard", "large"])
def test_clinic_children_are_dated_on_or_after_their_parents(profile: str) -> None:
    validate_dates(build_dataset(profile, 42, ANCHOR, organization=PACK))


def test_clinic_supporting_counts_match_the_boards_kanbans_and_openview_it_plans() -> None:
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


def test_clinic_realism_rates_are_found_by_pack_key() -> None:
    # The shared Kanban, later posts and the realism report import the pack's own rates.
    realism = import_module(f"operations.sample.packs.{PACK.identity.key}.realism")
    assert realism.BOARD_STAGES is BOARD_STAGES
