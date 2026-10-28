"""Only installation steps run as the operator; the pack administrator runs everything else."""

from datetime import date
from uuid import NAMESPACE_URL, uuid5

import pytest

from operations.sample.controls.actions import plan_controls
from operations.sample.controls.manage import manage_request_contract
from operations.sample.controls.planned_actors import OPERATOR_ACTIONS, planned_actor_id
from operations.sample.packs.registry import get_pack
from operations.sample.scenario import build_dataset

ADMIN = str(uuid5(NAMESPACE_URL, "operator-steps:admin"))
OPERATOR = str(uuid5(NAMESPACE_URL, "operator-steps:operator"))
MEMBER = str(uuid5(NAMESPACE_URL, "operator-steps:member"))


def _dataset(pack_key, *, host=False):
    return build_dataset(
        "small", 83, date(2026, 10, 2), organization=get_pack(pack_key), host_acceptance=host
    )


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_operator_runs_exactly_the_installation_steps(pack_key):
    actions = plan_controls(_dataset(pack_key))
    operator = {action.key for action in actions if action.actor_key == "operator"}
    assert operator == {
        "control:backups:review_backup_status",
        "control:backups:update_restore_backup_policy",
        "control:backups:queue_backup",
        "control:backups:review_backup_history",
        "control:backups:review_version",
        "control:update-workspace-security",
        "controls:access:restore_guest",
    }
    assert operator <= OPERATOR_ACTIONS
    by_key = {action.key: action for action in actions}
    assert by_key["controls:access:delete_guest"].actor_key == "admin"
    assert by_key["control:revoke-admin-sessions"].actor_key == "admin"
    assert by_key["control:update-workspace-security"].target_key == "control:workspace-security"
    assert set(manage_request_contract(by_key["control:update-workspace-security"], _dataset(
        pack_key
    )).values()) == {("operator", "PATCH", "/api/workspace/security", 200)}


def test_host_export_reads_and_promotes_as_the_operator():
    from operations.sample.controls.host_delivery import plan_host_controls
    from operations.sample.controls.host_receipts import host_request_contract

    dataset = _dataset("harbor", host=True)
    (action,) = plan_host_controls(dataset)
    assert action.key in OPERATOR_ACTIONS
    contract = host_request_contract(
        action,
        {
            "actor_id": MEMBER,
            "export_id": MEMBER,
            "original_actor_group_ids": [MEMBER],
            "primary_actor_keys": [],
        },
    )
    owners = {step for step, row in contract.items() if row[0] == "operator"}
    assert {"owner_identity", "development_idle", "promote_actor", "restore_actor_role"} <= owners
    assert all(row[0] in {"operator", action.actor_key} for row in contract.values())


@pytest.mark.parametrize(
    ("key", "values", "actor", "expected"),
    (
        ("control:backups:queue_backup", {}, "operator", OPERATOR),
        ("controls:access:restore_guest", {}, "operator", OPERATOR),
        # The operator is refused wherever the plan does not declare an installation step.
        ("controls:access:delete_guest", {}, "operator", None),
        ("control:revoke-admin-sessions", {}, "operator", None),
        ("control:comms:primary-jobs", {"organization": "primary"}, "admin", ADMIN),
        # The operator is the partner organization's administrator.
        ("control:comms:partner-jobs", {"organization": "partner"}, "admin", OPERATOR),
        ("control:comms:partner-jobs", {"organization": "partner"}, "member", MEMBER),
        ("control:comms:partner-jobs", {"organization": "partner"}, "operator", None),
    ),
)
def test_planned_actor_ids_resolve_operator_only_where_declared(key, values, actor, expected):
    assert (
        planned_actor_id(
            key,
            values,
            actor,
            admin_id=ADMIN,
            operator_id=OPERATOR,
            actors={"member": MEMBER, "operator": MEMBER, "admin": MEMBER},
        )
        == expected
    )


def test_planned_actor_ids_refuse_a_missing_operator():
    assert (
        planned_actor_id(
            "control:backups:queue_backup",
            {},
            "operator",
            admin_id=ADMIN,
            operator_id=None,
            actors={},
        )
        is None
    )
