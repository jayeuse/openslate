"""Organization-selected pure Board and OpenView text generators."""

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack


def board_kind(board: Mapping[str, Any]) -> str:
    department = board.get("department_key")
    if department is None:
        return "company"
    return f"project:{department}" if board.get("scope") == "project" else str(department)


def post_text(
    board: Mapping[str, Any],
    index: int,
    parent_total: Decimal,
    paid: Decimal,
    *,
    organization: OrganizationPack | None = None,
) -> tuple[str, str]:
    pack = organization or default_pack()
    if index < pack.content.data.posts_per_board:
        return pack.content.data.post_text(board, index, parent_total, paid)
    return _later_post(pack, board, index)


_LATER_TITLES = ("Update: {}", "This week: {}", "Done: {}", "Reminder: {}", "Help needed: {}")
_LATER_BODIES = (
    "Quick update on {}. We are on track; reply here if something blocks you.",
    "Please add your notes on {} before Friday so we can close it out.",
    "{} is finished. Thanks to everyone who helped.",
    "A reminder that {} is due soon. Check the board for your part.",
    "We need one more person on {}. Comment here if you can take it.",
)


def _later_post(pack: OrganizationPack, board: Mapping[str, Any], index: int) -> tuple[str, str]:
    """A later post on a Board, written from the department's own work (spec R9)."""
    from importlib import import_module

    objectives = import_module(
        f"operations.sample.packs.{pack.identity.key}.realism"
    ).BOARD_OBJECTIVES
    department = board.get("department_key")
    pool = objectives.get(department) or [item for items in objectives.values() for item in items]
    topic = pool[index % len(pool)]
    style = (index // len(pool) + index) % len(_LATER_TITLES)
    return _LATER_TITLES[style].format(topic)[:100], _LATER_BODIES[style].format(topic)[:2000]


def revised_post(
    title: str, body: str, *, organization: OrganizationPack | None = None
) -> tuple[str, str]:
    return (organization or default_pack()).content.data.revised_post(title, body)


def project_board(name: str, *, organization: OrganizationPack | None = None) -> tuple[str, str]:
    return (organization or default_pack()).content.data.project_board(name)


def view_name(module_key: str, layout: str, *, organization: OrganizationPack | None = None) -> str:
    return (organization or default_pack()).content.data.view_name(module_key, layout)


def dashboard_name(department_name: str, *, organization: OrganizationPack | None = None) -> str:
    return (organization or default_pack()).content.data.dashboard_name(department_name)


def report_names(
    module_key: str,
    cadence: str,
    group_name: str | None,
    *,
    organization: OrganizationPack | None = None,
) -> tuple[str, str]:
    return (organization or default_pack()).content.data.report_names(
        module_key, cadence, group_name
    )
