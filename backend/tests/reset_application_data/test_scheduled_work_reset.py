"""Static table, order, target, and migration contracts for local reset."""

from pathlib import Path

import pytest

from app.core.config.instance import InstanceTarget
from operations import reset_application_data as reset
from operations.reset import models as reset_models
from operations.reset import planning as reset_planning
from tests.conftest import alembic_heads
from tests.reset_application_data.execution_support import apply_confirmed

# Each table the reset counts, locks and clears: whether it is a non-preserved table, and
# the tables whose rows it must be deleted before. The reset deletes every Board, then
# restores the one company Board, so `boards` is in the delete order but not non-preserved.
RESET_TABLES = (
    ("identity_mfa_observations", True, ()),
    ("saved_views", True, ()),
    ("board_groups", True, ("boards", "groups")),
    ("board_widgets", True, ("boards",)),
    ("board_posts", True, ("boards", "departments")),
    ("board_attachments", True, ("boards",)),
    ("boards", False, ("departments",)),
    ("board_post_revisions", True, ("board_posts",)),
    ("board_record_links", True, ("records", "boards")),
    ("board_event_reminders", True, ("boards", "board_events")),
    ("board_events", True, ("boards",)),
    ("dashboard_widgets", True, ("dashboards",)),
    ("dashboards", True, ("departments",)),
    ("reports", True, ("modules",)),
    ("report_run_rows", True, ("report_runs", "records")),
    ("report_run_eligible_users", True, ("report_runs",)),
    ("report_runs", True, ("reports",)),
    ("in_app_notifications", True, ("scheduled_work",)),
    ("report_schedules", True, ("scheduled_work", "reports")),
    (
        "scheduled_work",
        True,
        ("report_runs", "reports", "board_event_reminders", "board_post_revisions"),
    ),
    ("group_access", True, ("groups", "modules")),
    ("group_members", True, ("groups",)),
    ("groups", True, ("departments",)),
)
# Retired tables the reset must no longer list, lock, or delete.
RETIRED_TABLES = (
    "saved_view_defaults",
    "dashboard_defaults",
    "openview_chart_preferences",
    "board_grants",
    "board_record_placements",
    "board_favorites",
    "board_homes",
    "board_templates",
    "board_announcement_personal_states",
)


@pytest.mark.parametrize(
    ("table", "non_preserved", "deleted_before"),
    RESET_TABLES,
    ids=[row[0] for row in RESET_TABLES],
)
def test_reset_counts_locks_and_deletes_each_table_before_its_parents(
    table, non_preserved, deleted_before
) -> None:
    assert table in reset_models.APPLICATION_TABLES
    assert (table in reset_models.NON_PRESERVED_TABLES) is non_preserved
    assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
    assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS
    assert table in reset_models.DELETE_ORDER
    order = reset_models.DELETE_ORDER
    for parent in deleted_before:
        assert order.index(table) < order.index(parent), parent


@pytest.mark.parametrize("table", RETIRED_TABLES)
def test_reset_no_longer_lists_locks_or_deletes_a_retired_table(table) -> None:
    assert table not in reset_models.APPLICATION_TABLES
    assert table not in reset_models.DELETE_ORDER
    assert f"public.{table}" not in reset_models._LOCK_APPLICATION_STATEMENT


def test_reset_derives_the_single_current_alembic_head() -> None:
    heads = alembic_heads()
    assert len(heads) == 1
    [head] = heads
    assert reset_planning._expected_alembic_head() == head


def test_reset_rejects_urls_that_do_not_match_the_attested_instance() -> None:
    target = InstanceTarget(
        instance_id="openslate-supabase-a1b2c3d4",
        host="127.0.0.1",
        port=55432,
        database="postgres",
        attestation_path=Path("/tmp/instance.json"),
    )
    local = "postgresql+psycopg://openslate_owner:secret@127.0.0.1:55432/postgres"
    assert reset.validate_local_database_url(local, target) is None
    with pytest.raises(reset.ResetError):
        reset.validate_local_database_url(local)
    for url in (
        local.replace("127.0.0.1", "remote.example"),
        local.replace("openslate_owner", "openslate_runtime"),
        local.replace("55432", "54322"),
        local.replace("/postgres", "/other_database"),
    ):
        with pytest.raises(reset.ResetError):
            reset.validate_local_database_url(url, target)
    with pytest.raises(reset.ResetError):
        reset.required_environment({"DATABASE_URL": local, "ADMIN_EMAIL": "admin@example.test"})
    with pytest.raises(reset.ResetError):
        reset.required_storage_environment(
            {"BACKEND_BIND_HOST": "127.0.0.1", "BACKEND_PORT": "8000"}
        )


