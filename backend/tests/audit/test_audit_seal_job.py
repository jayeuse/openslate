"""The seal job as the runtime, on a controlled clock (plan step 2.5, S4 to S7, S9).

S8 has no case: `ck_workspace_profiles_not_deleted` forbids a soft-deleted organization.
"""

import re
from datetime import timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.manage.audit import seals
from app.systems.manage.audit.seals import seal_audit, seal_chain
from tests.audit.seal_support import DAY, SealWorld, add_audit_row, hour_of, sealed_hours
from tests.audit.seal_support import world as world
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration

EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_the_first_wake_seals_every_chain_from_its_start_with_its_empty_hours(
    world: SealWorld,
) -> None:
    with world.engines.owner.begin() as connection:
        for minute in (10, 20):
            add_audit_row(connection, DAY + timedelta(minutes=minute), world.first)
        # Exactly on an hour: the hour that starts there holds it. 00:00 also starts the
        # chain and its first span.
        add_audit_row(connection, DAY, world.first)
        add_audit_row(connection, hour_of(1, 5), world.first)
        add_audit_row(connection, hour_of(1, 1) + timedelta(minutes=15), world.second)
        add_audit_row(connection, DAY + timedelta(minutes=40), None)

    result = seal_audit(world.engines.runtime, now=hour_of(3, 0))

    assert result == seals.SealPass(backlog=False)
    # The horizon is 22:00 on 2 January: 46 hours, sealed in two spans of one wake.
    every_hour = [hour_of(1, 0) + timedelta(hours=step) for step in range(46)]
    for org_id, counts in (
        (world.first, {hour_of(1, 0): 3, hour_of(1, 5): 1}),
        (world.second, {hour_of(1, 1): 1}),
        (None, {hour_of(1, 0): 1}),
    ):
        assert sealed_hours(world.engines, org_id) == {
            hour: counts.get(hour, 0) for hour in every_hour
        }, org_id
    with world.engines.owner.connect() as connection:
        empty = connection.scalar(
            text(
                "SELECT encode(rows_hash, 'hex') FROM public.audit_seals "
                "WHERE org_id = :org AND hour_start = :hour"
            ),
            {"org": world.first, "hour": hour_of(1, 1)},
        )
    assert empty == EMPTY_HASH


def test_an_hour_waits_for_the_seal_delay_on_the_worker_clock(world: SealWorld) -> None:
    ready = hour_of(1, 0) + timedelta(hours=1) + seals.SEAL_DELAY

    seal_chain(world.engines.runtime, world.first, ready - timedelta(microseconds=1))
    assert sealed_hours(world.engines, world.first) == {}

    seal_chain(world.engines.runtime, world.first, ready)
    assert sealed_hours(world.engines, world.first) == {hour_of(1, 0): 0}


def test_a_ten_day_backlog_takes_two_wakes_of_at_most_a_week_for_each_chain(
    world: SealWorld,
) -> None:
    # The horizon is 00:00 on 11 January: 240 hours for each chain. Its own installation row
    # starts the installation chain here, whatever rows other tests left.
    with world.engines.owner.begin() as connection:
        add_audit_row(connection, DAY + timedelta(minutes=40), None)
    now = hour_of(11, 2)

    first = seal_audit(world.engines.runtime, now=now)
    counts = {org_id: len(sealed_hours(world.engines, org_id)) for org_id in (world.first, None)}
    second = seal_audit(world.engines.runtime, now=now)

    assert (first.backlog, counts) == (True, {world.first: 168, None: 168})
    assert second.backlog is False
    assert len(sealed_hours(world.engines, world.first)) == 240
    assert len(sealed_hours(world.engines, None)) == 240


