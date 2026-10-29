"""SQL statements per request for the busiest record and link routes.

Each budget is the count after removing repeated work (School Standard profile,
2026-10). A change that adds a statement to one of these routes fails here; if a
statement was removed on purpose, lower the budget in the same change.

Profile 4.2 (Harbor Standard, 2026-10-29) added a person field, a choice field and
a one-to-many link, and each record write now assigns a reader. With them, before
-> after reading the module's readers and fields once per request and checking a
new link's duplicate and cardinality in one read: POST records 21 -> 16, PATCH
22 -> 17, POST link 14 -> 13; GET 7 and PUT 15 are unchanged.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import event, text
from uuid6 import uuid7

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("TEST_DATABASE_URL") is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]
pytest_plugins = ("tests.relationships_integration.relationship_http_support",)
OPEN, DONE = "open", "done"

# A member whose group writes the department, so every access-policy lookup runs.
# Counts cover the route and its locks, audit and outbox rows; authentication is
# overridden here (its single workspace-policy read is guarded in tests/auth).
# Before the 2026-10 clean-up: GET 4, POST records 18, PATCH 15, POST link 19, PUT 24.
# The membership read belongs to authentication (cached for the request), not the route.
BUDGETS = {
    "GET /api/records/{record_id}": 7,
    "POST /api/records": 16,
    "PATCH /api/records/{record_id}": 17,
    "POST /api/relationships": 13,
    "PUT /api/relationships/fields/{field_id}/sources/{source_record_id}": 15,
}


@contextmanager
def _statements(engine: Any) -> Iterator[list[str]]:
    executed: list[str] = []

    def record(_connection: object, _cursor: object, statement: str, *_args: object) -> None:
        # Binding the transaction to its organization is infrastructure, not route work.
        if "set_config('openslate.org_id'" not in statement:
            executed.append(" ".join(statement.split())[:160])

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield executed
    finally:
        event.remove(engine, "before_cursor_execute", record)


@dataclass(frozen=True)
class _Fields:
    text: UUID
    owner: UUID
    status: UUID
    link: UUID


def _add_fields(fixture: Any) -> _Fields:
    """Fields like the sample packs use: text, a person, a choice and a one-to-many link."""

    graph = fixture.graph
    added = _Fields(uuid7(), uuid7(), uuid7(), uuid7())
    with fixture.owner_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.fields "
                "(id, org_id, module_id, name, type, required, position, config, "
                "relationship_target_module_id, relationship_multiple_targets, "
                "relationship_multiple_sources, is_deleted) VALUES "
                "(:text_id, :org_id, :source, :text_name, 'text', false, 3, "
                '\'{"kind": "text", "defaultValue": ""}\'::jsonb, NULL, NULL, NULL, false), '
                "(:link_id, :org_id, :source, :link_name, 'relationship', false, 4, '{}'::jsonb, "
                ":target, true, false, false), "
                "(:owner_id, :org_id, :source, :owner_name, 'user', false, 5, '{}'::jsonb, "
                "NULL, NULL, NULL, false), "
                "(:status_id, :org_id, :source, :status_name, 'select', false, 6, "
                "CAST(:status_config AS jsonb), NULL, NULL, NULL, false)"
            ),
            {
                "text_id": added.text,
                "org_id": fixture.org_id,
                "link_id": added.link,
                "owner_id": added.owner,
                "status_id": added.status,
                "source": graph.source_module_id,
                "target": graph.target_module_id,
                "text_name": f"Notes {added.text.hex[:12]}",
                "link_name": f"Many {added.link.hex[:12]}",
                "owner_name": f"Owner {added.owner.hex[:12]}",
                "status_name": f"Status {added.status.hex[:12]}",
                "status_config": json.dumps(
                    {"options": [{"id": OPEN, "label": "Open"}, {"id": DONE, "label": "Done"}]}
                ),
            },
        )
    fixture._all_ids.update({added.text, added.owner, added.status, added.link})
    return added


def _measure(fixture: Any) -> dict[str, list[str]]:
    graph = fixture.graph
    fields = _add_fields(fixture)
    text_field, owner, status, link_field = (
        str(fields.text),
        str(fields.owner),
        str(fields.status),
        fields.link,
    )
    engine = fixture.runtime_engine
    measured: dict[str, list[str]] = {}
    with fixture.client(fixture.writer) as client:
        with _statements(engine) as executed:
            created = client.post(
                "/api/records",
                json={
                    "module_id": str(graph.source_module_id),
                    "data": {text_field: "a", owner: str(fixture.writer_id), status: OPEN},
                },
            )
        assert created.status_code == 201, created.text
        record = created.json()
        assert record["display_values"] == {owner: fixture.writer.username, status: "Open"}
        fixture._all_ids.add(UUID(record["id"]))
        measured["POST /api/records"] = executed

        with _statements(engine) as executed:
            read = client.get(f"/api/records/{record['id']}")
        assert read.status_code == 200, read.text
        measured["GET /api/records/{record_id}"] = executed

        with _statements(engine) as executed:
            # The edit hands the record to another reader, who is notified.
            edited = client.patch(
                f"/api/records/{record['id']}",
                json={"data": {text_field: "b", owner: str(fixture.guest_id), status: DONE}},
                headers={"If-Match": f'"{read.json()["updated_at"]}"'},
            )
        assert edited.status_code == 200, edited.text
        assert edited.json()["display_values"] == {owner: fixture.guest.username, status: "Done"}
        measured["PATCH /api/records/{record_id}"] = executed

        with _statements(engine) as executed:
            linked = client.post(
                "/api/relationships",
                json={
                    "field_id": str(link_field),
                    "source_record_id": str(graph.source_id),
                    "target_record_id": str(graph.target_id),
                },
            )
        assert linked.status_code == 201, linked.text
        measured["POST /api/relationships"] = executed

        with _statements(engine) as executed:
            assigned = client.put(
                f"/api/relationships/fields/{graph.field_id}/sources/{graph.source_id}",
                json={"target_record_id": str(graph.target_id)},
            )
        assert assigned.status_code == 200, assigned.text
        measured["PUT /api/relationships/fields/{field_id}/sources/{source_record_id}"] = executed
    return measured


def test_record_and_link_routes_stay_within_their_statement_budgets(
    relationship_http_fixture: Any,
) -> None:
    try:
        measured = _measure(relationship_http_fixture)
    finally:
        # The fixture removes edges of its own fields only; remove the added field's edges,
        # the outbox events the record writes queued and the assignment notifications.
        with relationship_http_fixture.owner_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM public.in_app_notifications WHERE org_id = :org_id"),
                {"org_id": relationship_http_fixture.org_id},
            )
            connection.execute(
                text(
                    "DELETE FROM public.record_trigger_events WHERE module_id IN (:source, :target)"
                ),
                {
                    "source": relationship_http_fixture.graph.source_module_id,
                    "target": relationship_http_fixture.graph.target_module_id,
                },
            )
            connection.execute(
                text(
                    "DELETE FROM public.relationship_edges WHERE field_id IN "
                    "(SELECT id FROM public.fields WHERE module_id = :module AND type = "
                    "'relationship' AND relationship_multiple_targets IS true)"
                ),
                {"module": relationship_http_fixture.graph.source_module_id},
            )
    report = "\n".join(
        f"{route}: {len(statements)}\n    " + "\n    ".join(statements)
        for route, statements in measured.items()
    )
    print(report)
    assert not [
        statement
        for statements in measured.values()
        for statement in statements
        if "FROM memberships" in statement
    ], report
    assert {route: len(statements) for route, statements in measured.items()} == BUDGETS, report
