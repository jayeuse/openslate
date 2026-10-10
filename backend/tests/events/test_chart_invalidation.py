"""Chart-specific opaque routing and native AuditSession commit dispatch."""

import asyncio

import pytest
from uuid6 import uuid7

from app.systems.manage.audit.listeners import REALTIME_INVALIDATION_KEY
from app.systems.openview.charts.models import Chart
from app.systems.platform.events.hub import EventHub, EventViewer
from app.systems.platform.events.models import (
    InvalidationEvent,
    event_for_entity,
    parse_invalidation_payload,
)
from tests.rbac.support import add_department, add_module


def test_chart_hint_is_entity_only_module_scoped_and_reaches_just_current_readers():
    module_id, chart_id = uuid7(), uuid7()
    hint = event_for_entity("charts", chart_id, module_id=module_id)
    assert hint is not None
    assert hint.to_payload() == {"entity": "charts", "module_id": str(module_id)}
    assert parse_invalidation_payload(hint.to_transport_json()) == hint

    async def exercise():
        hub = EventHub()
        allowed = await hub.subscribe(
            EventViewer(user_id=uuid7(), role="member", module_ids=frozenset({module_id}))
        )
        denied = await hub.subscribe(
            EventViewer(user_id=uuid7(), role="member", module_ids=frozenset({uuid7()}))
        )
        admin = await hub.subscribe(EventViewer(user_id=uuid7(), role="admin", module_ids=None))
        try:
            await hub.publish_notification(hint.to_transport_json())
            assert await allowed.queue.get() == hint
            assert await admin.queue.get() == hint
            assert denied.queue.empty()
        finally:
            for subscriber in (allowed, denied, admin):
                await hub.unsubscribe(subscriber)

    asyncio.run(exercise())
    missing = event_for_entity("charts", chart_id)
    assert missing.entity_id is None and missing.module_id is None
    assert missing.administrators_only and not missing.all_authenticated
    assert parse_invalidation_payload(missing.to_payload()).administrators_only


@pytest.mark.parametrize(
    "extra", ["entity_id", "query", "recipient_id", "board_id", "snapshot", "all_authenticated"]
)
def test_chart_transport_rejects_row_query_or_private_routing_metadata(extra):
    payload = {"entity": "charts", "module_id": str(uuid7()), extra: str(uuid7())}
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        parse_invalidation_payload(payload)


@pytest.mark.parametrize("unsafe", ["identifier", "broadcast"])
def test_direct_chart_values_reject_identifier_and_broad_audience(unsafe):
    kwargs = {"entity_id": uuid7()} if unsafe == "identifier" else {"all_authenticated": True}
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        InvalidationEvent(entity="charts", module_id=uuid7(), **kwargs)


@pytest.mark.integration
def test_real_chart_flushes_publish_one_opaque_hint_only_after_commit_and_none_after_rollback(
    integration_db, monkeypatch
):
    db = integration_db
    department = add_department(db)
    module = add_module(db, department)
    module_id = module.id
    db.commit()
    published = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations", published.extend
    )
    chart = Chart(
        module_id=module_id,
        department_id=department.id,
        name="Native event Chart",
        chart_type="records",
        query={
            "module_id": str(module_id),
            "definition": {
                "version": 1,
                "columns": [],
                "search": "PRIVATE QUERY MUST NOT BE A HINT",
            },
        },
    )
    db.add(chart)
    db.flush()
    chart.name = "Second flush"
    db.flush()
    assert published == []
    assert [item.to_payload() for item in db.info[REALTIME_INVALIDATION_KEY]] == [
        {"entity": "charts", "module_id": str(module_id)}
    ] * 2
    db.commit()
    assert [item.to_payload() for item in published] == [
        {"entity": "charts", "module_id": str(module_id)}
    ]
    published.clear()
    chart.name = "Rolled back change"
    db.flush()
    db.rollback()
    assert published == [] and REALTIME_INVALIDATION_KEY not in db.info
    chart = db.get(Chart, chart.id)
    assert chart.name == "Second flush"
    db.delete(chart)
    db.delete(module)
    db.delete(department)
    db.flush()
    assert published == []
    staged = [
        item.to_payload() for item in db.info[REALTIME_INVALIDATION_KEY] if item.entity == "charts"
    ]
    assert staged == [{"entity": "charts", "module_id": str(module_id)}]
    db.commit()
    assert [item.to_payload() for item in published if item.entity == "charts"] == staged