def test_reset_preserves_and_locks_backup_policy_history_and_version_tables() -> None:
    for table in ("backup_export_operations", "backup_policies", "backup_runs", "update_statuses"):
        assert table in reset_models.APPLICATION_TABLES
        assert table not in reset_models.NON_PRESERVED_TABLES
        assert table not in reset_models.DELETE_ORDER
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
        assert (table, f"SELECT count(*) FROM public.{table}") in reset_models._COUNT_STATEMENTS


@pytest.mark.parametrize("column", ("snapshot_id", "claim_id", "latest_version", "revision"))
def test_reset_digest_freezes_backup_identity_results_policy_and_version(column) -> None:
    from types import SimpleNamespace

    from tests.reset_application_data.test_execution import _plan

    plan = _plan()
    plan.backup_snapshot = SimpleNamespace(
        installation_id="openslate-fixture", rows=(("backup_runs", ((column, "original"),)),)
    )
    changed = SimpleNamespace(**vars(plan))
    changed.backup_snapshot = SimpleNamespace(
        installation_id="openslate-fixture", rows=(("backup_runs", ((column, "changed"),)),)
    )
    assert reset_planning._impact_digest(changed) != reset_planning._impact_digest(plan)


@pytest.mark.parametrize("checkpoint", ("advisory", "tables"))
def test_unresolved_backup_checkpoint_precedes_auth_or_application_deletion(
    monkeypatch, checkpoint
) -> None:
    from unittest.mock import Mock

    from operations.reset import execution
    from tests.reset_application_data.test_execution import _auth, _plan

    plan, database, storage = _plan(), Mock(), Mock()
    plan.backup_snapshot = type("Snapshot", (), {"installation_id": "openslate-fixture"})()
    storage.list_object_keys.return_value = plan.storage_object_keys
    auth = _auth(plan)
    calls = []
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)
    monkeypatch.setattr(execution, "_begin_transaction", lambda *_: None)
    monkeypatch.setattr(
        execution, "_execute", lambda _connection, statement, *_args: calls.append(statement)
    )
    monkeypatch.setattr(execution, "_validate_postconditions", lambda *_a, **_k: None)

    def guard(*_):
        calls.append("backup_guard")
        if checkpoint == "advisory" or calls.count("backup_guard") == 2:
            raise reset.ResetError("Current backup requires reconciliation before reset")

    monkeypatch.setattr(execution, "require_no_unresolved_backup", guard, raising=False)
    with pytest.raises(
        reset.ResetError,
        match=("reconciliation" if checkpoint == "advisory" else "profiles were retained"),
    ):
        apply_confirmed(
            database,
            plan,
            storage=storage,
            auth=auth,
            build_plan_fn=lambda *_a, **_k: plan,
        )
    if checkpoint == "advisory":
        auth.delete_and_verify_missing.assert_not_called()
    else:
        auth.delete_and_verify_missing.assert_called_once()
        assert calls.index(reset._LOCK_APPLICATION_STATEMENT) < len(calls) - 1
    assert not any(call.startswith("DELETE FROM public.") for call in calls)


def _backup_database(rows, *, instance="openslate-fixture"):
    from unittest.mock import MagicMock

    database = MagicMock()
    cursor = database.cursor.return_value.__enter__.return_value
    current = [None, None]
    cursor.execute.side_effect = lambda statement, params=None: current.__setitem__(
        slice(None), [statement, params]
    )

    def fetchall():
        statement, params = current
        if "current_setting" in statement:
            return [(instance,)]
        if "SELECT count(*)" in statement:
            return [
                (
                    sum(
                        row["installation_id"] == params[0]
                        and row.get("started_at") is not None
                        and row.get("reconciled_at") is None
                        for row in rows["backup_runs"]
                    ),
                )
            ]
        for table, items in rows.items():
            if f"public.{table} " in statement:
                return [(dict(row),) for row in items]
        raise AssertionError("Unexpected backup snapshot statement")

    cursor.fetchall.side_effect = fetchall
    return database


