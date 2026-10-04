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
    return (organization or default_pack()).content.data.post_text(board, index, parent_total, paid)


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
