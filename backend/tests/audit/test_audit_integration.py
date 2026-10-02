import os
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from typing import Any

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole, UserStatus
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.rbac.support import (
    _client,
    add_department,
    add_module,
    add_user,
    make_group_access,
    make_user,
)

UPDATED_RENAMED_CANARY = token_urlsafe(32)
UPDATED_CLOSED_CANARY = token_urlsafe(32)
ADDED_FIELD_CANARY = token_urlsafe(32)
HISTORICAL_RENAMED_CANARY = token_urlsafe(32)
HISTORICAL_CLOSED_CANARY = token_urlsafe(32)


def _statement_collector() -> tuple[list[str], Callable[..., None]]:
    statements: list[str] = []

    def capture(*args: Any) -> None:
        statements.append(args[2])

    return statements, capture


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def audit_rows(session: Session, entity_id) -> list[AuditLog]:
    return list(
        session.scalars(
            select(AuditLog)
            .where(AuditLog.entity_id == entity_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


def test_crud_changes_are_audited_with_minimal_snapshots(integration_db: Session) -> None:
    department = Department(department_name="Integration CRUD")
    integration_db.add(department)
    integration_db.flush()

    department.department_name = "Integration CRUD Updated"
    integration_db.flush()

    department.is_deleted = True
    integration_db.flush()

    rows = audit_rows(integration_db, department.id)
    assert [row.action for row in rows] == [
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.DELETE,
    ]
    assert rows[0].after == {"department_name": "Integration CRUD"}
    assert rows[1].before == {"department_name": "Integration CRUD"}
    assert rows[1].after == {"department_name": "Integration CRUD Updated"}
    assert rows[2].before["is_deleted"] is False
    assert rows[2].after["is_deleted"] is True
    assert all(row.performed_by is None for row in rows)


def test_rollback_does_not_keep_audit_rows(integration_db: Session) -> None:
    department = Department(department_name="Integration Rollback")
    integration_db.add(department)
    integration_db.flush()
    department_id = department.id

    assert len(audit_rows(integration_db, department_id)) == 1
    integration_db.rollback()

    assert integration_db.get(Department, department_id) is None


def test_hard_delete_records_the_previous_state(integration_db: Session) -> None:
    department = Department(department_name="Integration Hard Delete")
    integration_db.add(department)
    integration_db.flush()
    department_id = department.id

    integration_db.delete(department)
    integration_db.flush()

    rows = audit_rows(integration_db, department_id)
    assert [row.action for row in rows] == [AuditAction.CREATE, AuditAction.DELETE]
    assert rows[-1].before["department_name"] == "Integration Hard Delete"
    assert integration_db.get(Department, department_id) is None


def test_record_audit_redaction_preserves_data_and_historical_snapshots(
    integration_db: Session,
) -> None:
    department = Department(department_name=f"Audit Redaction {uuid7()}")
    module = Module(
        department=department,
        module_name="Governance export",
    )
    renamed = Field(
        module=module,
        name="Original secret",
        type=FieldType.TEXT,
        position=0,
    )
    soft_deleted = Field(
        module=module,
        name="Closed secret",
        type=FieldType.TEXT,
        position=1,
    )
    added = Field(
        module=module,
        name="Added secret",
        type=FieldType.TEXT,
        position=2,
    )
    clear = Field(
        module=module,
        name="Visible value",
        type=FieldType.TEXT,
        position=3,
    )
    integration_db.add(department)
    integration_db.flush()

    record = Record(
        module=module,
        data={
            str(renamed.id): HISTORICAL_RENAMED_CANARY,
            str(soft_deleted.id): HISTORICAL_CLOSED_CANARY,
            str(clear.id): "historical visible",
        },
    )
    integration_db.add(record)
    integration_db.flush()
    historical_create = audit_rows(integration_db, record.id)[0]
    assert historical_create.action == AuditAction.CREATE
    assert historical_create.after["data"] == {
        str(renamed.id): HISTORICAL_RENAMED_CANARY,
        str(soft_deleted.id): HISTORICAL_CLOSED_CANARY,
        str(clear.id): "historical visible",
    }

    renamed.audit_redacted = True
    renamed.name = "Renamed secret"
    soft_deleted.audit_redacted = True
    soft_deleted.is_deleted = True
    soft_deleted.deleted_at = datetime.now(UTC)
    added.audit_redacted = True
    integration_db.flush()

    record.data = {
        str(renamed.id): UPDATED_RENAMED_CANARY,
        str(soft_deleted.id): UPDATED_CLOSED_CANARY,
        str(added.id): ADDED_FIELD_CANARY,
        str(clear.id): "updated visible",
    }
    integration_db.flush()
    updated = audit_rows(integration_db, record.id)[-1]
    assert updated.action == AuditAction.UPDATE
    assert updated.before["data"] == {
        str(renamed.id): REDACTED,
        str(soft_deleted.id): REDACTED,
        str(clear.id): "historical visible",
    }
    assert updated.after["data"] == {
        str(renamed.id): REDACTED,
        str(soft_deleted.id): REDACTED,
        str(added.id): REDACTED,
        str(clear.id): "updated visible",
    }

    record.data = {str(clear.id): "final visible"}
    integration_db.flush()
    removed = audit_rows(integration_db, record.id)[-1]
    assert removed.before["data"] == {
        str(renamed.id): REDACTED,
        str(soft_deleted.id): REDACTED,
        str(added.id): REDACTED,
        str(clear.id): "updated visible",
    }
    assert removed.after["data"] == {str(clear.id): "final visible"}
    assert record.data == {str(clear.id): "final visible"}
    assert historical_create.after["data"] == {
        str(renamed.id): HISTORICAL_RENAMED_CANARY,
        str(soft_deleted.id): HISTORICAL_CLOSED_CANARY,
        str(clear.id): "historical visible",
    }


def test_audit_actor_names_are_batched_and_consistent_for_list_detail_and_export(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    token = uuid7().hex
    display_actor = add_user(integration_db, f"audit-display-{token}")
    display_actor.display_name = f"Display Name {token}"
    fallback_actor = add_user(integration_db, f"audit-fallback-{token}")
    disabled_actor = add_user(
        integration_db,
        f"audit-disabled-{token}",
        status=UserStatus.DISABLED,
    )
    deleted_actor = add_user(integration_db, f"audit-deleted-{token}")
    deleted_actor.is_deleted = True
    deleted_actor.deleted_at = datetime.now(UTC)
    unestablished_actor = add_user(integration_db, f"audit-unestablished-{token}")
    unestablished_actor.invitation_sent_at = datetime.now(UTC)
    removed_actor = add_user(integration_db, f"audit-removed-{token}")

    entity_id = uuid7()
    now = datetime.now(UTC)
    actors = [
        (display_actor, f"Display Name {token}"),
        (fallback_actor, fallback_actor.username),
        (disabled_actor, None),
        (deleted_actor, None),
        (unestablished_actor, None),
        (removed_actor, None),
        (None, None),
    ]
    rows = [
        AuditLog(
            id=uuid7(),
            created_at=now + timedelta(seconds=index),
            action=AuditAction.UPDATE,
            entity_type="actor-name-test",
            entity_id=entity_id,
            performed_by=actor.id if actor is not None else None,
            actor_label="Audit marker",
        )
        for index, (actor, _) in enumerate(actors)
    ]
    for row in rows:
        object.__setattr__(row, "_audit_internal", True)
    integration_db.add_all(rows)
    integration_db.flush()
    integration_db.delete(removed_actor)
    integration_db.flush()
    integration_db.refresh(rows[-2], attribute_names=["performed_by"])
    assert rows[-2].performed_by is None

    statements, capture_statement = _statement_collector()

    with _client(api, make_user(f"audit-actor-admin-{token}"), integration_db) as client:
        engine = integration_db.get_bind()
        event.listen(engine, "before_cursor_execute", capture_statement)
        try:
            listed = client.get(
                "/api/audit-logs",
                params={"entity_id": str(entity_id), "limit": 100},
            )
            detail = client.get(f"/api/audit-logs/{rows[0].id}")
            exported = client.get(
                "/api/audit-logs/export",
                params={"entity_id": str(entity_id), "limit": 100},
            )
        finally:
            event.remove(engine, "before_cursor_execute", capture_statement)

    assert listed.status_code == detail.status_code == exported.status_code == 200
    by_id = {item["id"]: item for item in listed.json()["items"]}
    assert len(by_id) == len(rows)
    for row, (_, expected_name) in zip(rows, actors, strict=True):
        listed_item = by_id[str(row.id)]
        assert listed_item["actor_name"] == expected_name
        assert listed_item["actor_label"] == "Audit marker"

    assert detail.json()["actor_name"] == f"Display Name {token}"
    exported_by_id = {item["id"]: item for item in exported.json()}
    assert {log_id: item["actor_name"] for log_id, item in exported_by_id.items()} == {
        str(row.id): expected_name for row, (_, expected_name) in zip(rows, actors, strict=True)
    }

    lowered_statements = [statement.casefold() for statement in statements]
    actor_queries = [query for query in lowered_statements if "from users" in query]
    assert len(actor_queries) == 3
    assert all("users.id in" in statement for statement in actor_queries)


def _seed_audit_options(session: Session, rows: list[AuditLog]) -> None:
    for row in rows:
        object.__setattr__(row, "_audit_internal", True)
    session.add_all(rows)
    session.flush()


def test_audit_options_are_empty_bounded_recent_and_registered_before_detail(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    token = uuid7().hex
    with _client(api, make_user(f"options-admin-{token}"), integration_db) as client:
        empty = client.get("/api/audit-logs/options")
        assert empty.status_code == 200
        assert empty.json() == {"entity_types": [], "actors": []}

        people = [
            make_user(f"options-person-{token}-{index}", role=UserRole.MEMBER)
            for index in range(201)
        ]
        people[199].display_name = f"Options display {token}"
        people[200].status = UserStatus.DISABLED.value
        integration_db.add_all(people)
        integration_db.flush()

        base_time = datetime(2100, 1, 1, tzinfo=UTC)
        rows: list[AuditLog] = []
        for index in [*range(199), 200, 199]:
            used_at = base_time + timedelta(days=min(index, 199))
            actor_label = None if index % 2 == 0 else f"Person {index:03d}"
            rows.append(
                AuditLog(
                    id=uuid7(),
                    created_at=used_at,
                    action=AuditAction.UPDATE,
                    entity_type=f"kind-{index:03d}",
                    performed_by=people[index].id,
                    actor_label=actor_label,
                )
            )
        rows.extend(
            [
                AuditLog(
                    id=uuid7(),
                    created_at=base_time + timedelta(days=150, hours=1),
                    action=AuditAction.UPDATE,
                    entity_type="kind-150",
                    performed_by=people[150].id,
                    actor_label="Most recent label",
                ),
                AuditLog(
                    id=uuid7(),
                    created_at=base_time - timedelta(seconds=1),
                    action=AuditAction.UPDATE,
                    entity_type="kind-000",
                    actor_label="Background process",
                ),
            ]
        )
        _seed_audit_options(integration_db, rows)

        listed = client.get("/api/audit-logs", params={"limit": 25})
        assert listed.status_code == 200
        assert "kind-050" not in {item["entity_type"] for item in listed.json()["items"]}

        statements, capture_option_query = _statement_collector()

        engine = integration_db.get_bind()
        event.listen(engine, "before_cursor_execute", capture_option_query)
        try:
            response = client.get("/api/audit-logs/options")
        finally:
            event.remove(engine, "before_cursor_execute", capture_option_query)
        assert response.status_code == 200
        options = response.json()
        entity_types = options["entity_types"]
        assert len(entity_types) == 200
        assert len(set(entity_types)) == 200
        assert entity_types[:3] == ["kind-199", "kind-200", "kind-198"]
        assert entity_types[-1] == "kind-001"
        assert "kind-000" not in entity_types
        assert "kind-050" in entity_types

        actors = options["actors"]
        assert len(actors) == 200
        assert len({actor["performed_by"] for actor in actors}) == 200
        expected_people = [
            *sorted((people[199], people[200]), key=lambda person: person.id),
            *[people[index] for index in range(198, 150, -1)],
            people[150],
            *[people[index] for index in range(149, 0, -1)],
        ]
        assert [actor["performed_by"] for actor in actors] == [
            str(person.id) for person in expected_people
        ]
        actors_by_id = {actor["performed_by"]: actor for actor in actors}
        assert actors_by_id[str(people[199].id)]["actor_name"] == people[199].display_name
        assert actors_by_id[str(people[150].id)]["actor_name"] == people[150].username
        assert actors_by_id[str(people[200].id)]["actor_name"] is None
        assert actors_by_id[str(people[200].id)]["actor_label"] is None
        assert actors_by_id[str(people[150].id)]["actor_label"] == "Most recent label"
        assert all(actor["actor_label"] != "Background process" for actor in actors)
        assert sum("from users" in statement.casefold() for statement in statements) == 1
        assert any("users.id in" in statement.casefold() for statement in statements)

        detail = client.get(f"/api/audit-logs/{rows[0].id}")
        assert detail.status_code == 200
        assert detail.json()["id"] == str(rows[0].id)


def test_audit_options_share_list_department_visibility(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    token = uuid7().hex
    managed_department = add_department(integration_db)
    other_department = add_department(integration_db)
    manager = add_user(integration_db, role=UserRole.MEMBER)
    module_manager = add_user(integration_db, role=UserRole.MEMBER)
    administrator = add_user(integration_db, role=UserRole.ADMIN)
    module = add_module(integration_db, managed_department)
    make_group_access(integration_db, [manager], managed_department, level=AccessLevel.MANAGE)
    make_group_access(
        integration_db,
        [module_manager],
        managed_department,
        module,
        level=AccessLevel.MANAGE,
    )
    managed_log = AuditLog(
        id=uuid7(),
        created_at=datetime(2100, 1, 1, tzinfo=UTC),
        action=AuditAction.UPDATE,
        entity_type=f"managed-{token}",
        department_id=managed_department.id,
        performed_by=manager.id,
    )
    other_log = AuditLog(
        id=uuid7(),
        created_at=datetime(2100, 1, 2, tzinfo=UTC),
        action=AuditAction.UPDATE,
        entity_type=f"other-{token}",
        department_id=other_department.id,
        performed_by=administrator.id,
    )
    _seed_audit_options(integration_db, [managed_log, other_log])

    all_options = _client(api, administrator, integration_db).get("/api/audit-logs/options")
    assert all_options.status_code == 200
    assert {f"managed-{token}", f"other-{token}"} <= set(all_options.json()["entity_types"])

    scoped_options = _client(api, administrator, integration_db).get(
        "/api/audit-logs/options",
        params={"department_id": str(managed_department.id)},
    )
    assert scoped_options.status_code == 200
    assert f"managed-{token}" in scoped_options.json()["entity_types"]
    assert f"other-{token}" not in scoped_options.json()["entity_types"]
    assert scoped_options.json()["actors"] == [
        {
            "performed_by": str(manager.id),
            "actor_label": None,
            "actor_name": manager.display_name or manager.username,
        }
    ]

    for actor, params in (
        (manager, {}),
        (manager, {"department_id": str(other_department.id)}),
        (module_manager, {"department_id": str(managed_department.id)}),
    ):
        denied = _client(api, actor, integration_db).get("/api/audit-logs/options", params=params)
        assert denied.status_code == 403

    manager_options = _client(api, manager, integration_db).get(
        "/api/audit-logs/options",
        params={"department_id": str(managed_department.id)},
    )
    assert manager_options.status_code == 200
    assert f"other-{token}" not in manager_options.json()["entity_types"]
