"""Coordinated PostgreSQL races for relationship cardinality mutations."""

from __future__ import annotations

import os
from dataclasses import dataclass
from threading import Barrier, Event, Lock, Thread
from uuid import UUID

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.models import AuditLog
from app.systems.fields.models import Field
from app.systems.fields.router import update_field
from app.systems.fields.schemas import FieldUpdate
from app.systems.relationships.errors import RelationshipConflict, RelationshipUnavailable
from app.systems.relationships.models import RelationshipEdge
from app.systems.relationships.mutations import assign_relationship
from tests.conftest import _guard_integration_database

pytest_plugins = ("tests.relationships_integration_support",)

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


@dataclass(frozen=True)
class _RaceOutcome:
    request_id: UUID
    edge_id: UUID | None = None
    field_updated: bool = False
    error: BaseException | None = None


def _runtime_url() -> str:
    runtime_url = os.getenv("DATABASE_URL")
    if runtime_url is None:
        raise RuntimeError("DATABASE_URL is required for runtime relationship races")
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


def _run_assignment(
    runtime_url: str,
    field_id: UUID,
    source_id: UUID,
    target_id: UUID,
    gate: Barrier,
    started: Event,
    finished: Event,
    outcomes: dict[int, _RaceOutcome],
    outcomes_lock: Lock,
    index: int,
) -> None:
    request_id = uuid7()
    started.set()
    outcome = _RaceOutcome(
        request_id=request_id,
        error=RuntimeError("relationship race worker failed before opening its session"),
    )
    engine = create_engine(runtime_url, pool_size=1, max_overflow=0)
    try:
        try:
            with engine.connect() as connection:
                database = AuditSession(bind=connection)
                database.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=request_id,
                    request_method="PUT",
                    request_path=f"/api/relationships/race/{index}",
                )
                try:
                    gate.wait(timeout=10)
                    edge = assign_relationship(database, field_id, source_id, target_id)
                    outcome = _RaceOutcome(request_id=request_id, edge_id=edge.id if edge else None)
                except (RelationshipConflict, RelationshipUnavailable) as error:
                    outcome = _RaceOutcome(request_id=request_id, error=error)
                except BaseException as error:  # pragma: no cover - preserves thread failures
                    outcome = _RaceOutcome(request_id=request_id, error=error)
                finally:
                    database.rollback()
                    database.close()
        except BaseException as error:  # pragma: no cover - preserves thread failures
            outcome = _RaceOutcome(request_id=request_id, error=error)
    finally:
        engine.dispose()
        with outcomes_lock:
            outcomes[index] = outcome
        finished.set()


def _run_cardinality_update(
    runtime_url: str,
    field_id: UUID,
    gate: Barrier,
    started: Event,
    finished: Event,
    outcomes: dict[int, _RaceOutcome],
    outcomes_lock: Lock,
    index: int,
) -> None:
    request_id = uuid7()
    started.set()
    outcome = _RaceOutcome(
        request_id=request_id,
        error=RuntimeError("cardinality race worker failed before opening its session"),
    )
    engine = create_engine(runtime_url, pool_size=1, max_overflow=0)
    try:
        try:
            with engine.connect() as connection:
                database = AuditSession(bind=connection)
                database.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=request_id,
                    request_method="PATCH",
                    request_path=f"/api/fields/{field_id}/race",
                )
                try:
                    gate.wait(timeout=10)
                    update_field(
                        field_id,
                        FieldUpdate(relationship_multiple_sources=False),
                        None,
                        database,
                    )
                    outcome = _RaceOutcome(request_id=request_id, field_updated=True)
                except (RelationshipConflict, RelationshipUnavailable) as error:
                    outcome = _RaceOutcome(request_id=request_id, error=error)
                except BaseException as error:  # pragma: no cover - preserves thread failures
                    outcome = _RaceOutcome(request_id=request_id, error=error)
                finally:
                    database.rollback()
                    database.close()
        except BaseException as error:  # pragma: no cover - preserves thread failures
            outcome = _RaceOutcome(request_id=request_id, error=error)
    finally:
        engine.dispose()
        with outcomes_lock:
            outcomes[index] = outcome
        finished.set()


