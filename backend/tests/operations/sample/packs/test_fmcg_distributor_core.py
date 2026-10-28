"""The Silangan distributor pack's identity, budget, calendar and supporting counts."""

from __future__ import annotations

from datetime import date
from importlib import import_module

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.packs.fmcg_distributor import PACK
from operations.sample.packs.fmcg_distributor.realism import (
    BOARD_OBJECTIVES,
    BOARD_STAGES,
    holidays,
)
from operations.sample.population.board_kanban import card_target
from operations.sample.population.openview import _dashboard_widgets, _source_plans
from operations.sample.scenario import build_dataset
from tests.operations.sample.packs.sample_pack_fmcg_distributor_chain import validate_dates
from tests.operations.sample.packs.sample_pack_openview_preflight import _api_structures

ANCHOR = date(2026, 9, 30)


def test_silangan_is_a_philippine_distributor_with_the_approved_budget() -> None:
    identity = PACK.identity
    assert (identity.key, identity.locale, identity.timezone) == (
        "fmcg_distributor", "en-PH", "Asia/Manila")  # fmt: skip
    assert (identity.currency_symbol, identity.currency_code) == ("₱", "PHP")
    assert [name for _key, name in PACK.catalog.departments] == [
        "Sales",
        "Key Accounts and Trade Marketing",
        "Purchasing and Principal Relations",
        "Warehouse and Inventory",
        "Logistics",
        "Credit and Collections",
        "Accounting and Claims",
    ]
    assert len(PACK.catalog.modules) == 24
    assert sum(PACK.catalog.counts_by_profile["standard"].values()) == 5_895
    # Every department keeps a dated module, so each gets its OpenView sources.
    dated = {module.department for module in PACK.catalog.modules
             if any(field.type == "Date" for field in module.fields)}  # fmt: skip
    assert dated == {key for key, _name in PACK.catalog.departments}


@pytest.mark.parametrize(
    ("day", "closed"),
    [
        (date(2026, 4, 2), True),  # Maundy Thursday.
        (date(2026, 8, 31), True),  # National Heroes Day, the last Monday of August.
        (date(2026, 8, 21), True),  # Ninoy Aquino Day.
        (date(2026, 11, 30), True),  # Bonifacio Day.
        (date(2026, 8, 24), False),
        (date(2026, 9, 29), False),
    ],
)
def test_silangan_closes_on_philippine_holidays(day: date, closed: bool) -> None:
    assert (day in holidays(ANCHOR)) is closed


@pytest.mark.parametrize("profile", ["standard", "large"])
def test_silangan_children_are_dated_on_or_after_their_parents(profile: str) -> None:
    validate_dates(build_dataset(profile, 42, ANCHOR, organization=PACK))


def test_silangan_supporting_counts_match_the_boards_kanbans_and_openview_it_plans() -> None:
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
    counts = PACK.content.supporting_counts
    assert (counts["boards"], counts["posts"], counts["events"]) == (11, 88, 132)
    assert counts["attachments"] == len(content.board_files)
    assert counts["kanban_stages"] == len(kanban.stages) + sum(
        len(BOARD_STAGES[key]) for key in others
    )
    assert counts["kanban_cards"] == card_target(len(dataset.records)) * len(departments)
    assert counts["views"] == len(content.layouts) * len(departments)
    assert counts["dashboards"] == len(departments)
    assert counts["dashboard_widgets"] == sum(
        len(_dashboard_widgets(plans[key], ANCHOR)) for key in departments
    )
    assert counts["reports"] == sum(len(plans[key]) for key in departments)
    assert set(BOARD_STAGES) == set(BOARD_OBJECTIVES) == set(departments)


def test_silangan_realism_rates_are_found_by_pack_key() -> None:
    # The shared Kanban, later posts and the realism report import the pack's own rates.
    realism = import_module(f"operations.sample.packs.{PACK.identity.key}.realism")
    assert realism.BOARD_STAGES is BOARD_STAGES
