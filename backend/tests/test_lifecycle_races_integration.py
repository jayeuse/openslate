"""Coordinated PostgreSQL races for lifecycle locking and audit atomicity."""

from __future__ import annotations

import os
from dataclasses import dataclass
from threading import Barrier, Event, Lock, Thread
from unittest.mock import patch
from uuid import UUID

import pytest
from sqlalchemy import bindparam, create_engine, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.models import AuditLog
from app.systems.departments.models import Department
from app.systems.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
    LifecycleUnavailable,
)
from app.systems.lifecycle.planner import plan_lifecycle
from app.systems.lifecycle.schemas import LifecycleOperation, LifecycleTargetType
from app.systems.lifecycle.service import execute_lifecycle
from app.systems.modules.models import Module
from tests.conftest import _guard_integration_database

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


@dataclass(frozen=True)
class _LifecycleRaceFixture:
    department_id: UUID
    module_id: UUID


@dataclass(frozen=True)
class _LifecycleOutcome:
    request_id: UUID
    succeeded: bool
    error: BaseException | None = None


def _owner_url() -> str:
    for variable in ("MIGRATION_DATABASE_URL", "TEST_DATABASE_URL"):
        database_url = os.getenv(variable)
        if database_url is None:
            continue
        _guard_integration_database(database_url)
        engine = create_engine(database_url)
        try:
            with engine.connect() as connection:
                is_owner = connection.scalar(
                    text(
                        """
                        SELECT current_user = pg_get_userbyid(c.relowner)
                        FROM pg_class AS c
                        JOIN pg_namespace AS n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname = 'departments'
                        """
                    )
                )
                connection.rollback()
                if is_owner is True:
                    return database_url
        finally:
            engine.dispose()
    raise RuntimeError("An owner-capable local database URL is required")


def _runtime_url() -> str:
    runtime_url = os.getenv("DATABASE_URL")
    if runtime_url is None:
        raise RuntimeError("DATABASE_URL is required for lifecycle races")
    _guard_integration_database(runtime_url)
    engine = create_engine(runtime_url)
    try:
        with engine.connect() as connection:
            role = connection.scalar(text("SELECT current_user"))
            connection.rollback()
        if role != "openslate_runtime":
            raise RuntimeError("DATABASE_URL must connect as openslate_runtime")
    finally:
        engine.dispose()
    return runtime_url


def _seed_committed_scope(ids: set[UUID]) -> _LifecycleRaceFixture:
    owner_engine = create_engine(_owner_url())
    try:
        with owner_engine.connect() as connection:
            database = AuditSession(bind=connection, expire_on_commit=False)
            database.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_id=uuid7(),
                request_method="POST",
                request_path="/api/lifecycle/race-seed",
            )
            try:
                token = uuid7().hex
                department = Department(department_name=f"Lifecycle race {token}")
                module = Module(
                    department=department,
                    module_name=f"Lifecycle race module {token}",
                    is_schema_accepted=True,
                )
                database.add_all([department, module])
                database.flush()
                database.commit()
                ids.update({department.id, module.id})
                return _LifecycleRaceFixture(department.id, module.id)
            finally:
                database.close()
    finally:
        owner_engine.dispose()


def _cleanup(ids: set[UUID]) -> None:
    if not ids:
        return
    engine = create_engine(_owner_url())
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "DELETE FROM public.audit_logs WHERE entity_id IN :ids"
                ).bindparams(bindparam("ids", expanding=True)),
                {"ids": list(ids)},
            )
            for table in ("modules", "departments"):
                connection.execute(
                    text(f"DELETE FROM public.{table} WHERE id IN :ids").bindparams(
                        bindparam("ids", expanding=True)
                    ),
                    {"ids": list(ids)},
                )
    finally:
        engine.dispose()


def _run_lifecycle(
    runtime_url: str,
    target_id: UUID,
    gate: Barrier,
    started: Event,
    finished: Event,
    outcomes: dict[int, _LifecycleOutcome],
    outcomes_lock: Lock,
    index: int,
) -> None:
    request_id = uuid7()
    started.set()
    outcome = _LifecycleOutcome(
        request_id=request_id,
        succeeded=False,
        error=RuntimeError("lifecycle race worker failed before opening its session"),
    )
    engine = create_engine(runtime_url, pool_size=1, max_overflow=0)
    try:
        try:
            with engine.connect() as connection:
                database = AuditSession(bind=connection)
                database.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=request_id,
                    request_method="POST",
                    request_path=f"/api/lifecycle/race/{index}",
                )
                try:
                    plan = plan_lifecycle(
                        database,
                        LifecycleTargetType.DEPARTMENT,
                        target_id,
                        LifecycleOperation.CLOSE,
                        None,
                    )
                    gate.wait(timeout=10)
                    execute_lifecycle(database, plan)
                    outcome = _LifecycleOutcome(request_id=request_id, succeeded=True)
                except (LifecyclePlanDriftError, LifecycleUnavailable) as error:
                    outcome = _LifecycleOutcome(request_id=request_id, succeeded=False, error=error)
                except BaseException as error:  # pragma: no cover - preserves thread failures
                    outcome = _LifecycleOutcome(request_id=request_id, succeeded=False, error=error)
                finally:
                    database.rollback()
                    database.close()
        except BaseException as error:  # pragma: no cover - preserves thread failures
            outcome = _LifecycleOutcome(request_id=request_id, succeeded=False, error=error)
    finally:
        engine.dispose()
        with outcomes_lock:
            outcomes[index] = outcome
        finished.set()