def test_a_chain_that_another_process_is_sealing_is_skipped(world: SealWorld) -> None:
    now = hour_of(1, 6)
    # A separate connection: an advisory lock is re-entrant on its own session.
    with world.engines.owner.connect() as holder:
        holder.execute(
            text("SELECT pg_advisory_lock(:key, hashtext(:chain))"),
            {"key": seals._LOCK_CLASS, "chain": str(world.first)},
        )
        assert seal_chain(world.engines.runtime, world.first, now) is False
        assert sealed_hours(world.engines, world.first) == {}
        seal_chain(world.engines.runtime, world.second, now)
        holder.rollback()
        holder.execute(text("SELECT pg_advisory_unlock_all()"))

    seal_chain(world.engines.runtime, world.first, now)
    seal_chain(world.engines.runtime, world.first, now)

    assert sealed_hours(world.engines, world.first) == {
        hour_of(1, hour): 0 for hour in range(4)
    }
    assert len(sealed_hours(world.engines, world.second)) == 4


def test_a_duplicate_id_is_logged_and_its_hour_is_sealed(
    world: SealWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    logger = Mock()
    monkeypatch.setattr(seals, "log_event", logger)
    with world.engines.owner.begin() as connection:
        row_id = add_audit_row(connection, hour_of(1, 0) + timedelta(minutes=5), world.first)
        add_audit_row(connection, hour_of(1, 0) + timedelta(minutes=6), world.first, id=row_id)

    seal_chain(world.engines.runtime, world.first, hour_of(1, 4))

    assert sealed_hours(world.engines, world.first) == {hour_of(1, 0): 2, hour_of(1, 1): 0}
    assert [
        (call.kwargs["reason_code"], call.kwargs["org_id"], call.kwargs["count"])
        for call in logger.call_args_list
    ] == [("audit_duplicate_id", world.first, 1)]


def test_a_competing_seal_is_kept_and_any_other_write_failure_is_raised(
    world: SealWorld, monkeypatch: pytest.MonkeyPatch
) -> None:
    competing = uuid7()
    with world.engines.owner.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.audit_seals (id, org_id, hour_start, row_count, rows_hash, "
                "chain_hash, form, sealed_at) VALUES (:id, :org, :hour, 0, :rows, :chain, 1, "
                "now())"
            ),
            {
                "id": competing, "org": world.first, "hour": DAY, "rows": seals.EMPTY_HASH,
                "chain": seals.chain_hash(seals.FIRST_PREVIOUS, world.first, DAY, 0,
                                          seals.EMPTY_HASH),
            },
        )
    # This process read the chain before the other one sealed 00:00.
    real_latest = seals.latest_seal
    stale = [True]

    def latest(db, org_id):
        return None if stale and stale.pop() else real_latest(db, org_id)

    monkeypatch.setattr(seals, "latest_seal", latest)

    seal_chain(world.engines.runtime, world.first, hour_of(1, 6))

    assert sealed_hours(world.engines, world.first) == {hour_of(1, hour): 0 for hour in range(4)}
    with world.engines.owner.connect() as connection:
        assert connection.scalar(
            text("SELECT id FROM public.audit_seals WHERE org_id = :org AND hour_start = :hour"),
            {"org": world.first, "hour": DAY},
        ) == competing

    monkeypatch.setattr(seals, "chain_hash", lambda *_arguments: bytes(31))
    with pytest.raises(IntegrityError) as refused:
        seal_chain(world.engines.runtime, world.second, hour_of(1, 6))
    assert getattr(refused.value.orig, "sqlstate", None) == "23514"
    assert sealed_hours(world.engines, world.second) == {}


def test_the_chain_hash_refuses_an_hour_that_is_not_whole() -> None:
    # The hash holds whole seconds, so 00:00:00.5 would share the hash of 00:00.
    with pytest.raises(ValueError, match="whole UTC hour"):
        seals.chain_hash(
            seals.FIRST_PREVIOUS, None, DAY + timedelta(milliseconds=500), 0, seals.EMPTY_HASH
        )


def test_the_row_form_names_every_audit_column(integration_owner_db: Session) -> None:
    # A column that the form leaves out could change with no seal noticing (Architect N5).
    columns = integration_owner_db.connection().scalars(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'audit_logs'"
        )
    )
    named = set(re.findall(r"[a-z_]+", seals.CANONICAL_ROW))

    assert sorted(set(columns) - named) == []
