"""Invalidation payloads and values that must fail closed (data isolation).

Every row is an exact input from the earlier per-entity tests: an under-authorized,
row-revealing or malformed notification never becomes an ``InvalidationEvent``, so it can
never reach a subscriber. Delivery to the right audience is owned by the fan-out table in
``test_invalidation.py``.
"""

import pytest
from uuid6 import uuid7

from app.systems.platform.events.models import (
    InvalidationEvent,
    event_for_entity,
    parse_invalidation_payload,
)
from tests.migrations.test_organization_root import COMMS_TABLES

READABLE_MODULE = str(uuid7())
ROW = str(uuid7())
BOARD = str(uuid7())
CHART_MODULE = str(uuid7())
RECIPIENT = str(uuid7())

ENTITY_ONLY = [
    "files",
    "saved_views",
    "workspace_profiles",
    "groups",
    "group_members",
    "group_access",
]
AUDIENCE_SCOPED = ["reports", "report_runs", "report_run_rows", "report_schedules"]
BOARD_CHILDREN = [
    "boards",
    "board_groups",
    "board_events",
    "board_event_reminders",
    "board_posts",
    "board_post_revisions",
    "board_post_revision_attachments",
    "board_post_revision_record_links",
    "board_attachments",
    "board_record_links",
    "board_stages",
    "board_cards",
    "board_labels",
    "board_card_labels",
    "board_card_checklist_items",
]


def _rows() -> list[object]:
    rows: list[object] = [
        pytest.param(
            {"entity": "records", "snapshot": {"secret": "no"}}, id="records-with-snapshot"
        ),
        pytest.param(
            {"entity": "workspace_profiles", "module_id": READABLE_MODULE},
            id="workspace_profiles-module",
        ),
        pytest.param({"entity": "records", "capability": "records.read"}, id="records-capability"),
    ]
    rows += [
        pytest.param({"entity": entity, "entity_id": ROW}, id=f"{entity}-row-id")
        for entity in ENTITY_ONLY
    ]
    rows += [
        pytest.param({"entity": entity, "entity_id": ROW}, id=f"audience-{entity}")
        for entity in AUDIENCE_SCOPED
    ]
    rows += [
        pytest.param({"entity": entity, "entity_id": ROW}, id=f"raw-{entity}")
        for entity in BOARD_CHILDREN
    ]
    rows += [
        pytest.param({"entity": entity}, id=f"private-comms-{entity}")
        for entity in sorted(COMMS_TABLES)
    ]
    rows += [
        pytest.param(
            {"entity": "board_posts", "board_id": BOARD, extra: None}, id=f"board-extra-{extra}"
        )
        for extra in ["entity_id", "module_id", "recipient_id", "snapshot", "name"]
    ]
    rows += [
        pytest.param({"entity": "boards", "board_id": board_id}, id=f"board-scope-{name}")
        for name, board_id in [
            ("missing", None),
            ("text", "invalid"),
            ("number", 1),
            ("object", {}),
            ("list", []),
        ]
    ]
    rows += [
        pytest.param({"entity": entity, "board_id": BOARD}, id=f"board-scope-on-{entity}")
        for entity in [
            "records",
            "dashboards",
            "reports",
            "board_post_revisions",
            "in_app_notifications",
        ]
    ]
    rows += [
        pytest.param({"entity": "dashboards", extra: ROW}, id=f"dashboard-{extra}")
        for extra in ["entity_id", "module_id", "recipient_id", "board_id"]
    ]
    # A key the entity may not carry refuses the payload even when its value is null.
    rows += [
        pytest.param({"entity": "dashboards", "entity_id": None}, id="dashboard-null-entity_id"),
        pytest.param(
            {"entity": "records", "module_id": READABLE_MODULE, "board_id": None},
            id="records-null-board_id",
        ),
    ]
    rows += [
        pytest.param(
            {"entity": "charts", "module_id": CHART_MODULE, extra: ROW}, id=f"chart-{extra}"
        )
        for extra in [
            "entity_id",
            "query",
            "recipient_id",
            "board_id",
            "snapshot",
            "all_authenticated",
        ]
    ]
    rows += [
        pytest.param({"entity": "Records"}, id="entity-case"),
        pytest.param({"entity_id": ROW}, id="entity-missing"),
        pytest.param({"entity": 7}, id="entity-not-text"),
        pytest.param(
            {"entity": "records", "entity_id": 7, "module_id": READABLE_MODULE},
            id="numeric-row-id",
        ),
        pytest.param(
            {"entity": "records", "entity_id": "not-a-uuid", "module_id": READABLE_MODULE},
            id="malformed-row-id",
        ),
        pytest.param({"entity": "records", "module_id": 7}, id="numeric-module"),
        pytest.param(
            {"entity": "departments", "module_id": READABLE_MODULE}, id="departments-module"
        ),
    ]
    return rows


@pytest.mark.parametrize("payload", _rows())
def test_untrusted_notification_payloads_fail_closed(payload: object) -> None:
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        parse_invalidation_payload(payload)


@pytest.mark.parametrize(
    ("entity", "values"),
    [
        pytest.param("board_posts", {"board_id": uuid7(), "entity_id": uuid7()}, id="board-row"),
        pytest.param("board_posts", {"board_id": uuid7(), "module_id": uuid7()}, id="board-module"),
        pytest.param(
            "board_posts", {"board_id": uuid7(), "recipient_id": uuid7()}, id="board-recipient"
        ),
        pytest.param(
            "board_posts", {"board_id": uuid7(), "administrators_only": True}, id="board-admins"
        ),
        pytest.param(
            "in_app_notifications",
            {"recipient_id": uuid7(), "administrators_only": True},
            id="notification-admins",
        ),
        pytest.param("dashboards", {"entity_id": uuid7()}, id="dashboard-row"),
        pytest.param("dashboards", {"module_id": uuid7()}, id="dashboard-module"),
        pytest.param("dashboards", {"recipient_id": uuid7()}, id="dashboard-recipient"),
        pytest.param("dashboards", {"board_id": uuid7()}, id="dashboard-board"),
        pytest.param("charts", {"module_id": uuid7(), "entity_id": uuid7()}, id="chart-identifier"),
        pytest.param(
            "charts", {"module_id": uuid7(), "all_authenticated": True}, id="chart-broadcast"
        ),
        pytest.param("bad entity", {}, id="entity-name"),
    ],
)
def test_unsafe_invalidation_values_fail_before_serialization(
    entity: str, values: dict[str, object]
) -> None:
    with pytest.raises(ValueError, match="invalid invalidation payload"):
        InvalidationEvent(entity, **values)


@pytest.mark.parametrize("entity", AUDIENCE_SCOPED + BOARD_CHILDREN + sorted(COMMS_TABLES))
def test_audience_scoped_and_raw_board_rows_have_no_generic_invalidation(entity: str) -> None:
    assert event_for_entity(entity, uuid7()) is None