def _backup_rows():
    from uuid import uuid4

    from tests.reset_application_data.test_execution import _plan

    admin = _plan().preserved_admin_id
    deleted = uuid4()
    queued, completed, foreign = uuid4(), uuid4(), uuid4()
    base = {"performed_by": str(deleted), "updated_at": "2026-10-03T00:00:00+00:00"}
    return (
        admin,
        deleted,
        {
            "backup_export_operations": [],
            "backup_policies": [dict(base, id=str(uuid4()), revision=2, schedule="weekly")],
            "update_statuses": [dict(base, id=str(uuid4()), latest_version="0.2.0")],
            "backup_runs": [
                dict(
                    base,
                    id=str(queued),
                    installation_id="openslate-fixture",
                    state="queued",
                    started_at=None,
                    claim_id=None,
                    requester_id=str(deleted),
                ),
                dict(
                    base,
                    id=str(completed),
                    installation_id="openslate-fixture",
                    state="succeeded",
                    started_at="2026-10-02T00:00:00+00:00",
                    reconciled_at="2026-10-02T00:05:00+00:00",
                    claim_id=str(uuid4()),
                    requester_id=str(admin),
                    snapshot_id="a" * 64,
                    manifest_sha256="b" * 64,
                    unexpected_future_column="retain-me",
                ),
                dict(
                    base,
                    id=str(foreign),
                    installation_id="previous-installation",
                    state="running",
                    started_at="2026-10-02T00:00:00+00:00",
                    reconciled_at=None,
                    claim_id=str(uuid4()),
                    requester_id=str(deleted),
                ),
            ],
        },
    )


def test_backup_snapshot_allows_only_owned_queue_deletion_and_deleted_user_nulling() -> None:
    from operations.reset.backups import read_backup_snapshot, validate_backup_preservation

    admin, _deleted, rows = _backup_rows()
    snapshot = read_backup_snapshot(_backup_database(rows))
    rows["backup_runs"].pop(0)
    for items in rows.values():
        for row in items:
            row["performed_by"] = None
            if row.get("requester_id") != str(admin) and "requester_id" in row:
                row["requester_id"] = None
    validate_backup_preservation(_backup_database(rows), snapshot, admin)


@pytest.mark.parametrize(
    "mutation",
    ("result", "future_column", "policy", "version", "timestamp", "foreign", "admin_attribution"),
)
def test_backup_preservation_rejects_same_count_metadata_drift(mutation) -> None:
    from operations.reset.backups import read_backup_snapshot, validate_backup_preservation

    admin, _deleted, rows = _backup_rows()
    snapshot = read_backup_snapshot(_backup_database(rows))
    rows["backup_runs"].pop(0)
    target = rows["backup_runs"][0]
    for items in rows.values():
        for row in items:
            row["performed_by"] = None
            if row.get("requester_id") != str(admin) and "requester_id" in row:
                row["requester_id"] = None
    changes = {
        "result": (target, "snapshot_id", "c" * 64),
        "future_column": (target, "unexpected_future_column", "changed"),
        "policy": (rows["backup_policies"][0], "revision", 3),
        "version": (rows["update_statuses"][0], "latest_version", "0.3.0"),
        "timestamp": (target, "updated_at", "2026-10-04T00:00:00+00:00"),
        "foreign": (rows["backup_runs"][1], "installation_id", "other-installation"),
        "admin_attribution": (target, "requester_id", None),
    }
    row, column, value = changes[mutation]
    row[column] = value
    with pytest.raises(reset.ResetError, match="backup metadata"):
        validate_backup_preservation(_backup_database(rows), snapshot, admin)


@pytest.mark.parametrize("state", ("running", "failed", "interrupted"))
def test_current_unresolved_backup_refuses_preview_regardless_of_state(state) -> None:
    from operations.reset.backups import read_backup_snapshot

    _admin, _deleted, rows = _backup_rows()
    rows["backup_runs"][2].update(installation_id="openslate-fixture", state=state)
    with pytest.raises(reset.ResetError, match="reconciliation"):
        read_backup_snapshot(_backup_database(rows))


@pytest.mark.parametrize("instance", (None, "", "unadmitted identity"))
def test_backup_snapshot_refuses_missing_or_invalid_connected_identity(instance) -> None:
    from operations.reset.backups import read_backup_snapshot

    _admin, _deleted, rows = _backup_rows()
    with pytest.raises(reset.ResetError, match="installation identity"):
        read_backup_snapshot(_backup_database(rows, instance=instance))
