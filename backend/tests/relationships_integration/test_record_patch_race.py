"""Concurrent record saves and link creates resolve to one clear outcome over HTTP.

One request is paused inside its real code path after it holds the module and record
locks. The competing request starts only then, and the holder is released only after
PostgreSQL shows the competitor blocked behind it (pg_locks + pg_blocking_pids).
"""

import os
import threading
from collections.abc import Callable
from typing import Any
from uuid import UUID

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from tests.race_support import WAIT, StatementPause, join, start, wait_until_blocked_by
from tests.record_versions import record_version
from tests.relationships_integration.relationship_http_support import RelationshipHTTPFixture

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]
pytest_plugins = ("tests.relationships_integration.relationship_http_support",)

def _race(
    fixture: RelationshipHTTPFixture,
    prefix: str,
    first: Callable[[], httpx.Response],
    second: Callable[[], httpx.Response],
) -> tuple[httpx.Response, httpx.Response]:
    """Run ``first`` until it pauses at ``prefix``, block ``second`` behind it, then release."""

    pause = StatementPause(fixture.runtime_engine, prefix)
    started: list[tuple[threading.Thread, list[Any]]] = []
    try:
        started.append(start(first))
        assert pause.paused.wait(WAIT), "the first request never reached its pause point"
        started.append(start(second))
        wait_until_blocked_by(fixture.owner_engine, pause.holder_pid)
    finally:
        # Release first so a failed poll cannot hang the holder; remove the listener only
        # after both requests finished, because removal mutates the engine's listener list.
        pause.release.set()
        for thread, _ in started:
            thread.join(WAIT)
        pause.remove()
    first_response, second_response = (join(thread, results) for thread, results in started)
    assert isinstance(first_response, httpx.Response), f"first failed: {first_response!r}"
    assert isinstance(second_response, httpx.Response), f"second failed: {second_response!r}"
    return first_response, second_response


def _count(fixture: RelationshipHTTPFixture, sql: str, **params: object) -> int:
    with fixture.owner_engine.connect() as connection:
        return int(connection.scalar(text(sql), params) or 0)


def test_two_saves_with_the_same_if_match_keep_only_the_winner(
    relationship_http_fixture: RelationshipHTTPFixture,
) -> None:
    # A save that read the record before a concurrent save committed must not
    # overwrite it: the record lock re-reads updated_at, so the loser gets 412.
    fixture = relationship_http_fixture
    graph = fixture.graph
    assert graph is not None
    record_id = graph.target_id
    label_id = uuid7()
    with fixture.owner_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.fields "
                "(id, org_id, module_id, name, type, required, position, config, is_deleted) "
                "VALUES (:id, :org_id, :module_id, :name, 'text', false, 0, '{}'::jsonb, false)"
            ),
            {"id": label_id, "org_id": fixture.org_id,
             "module_id": graph.target_module_id, "name": f"Label {label_id}"},
        )
    try:
        with Session(fixture.runtime_engine) as database:
            version = record_version(database, record_id)
        winner, loser = fixture.client(), fixture.client()

        def save(client: Any, value: str) -> Callable[[], httpx.Response]:
            return lambda: client.patch(
                f"/api/records/{record_id}",
                json={"data": {str(label_id): value}},
                headers={"If-Match": version},
            )

        first, second = _race(
            fixture, "UPDATE RECORDS ", save(winner, "winner"), save(loser, "loser")
        )

        assert first.status_code == 200, first.text
        assert second.status_code == 412, second.text
        assert second.json() == {"detail": "Record changed"}
        with fixture.owner_engine.connect() as connection:
            data = connection.scalar(
                text("SELECT data FROM public.records WHERE id = :id"), {"id": record_id}
            )
        assert data[str(label_id)] == "winner"
        assert "loser" not in data.values()
        assert (
            _count(
                fixture,
                "SELECT count(*) FROM public.audit_logs "
                "WHERE entity_id = :id AND action = 'update'",
                id=record_id,
            )
            == 1
        )
        assert (
            _count(
                fixture,
                "SELECT count(*) FROM public.record_trigger_events WHERE record_id = :id",
                id=record_id,
            )
            == 1
        )
    finally:
        with fixture.owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.record_trigger_events WHERE record_id = :id"),
                {"id": record_id},
            )
            connection.execute(text("DELETE FROM public.fields WHERE id = :id"), {"id": label_id})


@pytest.mark.parametrize(
    ("same_target", "second_status", "edges"),
    [(True, 409, 1), (False, 201, 2)],
    ids=["same-pair", "two-targets"],
)
def test_two_link_creates_on_one_source_resolve_to_one_outcome(
    relationship_http_fixture: RelationshipHTTPFixture,
    same_target: bool,
    second_status: int,
    edges: int,
) -> None:
    # Both creates lock the same module and source rows. The second waits, then sees
    # the committed edge: the same pair is a duplicate, another target is a new link.
    fixture = relationship_http_fixture
    graph = fixture.graph
    assert graph is not None
    field_id = uuid7()
    with fixture.owner_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.fields "
                "(id, org_id, module_id, name, type, required, position, config, "
                "relationship_target_module_id, relationship_multiple_targets, "
                "relationship_multiple_sources, is_deleted) VALUES "
                "(:id, :org_id, :module_id, :name, 'relationship', false, 3, '{}'::jsonb, "
                ":target_module_id, true, true, false)"
            ),
            {
                "id": field_id,
                "org_id": fixture.org_id,
                "module_id": graph.source_module_id,
                "name": f"Many {field_id}",
                "target_module_id": graph.target_module_id,
            },
        )
    try:
        first_client, second_client = fixture.client(), fixture.client()
        second_target = graph.target_id if same_target else graph.replacement_id

        def link(client: Any, target_id: UUID) -> Callable[[], httpx.Response]:
            return lambda: client.post(
                "/api/relationships",
                json={
                    "field_id": str(field_id),
                    "source_record_id": str(graph.source_id),
                    "target_record_id": str(target_id),
                },
            )

        first, second = _race(
            fixture,
            "INSERT INTO RELATIONSHIP_EDGES",
            link(first_client, graph.target_id),
            link(second_client, second_target),
        )

        assert first.status_code == 201, first.text
        assert second.status_code == second_status, second.text
        if same_target:
            assert second.json() == {"detail": "Relationship already exists"}
        assert (
            _count(
                fixture,
                "SELECT count(*) FROM public.relationship_edges "
                "WHERE field_id = :id AND is_deleted = false",
                id=field_id,
            )
            == edges
        )
    finally:
        with fixture.owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.relationship_edges WHERE field_id = :id"),
                {"id": field_id},
            )
            connection.execute(text("DELETE FROM public.fields WHERE id = :id"), {"id": field_id})