def test_competing_lifecycle_closes_serialize_and_rollback_audit_atomically(
    integration_db: Session,
) -> None:
    owned_ids: set[UUID] = set()
    fixture = _seed_committed_scope(owned_ids)
    try:
        runtime_url = _runtime_url()
        gate = Barrier(2)
        started = [Event(), Event()]
        finished = [Event(), Event()]
        outcomes: dict[int, _LifecycleOutcome] = {}
        outcomes_lock = Lock()
        threads = [
            Thread(
                target=_run_lifecycle,
                args=(
                    runtime_url,
                    fixture.department_id,
                    gate,
                    started[index],
                    finished[index],
                    outcomes,
                    outcomes_lock,
                    index,
                ),
            )
            for index in range(2)
        ]
        for thread in threads:
            thread.start()
        assert all(event.wait(timeout=10) for event in started)
        completed = all(event.wait(timeout=15) for event in finished)
        for thread in threads:
            thread.join(timeout=1)
            assert not thread.is_alive(), "lifecycle race worker did not finish"
        assert completed

        assert set(outcomes) == {0, 1}
        winners = [outcome for outcome in outcomes.values() if outcome.succeeded]
        losers = [outcome for outcome in outcomes.values() if not outcome.succeeded]
        assert len(winners) == 1
        assert len(losers) == 1
        assert isinstance(losers[0].error, (LifecyclePlanDriftError, LifecycleUnavailable))

        observer_engine = create_engine(_owner_url())
        try:
            with observer_engine.connect() as connection:
                state = connection.execute(
                    select(Department.is_deleted, Module.is_deleted).join(
                        Module, Module.department_id == Department.id
                    ).where(Department.id == fixture.department_id)
                ).one()
                audit_rows = list(
                    connection.execute(
                        select(AuditLog.request_id, AuditLog.entity_id).where(
                            AuditLog.request_id.in_(
                                [outcome.request_id for outcome in outcomes.values()]
                            )
                        )
                    ).all()
                )
                connection.rollback()
        finally:
            observer_engine.dispose()

        assert state == (True, True)
        winner_ids = {outcome.request_id for outcome in winners}
        loser_ids = {outcome.request_id for outcome in losers}
        assert audit_rows
        assert {row.request_id for row in audit_rows} <= winner_ids
        assert not loser_ids.intersection({row.request_id for row in audit_rows})
        assert {row.entity_id for row in audit_rows} == set(owned_ids)
    finally:
        _cleanup(owned_ids)


def test_lifecycle_commit_failure_rolls_back_rows_and_audit_for_observer(
    integration_db: Session,
) -> None:
    owned_ids: set[UUID] = set()
    fixture = _seed_committed_scope(owned_ids)
    try:
        request_id = uuid7()
        runtime_engine = create_engine(_runtime_url())
        try:
            with runtime_engine.connect() as connection:
                database = AuditSession(bind=connection)
                database.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=request_id,
                    request_method="POST",
                    request_path="/api/lifecycle/rollback-race",
                )
                try:
                    plan = plan_lifecycle(
                        database,
                        LifecycleTargetType.DEPARTMENT,
                        fixture.department_id,
                        LifecycleOperation.CLOSE,
                        None,
                    )

                    def flush_then_fail() -> None:
                        database.flush()
                        raise IntegrityError(
                            "forced lifecycle rollback", {}, RuntimeError("forced")
                        )

                    with patch.object(database, "commit", side_effect=flush_then_fail):
                        with pytest.raises(LifecyclePreflightError):
                            execute_lifecycle(database, plan)
                finally:
                    database.rollback()
                    database.close()
        finally:
            runtime_engine.dispose()

        observer_engine = create_engine(_owner_url())
        try:
            with observer_engine.connect() as connection:
                state = connection.execute(
                    select(Department.is_deleted, Module.is_deleted).join(
                        Module, Module.department_id == Department.id
                    ).where(Department.id == fixture.department_id)
                ).one()
                audit_count = connection.scalar(
                    select(func.count()).select_from(AuditLog).where(
                        AuditLog.request_id == request_id
                    )
                )
                connection.rollback()
        finally:
            observer_engine.dispose()

        assert state == (False, False)
        assert audit_count == 0
    finally:
        _cleanup(owned_ids)
