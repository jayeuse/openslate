"""Actor-name attribution stays within the audit rows visible to department managers."""

import csv
import io
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.models import Record
from tests.rbac.support import (
    _client,
    add_department,
    add_module,
    add_user,
    make_group_access,
    organization,
)

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
            org_id=inventory.org_id,
            id=uuid7(),
            created_at=datetime.now(UTC),
            action=AuditAction.UPDATE,
            entity_type="scoped-actor-test",
            entity_id=inventory_entity_id,
            department_id=inventory.id,
            performed_by=inventory_actor.id,
        ),
        AuditLog(
            org_id=finance.org_id,
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
        org_id=organization(integration_db).id,
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
        org_id=organization(integration_db).id,
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
    # One request id (a filter, not a search field) scopes the action search to these rows.
    seeded_request_id = uuid7()
    for row in seeded_logs:
        row.request_id = seeded_request_id
        # History recorded inside this organization (owner decision 10 keeps rows without
        # an organization hidden unless they concern its own people).
        row.org_id = row.org_id or organization(integration_db).id
        object.__setattr__(row, "_audit_internal", True)
    integration_db.add_all(seeded_logs)
    integration_db.flush()

    with _client(api, add_user(integration_db, f"audit-search-{token}", role="admin"),
                 integration_db) as client:
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

        action_match_response = client.get(
            "/api/audit-logs", params={"search": "Update", "request_id": str(seeded_request_id)}
        )
        assert action_match_response.status_code == 200
        action_match = action_match_response.json()
        assert action_match["pagination"]["total"] == len(seeded_logs)
        assert {item["id"] for item in action_match["items"]} == {
            str(row.id) for row in seeded_logs
        }


def test_admin_csv_exports_complete_filtered_history_with_safe_cells(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    token = uuid7().hex
    entity_type = f"csv_{token}"
    department = add_department(integration_db)
    actor = add_user(integration_db)
    actor.display_name = " \t=Actor()"
    request_id, entity_id = uuid7(), uuid7()
    horizon = datetime(2026, 10, 1, 12, tzinfo=UTC)
    rows = [
        AuditLog(
            org_id=department.org_id,
            id=uuid7(),
            created_at=horizon,
            action=AuditAction.UPDATE,
            entity_type=entity_type,
            entity_id=entity_id,
            department_id=department.id,
            performed_by=actor.id,
            request_id=request_id,
            before={"\t=": "value", "active": False, "nested": [1, True, None]},
            after={"name": f'  @Target,{index}"\r\n雪', "marker": "literal_%"},
        )
        for index in range(105)
    ]
    # Every decoy differs in exactly one selected filter.
    for changed in (
        {"action": AuditAction.CREATE},
        {"entity_type": "decoy"},
        {"entity_id": uuid7()},
        {"department_id": uuid7()},
        {"performed_by": None},
        {"request_id": uuid7()},
        {"created_at": horizon + timedelta(seconds=1)},
        {"created_at": horizon - timedelta(seconds=1)},
        {"after": {"name": "Decoy", "marker": "literalXX"}},
    ):
        row = AuditLog(
            org_id=department.org_id,
            id=uuid7(),
            created_at=horizon,
            action=AuditAction.UPDATE,
            entity_type=entity_type,
            entity_id=entity_id,
            department_id=department.id,
            performed_by=actor.id,
            request_id=request_id,
            after={"name": "Decoy", "marker": "literal_%"},
        )
        for key, value in changed.items():
            setattr(row, key, value)
        rows.append(row)
    for row in rows:
        object.__setattr__(row, "_audit_internal", True)
    integration_db.add_all(rows)
    integration_db.flush()
    filters = {
        "action": "update",
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "department_id": str(department.id),
        "performed_by": str(actor.id),
        "request_id": str(request_id),
        "created_after": horizon.isoformat(),
        "created_before": horizon.isoformat(),
        "search": "literal_%",
    }
    with _client(api, add_user(integration_db, f"csv-admin-{token}", role="admin"),
                 integration_db) as client:
        preview = client.get("/api/audit-logs", params={**filters, "limit": 10})
        assert preview.status_code == 200
        assert preview.json()["pagination"]["total"] == 105
        for direction in ("desc", "asc"):
            exported = client.get(
                "/api/audit-logs/export", params={**filters, "sort_order": direction}
            )
            assert exported.status_code == 200
            assert exported.headers["content-type"].startswith("text/csv")
            assert exported.headers["cache-control"] == "no-store"
            assert exported.headers["content-disposition"] == (
                'attachment; filename="openslate-audit.csv"'
            )
            assert exported.headers["x-audit-export-count"] == "105"
            parsed = list(csv.reader(io.StringIO(exported.text, newline="")))
            assert parsed[0] == ["Date", "User", "Entity", "Action", "Target", "Before", "After"]
            assert len(parsed) == 106
            assert exported.text.startswith(
                '"Date","User","Entity","Action","Target","Before","After"\r\n'
            )
            expected = rows[:105] if direction == "asc" else list(reversed(rows[:105]))
            assert [line[4] for line in parsed[1:]] == [
                "'" + str(row.after["name"]).strip() for row in expected
            ]
            assert all(line[0] == "2026-10-01T12:00:00Z" for line in parsed[1:])
            assert all(line[1] == "'=Actor()" and line[3] == "Update" for line in parsed[1:])
            assert all(
                line[5] == "'\t=: value\nActive: false\nNested: [1,true,null]"
                for line in parsed[1:]
            )
        assert client.get("/api/audit-logs", params={"limit": 101}).status_code == 422
        assert (
            client.get("/api/audit-logs/export", params={"sort_by": "private"}).status_code == 422
        )
        empty = client.get("/api/audit-logs/export", params={**filters, "search": "absent"})
        assert empty.status_code == 200 and empty.headers["x-audit-export-count"] == "0"
        assert len(list(csv.reader(io.StringIO(empty.text)))) == 1
    manager = add_user(integration_db)
    make_group_access(integration_db, [manager], department, level=AccessLevel.MANAGE)
    denied = _client(api, manager, integration_db).get("/api/audit-logs/export", params=filters)
    assert denied.status_code == 403


def test_admin_csv_accepts_10000_and_refuses_overflow_without_partial_data(
    integration_db: Session,
) -> None:
    from app.main import create_app

    entity_type = f"cap_{uuid7().hex}"
    rows = [
        AuditLog(
            org_id=organization(integration_db).id,
            id=uuid7(),
            created_at=datetime.now(UTC),
            action=AuditAction.CREATE,
            entity_type=entity_type,
            after={"name": "Cap target"},
        )
        for _ in range(10000)
    ]
    for row in rows:
        object.__setattr__(row, "_audit_internal", True)
    integration_db.add_all(rows)
    integration_db.flush()
    with _client(create_app(), add_user(integration_db, "csv-cap-admin", role="admin"),
                 integration_db) as client:
        accepted = client.get("/api/audit-logs/export", params={"entity_type": entity_type})
        assert accepted.status_code == 200
        assert accepted.headers["content-type"].startswith("text/csv")
        assert accepted.headers["x-audit-export-count"] == "10000"
        assert len(list(csv.reader(io.StringIO(accepted.text)))) == 10001
        overflow = AuditLog(
            org_id=organization(integration_db).id,
            id=uuid7(),
            created_at=datetime.now(UTC),
            action=AuditAction.CREATE,
            entity_type=entity_type,
            after={"name": "Overflow target"},
        )
        object.__setattr__(overflow, "_audit_internal", True)
        integration_db.add(overflow)
        integration_db.flush()
        refused = client.get("/api/audit-logs/export", params={"entity_type": entity_type})
        assert refused.status_code == 409
        assert refused.json()["detail"] == {
            "code": "audit_export_limit",
            "message": (
                "Audit exports support up to 10,000 entries. Narrow your filters and try again."
            ),
        }
        assert "x-audit-export-count" not in refused.headers
        assert "Cap target" not in refused.text and "Overflow target" not in refused.text


def test_audit_target_labels_respect_current_scope_redaction_and_snapshot_priority(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    inventory, finance = add_department(integration_db), add_department(integration_db)
    module, outside = add_module(integration_db, inventory), add_module(integration_db, finance)
    private_module = add_module(integration_db, inventory)
    title = Field(org_id=module.org_id, module_id=module.id,
                  name="Title", type=FieldType.TEXT, position=0)
    outside_title = Field(org_id=outside.org_id, module_id=outside.id,
                          name="Title", type=FieldType.TEXT, position=0)
    private_title = Field(
        org_id=private_module.org_id,
        module_id=private_module.id,
        name="Title",
        type=FieldType.TEXT,
        position=0,
        audit_redacted=True,
    )
    integration_db.add_all([title, outside_title, private_title])
    integration_db.flush()
    module.title_field_id, outside.title_field_id = title.id, outside_title.id
    private_module.title_field_id = private_title.id
    public = Record(
        org_id=module.org_id, module_id=module.id, data={str(title.id): "Visible record"},
    )
    moved = Record(org_id=module.org_id, module_id=module.id, data={})
    secret = Record(
        org_id=private_module.org_id,
        module_id=private_module.id, data={str(private_title.id): "Private title canary"}
    )
    integration_db.add_all([public, moved, secret])
    integration_db.flush()
    moved.module_id = outside.id
    moved.data = {str(outside_title.id): "Moved title canary"}
    integration_db.flush()
    unknown_id = uuid7()
    synthetic = [
        AuditLog(
            org_id=inventory.org_id,
            id=uuid7(),
            action=AuditAction.UPDATE,
            entity_type="legacy_target",
            entity_id=unknown_id,
            department_id=inventory.id,
            after={"name": "[REDACTED]", "title": "After title"},
            before={"name": "Before name"},
        ),
        AuditLog(
            org_id=inventory.org_id,
            id=uuid7(),
            action=AuditAction.DELETE,
            entity_type="legacy_target",
            entity_id=uuid7(),
            department_id=inventory.id,
        ),
    ]
    for row in synthetic:
        object.__setattr__(row, "_audit_internal", True)
    integration_db.add_all(synthetic)
    integration_db.flush()
    manager = add_user(integration_db)
    make_group_access(integration_db, [manager], inventory, level=AccessLevel.MANAGE)
    listed = _client(api, manager, integration_db).get(
        "/api/audit-logs", params={"department_id": str(inventory.id), "limit": 100}
    )
    assert listed.status_code == 200
    items = listed.json()["items"]
    assert {item["target_label"] for item in items if item["entity_id"] == str(public.id)} == {
        "Visible record"
    }
    assert {item["target_label"] for item in items if item["entity_id"] == str(moved.id)} == {
        "Records · name unavailable"
    }
    assert (
        next(item for item in items if item["id"] == str(synthetic[0].id))["target_label"]
        == "After title"
    )
    assert (
        next(item for item in items if item["id"] == str(synthetic[1].id))["target_label"]
        == "Legacy Target · name unavailable"
    )
    assert all("Private title canary" not in item["target_label"] for item in items)
    with _client(api, add_user(integration_db, "audit-label-admin", role="admin"),
                 integration_db) as client:
        for record, expected_label in (
            (public, "Visible record"),
            (secret, "Records · name unavailable"),
        ):
            response = client.get("/api/audit-logs", params={"entity_id": str(record.id)})
            assert response.status_code == 200
            row = response.json()["items"][0]
            detail = client.get(f"/api/audit-logs/{row['id']}")
            exported = client.get("/api/audit-logs/export", params={"entity_id": str(record.id)})
            assert row["target_label"] == detail.json()["target_label"] == expected_label
            assert list(csv.DictReader(io.StringIO(exported.text)))[0]["Target"] == expected_label
            assert "Private title canary" not in response.text + detail.text + exported.text
