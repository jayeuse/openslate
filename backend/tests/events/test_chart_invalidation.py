"""Chart-specific opaque routing and native AuditSession commit dispatch."""

import pytest
from uuid6 import uuid7

from app.systems.manage.audit.listeners import REALTIME_INVALIDATION_KEY
from app.systems.openview.charts.models import Chart
from app.systems.platform.events.models import (
    event_for_entity,
    parse_invalidation_payload,
)
from tests.rbac.support import add_department, add_module


def test_chart_hint_without_its_module_is_administrators_only():
    # The module-scoped hint and its readers are the "charts" row of the fan-out table in
    # tests/events/test_invalidation.py.
    chart_id = uuid7()
    missing = event_for_entity("charts", chart_id)
    assert missing.entity_id is None and missing.module_id is None
    assert missing.administrators_only and not missing.all_authenticated
    assert parse_invalidation_payload(missing.to_payload()).administrators_only


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
