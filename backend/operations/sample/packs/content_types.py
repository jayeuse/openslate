"""Typed content data consumed by the shared Board and OpenView workflows."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

BoardText = Callable[[Mapping[str, Any], int, Decimal, Decimal], tuple[str, str]]


@dataclass(frozen=True)
class BoardLinkSpec:
    key: str
    kind: str
    board: str
    index: int
    records: tuple[str, ...]


@dataclass(frozen=True)
class BoardFileSpec:
    """A blank attachment a team member adds to one seeded post or event."""

    key: str
    board: str
    kind: str  # post or event
    index: int
    filename: str  # meaningful name; the extension picks the file type


@dataclass(frozen=True)
class MoneySpec:
    key: str
    record: str
    field: str
    expected: Decimal


@dataclass(frozen=True)
class ContentSpec:
    department_groups: Mapping[str, tuple[str, str]]
    leads: Mapping[str, str]
    projects: tuple[tuple[str, str], ...]
    project_groups: tuple[tuple[str, str], ...]
    required_modules: tuple[tuple[str, str], ...]
    company_source_department: str
    required_records: Mapping[str, str]
    amounts: tuple[MoneySpec, ...]
    scenario_total: Decimal
    scenario_paid: Decimal
    scenario_balance: Decimal
    board_links: tuple[BoardLinkSpec, ...]
    board_files: tuple[BoardFileSpec, ...]
    post_states: tuple[str, ...]
    posts_per_board: int
    events_per_board: int
    event_titles: tuple[str, ...]
    event_details: Mapping[str, str]
    event_locations: tuple[str, ...]
    reminders: tuple[str, ...]
    layouts: tuple[str, ...]
    posts: Mapping[str, tuple[tuple[str, str], ...]]
    board_descriptions: Mapping[str, str]
    layout_names: Mapping[str, str]
    post_text: BoardText
    revised_post: Callable[[str, str], tuple[str, str]]
    project_board: Callable[[str], tuple[str, str]]
    view_name: Callable[[str, str], str]
    dashboard_name: Callable[[str], str]
    report_names: Callable[[str, str, str | None], tuple[str, str]]
