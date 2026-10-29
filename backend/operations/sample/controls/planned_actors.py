"""Which account a planned control step runs as: the pack administrator, a member or the operator.

The pack administrator runs the organization. The installation operator runs only the steps
that need the installation owner (backups, installation security fields, restoring a removed
account), and is the administrator of the run's partner organization.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset

OPERATOR = "operator"
OPERATOR_ACTIONS = frozenset(
    {
        "control:backups:review_backup_status",
        "control:backups:update_restore_backup_policy",
        "control:backups:queue_backup",
        "control:backups:review_backup_history",
        "control:backups:review_version",
        "control:backups:physical_backup_export",
        "control:update-workspace-security",
        "controls:access:restore_guest",
    }
)


def partner_action(values: Mapping[str, object]) -> bool:
    return values.get("organization") == "partner"


def shared_member_keys(dataset: SampleDataset) -> frozenset[str]:
    """Members the controls add to the partner organization before the phases run.

    The account control's actor accepts a partner invitation and the Comms partner pair is
    invited there. A pack administrator then changes only such a person's membership, never
    the account (owner decision 2026-10-16): a disable keeps the sessions and an ended
    session is refused. Phases that act on the account must pick someone else.
    """
    if dataset.organization.phases is None:
        return frozenset()
    from operations.sample.controls.account import plan_account_controls
    from operations.sample.controls.comms_structure import plan_structure_controls
    from operations.sample.controls.comms_structure_common import member_keys

    keys = {plan_account_controls(dataset)[0].actor_key}
    for action in plan_structure_controls(dataset):
        if partner_action(action.values):
            keys.update(member_keys(action))
    return frozenset(keys)


def planned_actor_id(
    action_key: str,
    values: Mapping[str, object],
    actor_key: str,
    *,
    admin_id: str,
    operator_id: object,
    actors: Mapping[str, object],
) -> str | None:
    """The expected account ID of one planned step, or None when the step may not use it."""
    operator = operator_id if isinstance(operator_id, str) and operator_id else None
    if actor_key == OPERATOR:
        return operator if action_key in OPERATOR_ACTIONS else None
    if actor_key == "admin":
        return operator if partner_action(values) else admin_id
    value = actors.get(actor_key)
    return value if isinstance(value, str) else None
