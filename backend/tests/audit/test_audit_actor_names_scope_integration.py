"""Actor-name attribution stays within the audit rows visible to department managers."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.rbac.support import _client, add_department, add_user, make_group_access, make_user

pytestmark = pytest.mark.integration


def test_department_manager_audit_actor_names_follow_visible_rows(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    inventory = add_department(integration_db)
    finance = add_department(integration_db)
    manager = add_user(integration_db, role=UserRole.MEMBER)
    inventory_actor = add_user(integration_db)
    inventory_actor.display_name = "Inventory actor"
    finance_actor = add_user(integration_db)
    finance_actor.display_name = "Finance actor"
    make_group_access(integration_db, [manager], inventory, level=AccessLevel.MANAGE)

    inventory_entity_id = uuid7()
    finance_entity_id = uuid7()
    logs = [
        AuditLog(
            id=uuid7(),
            created_at=datetime.now(UTC),
            action=AuditAction.UPDATE,
            entity_type="scoped-actor-test",
            entity_id=inventory_entity_id,
            department_id=inventory.id,
            performed_by=inventory_actor.id,
        ),
        AuditLog(
            id=uuid7(),
            created_at=datetime.now(UTC),
            action=AuditAction.UPDATE,
            entity_type="scoped-actor-test",
            entity_id=finance_entity_id,
            department_id=finance.id,
            performed_by=finance_actor.id,
        ),
    ]
    for row in logs:
        object.__setattr__(row, "_audit_internal", True)
    integration_db.add_all(logs)
    integration_db.flush()

    response = _client(api, manager, integration_db).get(
        "/api/audit-logs",
        params={"department_id": str(inventory.id), "limit": 100},
    )

    assert response.status_code == 200
    items = response.json()["items"]
    visible = next(item for item in items if item["entity_id"] == str(inventory_entity_id))
    assert visible["actor_name"] == "Inventory actor"
    assert str(finance_entity_id) not in {item["entity_id"] for item in items}
    assert "Finance actor" not in {item["actor_name"] for item in items}


def test_admin_audit_search_matches_actor_record_id_and_snapshot_values_across_pages(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    token = uuid7().hex
    actor_value = f"actor_{token}"
    timestamp = datetime(2026, 10, 1, 12, tzinfo=UTC)
    actor_logs = [
        AuditLog(
            id=uuid7(),
            created_at=timestamp,
            action=AuditAction.UPDATE,
            entity_type="users",
            actor_label=actor_value,
        )
        for _ in range(3)
    ]
    actor_decoy = AuditLog(
        id=uuid7(),
        created_at=timestamp,
        action=AuditAction.UPDATE,
        entity_type="users",
        actor_label=f"actorX{token}",
    )
    record_id = uuid7()
    record_log = AuditLog(
        id=uuid7(),
        created_at=timestamp,
        action=AuditAction.UPDATE,
        entity_type="records",
        entity_id=record_id,
    )
    before_log = AuditLog(
        id=uuid7(),
        created_at=timestamp,
        action=AuditAction.UPDATE,
        entity_type="users",
        before={"role": f"before-value-{token}", "nested": {"active": True}},
    )
    after_log = AuditLog(
        id=uuid7(),
        created_at=timestamp,
        action=AuditAction.UPDATE,
        entity_type="users",
        after={"role": f"after-value-{token}", "nested": [3, False]},
    )
    entity_type_log = AuditLog(
        id=uuid7(),
        created_at=timestamp,
        action=AuditAction.UPDATE,
        entity_type=f"legacy-type-{token}",
    )
    request_path_log = AuditLog(
        id=uuid7(),
        created_at=timestamp,
        action=AuditAction.UPDATE,
        entity_type="users",
        request_path=f"/legacy/path/{token}",
    )
    null_search_fields_log = AuditLog(
        id=uuid7(),
        created_at=timestamp,
        action=AuditAction.UPDATE,
        entity_type="users",
        actor_label=None,
        entity_id=None,
        before=None,
        after=None,
        request_path=None,
    )
    seeded_logs = [
        *actor_logs,
        actor_decoy,
        record_log,
        before_log,
        after_log,
        entity_type_log,
        request_path_log,
        null_search_fields_log,
    ]
    # This route test seeds immutable history via the audit writer's internal marker.
    for row in seeded_logs:
        object.__setattr__(row, "_audit_internal", True)
    integration_db.add_all(seeded_logs)
    integration_db.flush()

    with _client(api, make_user(f"audit-search-{token}"), integration_db) as client:
        actor_pages = [
            client.get(
                "/api/audit-logs",
                params={"search": actor_value, "limit": 1, "offset": offset},
            )
            for offset in range(3)
        ]
        for offset, response in enumerate(actor_pages):
            assert response.status_code == 200
            body = response.json()
            assert body["pagination"]["total"] == 3
            assert body["pagination"]["count"] == 1
            assert body["pagination"]["has_more"] is (offset < 2)
        assert {response.json()["items"][0]["id"] for response in actor_pages} == {
            str(row.id) for row in actor_logs
        }

        record_match = client.get("/api/audit-logs", params={"search": str(record_id)[4:14]}).json()
        assert [item["id"] for item in record_match["items"]] == [str(record_log.id)]

        before_match = client.get(
            "/api/audit-logs", params={"search": f"before-value-{token}"}
        ).json()
        assert [item["id"] for item in before_match["items"]] == [str(before_log.id)]
        after_match = client.get(
            "/api/audit-logs", params={"search": f"after-value-{token}"}
        ).json()
        assert [item["id"] for item in after_match["items"]] == [str(after_log.id)]

        old_type_match = client.get(
            "/api/audit-logs", params={"search": f"legacy-type-{token}"}
        ).json()
        assert [item["id"] for item in old_type_match["items"]] == [str(entity_type_log.id)]
        old_path_match = client.get(
            "/api/audit-logs", params={"search": f"legacy/path/{token}"}
        ).json()
        assert [item["id"] for item in old_path_match["items"]] == [str(request_path_log.id)]

        action_match_response = client.get("/api/audit-logs", params={"search": "Update"})
        assert action_match_response.status_code == 200
        action_match = action_match_response.json()
        assert action_match["pagination"]["total"] == len(seeded_logs)
        assert {item["id"] for item in action_match["items"]} == {
            str(row.id) for row in seeded_logs
        }
