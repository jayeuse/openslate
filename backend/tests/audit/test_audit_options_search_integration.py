"""Search filter choices before their cap, without widening audit visibility."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserStatus
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.rbac.support import _client, add_department, add_user, make_group_access, make_user

pytestmark = pytest.mark.integration


def _seed(db: Session, rows: list[AuditLog]) -> None:
    for row in rows:
        object.__setattr__(row, "_audit_internal", True)
    db.add_all(rows)
    db.flush()


def test_option_search_precedes_caps_and_matches_current_or_latest_historical_names(
    integration_db: Session,
) -> None:
    from app.main import create_app

    token = uuid7().hex
    people = [make_user(f"search_{token}_{index}") for index in range(201)]
    people[0].display_name = "Amber 100%_team"
    people[1].display_name = "Amber 100XXteam"
    integration_db.add_all(people)
    integration_db.flush()
    timestamp = datetime(2100, 1, 1, tzinfo=UTC)
    target_type = f"kind-%_{token}"
    rows = [
        AuditLog(
            id=uuid7(),
            created_at=timestamp + timedelta(days=index),
            action=AuditAction.UPDATE,
            entity_type=target_type if index == 0 else f"kind-{token}-{index}",
            performed_by=actor.id,
            actor_label="Historical 100%_label" if index == 0 else f"Actor {index}",
        )
        for index, actor in enumerate(people)
    ]
    rows.append(
        AuditLog(
            id=uuid7(),
            created_at=timestamp - timedelta(days=1),
            action=AuditAction.UPDATE,
            entity_type=target_type,
            performed_by=people[0].id,
            actor_label="Obsolete label",
        )
    )
    _seed(integration_db, rows)
    client = _client(create_app(), make_user(f"search_admin_{token}"), integration_db)
    endpoint = "/api/audit-logs/options"

    capped = client.get(endpoint).json()
    assert target_type not in capped["entity_types"]
    assert str(people[0].id) not in {item["performed_by"] for item in capped["actors"]}
    entity_match = client.get(endpoint, params={"search": f"  {target_type.upper()}  "})
    assert entity_match.status_code == 200
    assert entity_match.json() == {"entity_types": [target_type], "actors": []}
    for search in (" AMBER 100%_ ", " HISTORICAL 100%_ ", people[0].username):
        response = client.get(endpoint, params={"search": search})
        assert response.status_code == 200
        assert response.json() == {
            "entity_types": [],
            "actors": [
                {
                    "performed_by": str(people[0].id),
                    "actor_label": "Historical 100%_label",
                    "actor_name": "Amber 100%_team",
                }
            ],
        }
    obsolete = client.get(endpoint, params={"search": "Obsolete label"})
    assert obsolete.status_code == 200
    assert obsolete.json() == {"entity_types": [], "actors": []}


def test_option_search_preserves_department_scope_and_inactive_name_redaction(
    integration_db: Session,
) -> None:
    from app.main import create_app

    db = integration_db
    managed, hidden = add_department(db), add_department(db)
    manager = add_user(db)
    make_group_access(db, [manager], managed, level=AccessLevel.MANAGE)
    visible_actor, hidden_actor, inactive_actor = [add_user(db) for _ in range(3)]
    visible_actor.display_name = "Scoped needle"
    hidden_actor.display_name = "Hidden needle"
    inactive_actor.display_name = "Inactive needle"
    inactive_actor.status = UserStatus.DISABLED.value
    _seed(
        db,
        [
            AuditLog(
                id=uuid7(),
                created_at=datetime(2100, 1, 1, tzinfo=UTC),
                action=AuditAction.UPDATE,
                entity_type="needle-visible" if department is managed else "needle-hidden",
                department_id=department.id,
                performed_by=actor.id,
                actor_label="Retained former actor" if actor is inactive_actor else None,
            )
            for actor, department in (
                (visible_actor, managed),
                (hidden_actor, hidden),
                (inactive_actor, managed),
            )
        ],
    )
    client = _client(create_app(), manager, db)
    endpoint = "/api/audit-logs/options"
    params = {"department_id": str(managed.id), "search": "needle"}
    response = client.get(endpoint, params=params)
    assert response.status_code == 200
    assert response.json() == {
        "entity_types": ["needle-visible"],
        "actors": [
            {
                "performed_by": str(visible_actor.id),
                "actor_label": None,
                "actor_name": "Scoped needle",
            }
        ],
    }
    historical = client.get(endpoint, params={**params, "search": "Retained former actor"})
    assert historical.status_code == 200
    assert historical.json()["actors"] == [
        {
            "performed_by": str(inactive_actor.id),
            "actor_label": "Retained former actor",
            "actor_name": None,
        }
    ]
    denied = client.get(endpoint, params={**params, "department_id": str(hidden.id)})
    assert denied.status_code == 403
    too_long = client.get(endpoint, params={**params, "search": "a" * 101})
    assert too_long.status_code == 422
