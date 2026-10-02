"""Typed plan data for lifecycle and administration phases."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, get_args

PhaseName = Literal["admin", "reorganization"]
OpenViewKind = Literal["view", "dashboard", "report"]
type PhaseJsonScalar = str | int | float | bool | None
type PhaseJsonValue = PhaseJsonScalar | list[PhaseJsonValue] | dict[str, PhaseJsonValue]

PhaseActionKind = Literal[
    "openview_controls",
    "board_controls",
    "access_controls",
    "sandbox_controls",
    "account_controls",
    "manage_controls",
    "audit_controls",
    "read_controls",
    "refuse_role_change",
    "promote_user",
    "demote_user",
    "remove_group_member",
    "add_group_member",
    "replace_group_access",
    "disable_user",
    "restore_disabled_user",
    "end_session",
    "openview_archive",
    "openview_restore",
    "refuse_board_archive",
    "board_archive",
    "board_restore",
    "board_create_purge_target",
    "board_archive_purge_target",
    "board_purge_preview",
    "board_purge",
    "sandbox_edit_publish",
    "sandbox_close_empty_publish",
    "sandbox_reopen_empty_publish",
    "sandbox_restore_publish",
]
PHASE_KINDS = frozenset(get_args(PhaseActionKind))


@dataclass(frozen=True)
class GroupMoveSpec:
    source_group_key: str
    destination_group_key: str


@dataclass(frozen=True)
class GroupAccessChangeSpec:
    group_key: str
    department_key: str
    module_key: str | None
    current_level: str
    replacement_level: str


@dataclass(frozen=True)
class DesignPhaseSpec:
    module_key: str
    renamed_module_name: str
    text_field_name: str
    select_field_key: str
    select_option_label: str
    new_module_key: str
    new_module_name: str
    new_module_department_key: str
    new_module_title_field_name: str


@dataclass(frozen=True)
class PackPhaseData:
    """Per-pack choices; selection and execution rules stay pack-neutral."""

    group_move: GroupMoveSpec
    group_access_change: GroupAccessChangeSpec
    openview_department_candidates: tuple[str, ...]
    existing_project_board: tuple[str, str]
    purge_project_board_name: str
    purge_project_board_department: str
    design: DesignPhaseSpec


@dataclass(frozen=True)
class PhaseAction:
    """One planned UI action with explicit attribution and expected final state."""

    key: str
    phase: PhaseName
    kind: PhaseActionKind
    actor_key: str
    target_key: str
    values: dict[str, PhaseJsonValue]
    expected_status: int
    expected_detail: str | None
    expected_end_state: dict[str, PhaseJsonValue]

    def __post_init__(self) -> None:
        if self.kind not in PHASE_KINDS:
            raise ValueError(f"Unknown phase action kind: {self.kind}")
        if not self.key or not self.actor_key or not self.target_key:
            raise ValueError("Phase action key, actor and target are required")
        if not 100 <= self.expected_status <= 599:
            raise ValueError("Phase action status must be an HTTP status code")