def test_competing_assignments_keep_single_target_cardinality_valid(
    integration_db: Session,
    owned_ids: set[UUID],
) -> None:
    from tests.relationships_integration_support import _seed_committed_graph

    field, _, _, sources, targets, _ = _seed_committed_graph(
        owned_ids,
        record_count=2,
    )
    runtime_url = _runtime_url()
    gate = Barrier(2)
    started = [Event(), Event()]
    finished = [Event(), Event()]
    outcomes: dict[int, _RaceOutcome] = {}
    outcomes_lock = Lock()
    threads = [
        Thread(
            target=_run_assignment,
            args=(
                runtime_url,
                field.id,
                sources[0].id,
                targets[index].id,
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
        assert not thread.is_alive(), "relationship race worker did not finish"
    assert completed

    assert set(outcomes) == {0, 1}
    assert all(outcome.error is None or isinstance(
        outcome.error, (RelationshipConflict, RelationshipUnavailable)
    ) for outcome in outcomes.values())
    assert any(outcome.edge_id is not None for outcome in outcomes.values())

    observer_engine = create_engine(runtime_url)
    try:
        with observer_engine.connect() as connection:
            active_edges = list(
                connection.execute(
                    select(RelationshipEdge.id).where(
                        RelationshipEdge.field_id == field.id,
                        RelationshipEdge.source_record_id == sources[0].id,
                        RelationshipEdge.is_deleted.is_(False),
                    )
                ).scalars()
            )
            audit_rows = list(
                connection.execute(
                    select(AuditLog.request_id, AuditLog.entity_id).where(
                        AuditLog.request_id.in_(
                            [outcome.request_id for outcome in outcomes.values()]
                        ),
                        AuditLog.entity_type == "relationship_edges",
                    )
                ).all()
            )
            connection.rollback()
    finally:
        observer_engine.dispose()

    assert len(active_edges) == 1
    assert active_edges[0] in {
        outcome.edge_id for outcome in outcomes.values() if outcome.edge_id is not None
    }
    assert audit_rows
    owned_ids.update(active_edges)


def test_assignment_race_with_cardinality_tightening_preserves_valid_edges(
    integration_db: Session,
    owned_ids: set[UUID],
) -> None:
    from tests.relationships_integration_support import (
        _add_edge,
        _seed_committed_graph,
        _set_request,
    )

    field, _, _, sources, targets, _ = _seed_committed_graph(
        owned_ids,
        record_count=2,
    )
    owner_engine = create_engine(TEST_DATABASE_URL)
    try:
        with owner_engine.connect() as connection:
            database = AuditSession(bind=connection, expire_on_commit=False)
            _set_request(database, uuid7())
            persisted_field = database.get(Field, field.id)
            assert persisted_field is not None
            persisted_field.relationship_multiple_sources = True
            database.flush()
            database.commit()
            _add_edge(database, owned_ids, field, sources[1], targets[0])
            database.close()
    finally:
        owner_engine.dispose()

    runtime_url = _runtime_url()
    gate = Barrier(2)
    started = [Event(), Event()]
    finished = [Event(), Event()]
    outcomes: dict[int, _RaceOutcome] = {}
    outcomes_lock = Lock()
    threads = [
        Thread(
            target=_run_assignment,
            args=(
                runtime_url,
                field.id,
                sources[0].id,
                targets[0].id,
                gate,
                started[0],
                finished[0],
                outcomes,
                outcomes_lock,
                0,
            ),
        ),
        Thread(
            target=_run_cardinality_update,
            args=(
                runtime_url,
                field.id,
                gate,
                started[1],
                finished[1],
                outcomes,
                outcomes_lock,
                1,
            ),
        ),
    ]
    for thread in threads:
        thread.start()
    assert all(event.wait(timeout=10) for event in started)
    completed = all(event.wait(timeout=15) for event in finished)
    for thread in threads:
        thread.join(timeout=1)
        assert not thread.is_alive(), "relationship cardinality race worker did not finish"
    assert completed

    assert set(outcomes) == {0, 1}
    assert all(
        outcome.error is None
        or isinstance(outcome.error, (RelationshipConflict, RelationshipUnavailable))
        for outcome in outcomes.values()
    )
    assignment = outcomes[0]
    cardinality = outcomes[1]
    assert (assignment.edge_id is not None) ^ cardinality.field_updated

    observer_engine = create_engine(runtime_url)
    try:
        with observer_engine.connect() as connection:
            state = connection.execute(
                select(
                    RelationshipEdge.id,
                    RelationshipEdge.is_deleted,
                    RelationshipEdge.source_record_id,
                    RelationshipEdge.target_record_id,
                ).where(
                    RelationshipEdge.field_id == field.id,
                    RelationshipEdge.is_deleted.is_(False),
                )
            ).all()
            field_state = connection.execute(
                select(Field.relationship_multiple_sources).where(Field.id == field.id)
            ).scalar_one()
            audit_rows = list(
                connection.execute(
                    select(AuditLog.request_id).where(
                        AuditLog.request_id.in_([assignment.request_id, cardinality.request_id])
                    )
                ).scalars()
            )
            connection.rollback()
    finally:
        observer_engine.dispose()

    owned_ids.update(row[0] for row in state)
    assert field_state == (not cardinality.field_updated)
    if cardinality.field_updated:
        assert len(state) == 1
        assert state[0].source_record_id == sources[1].id
    else:
        assert len(state) == 2
        assert {row.source_record_id for row in state} == {sources[0].id, sources[1].id}
    expected_audit_requests = {
        outcome.request_id
        for outcome in (assignment, cardinality)
        if outcome.edge_id is not None or outcome.field_updated
    }
    assert set(audit_rows) == expected_audit_requests
