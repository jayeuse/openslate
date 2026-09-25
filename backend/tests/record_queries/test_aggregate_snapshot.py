"""Complete aggregate snapshot contract and PostgreSQL isolation regressions."""

from collections.abc import Generator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Role, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import SecurityEvent
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records import aggregation, query_router
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_schemas import (
    MAX_AGGREGATE_SNAPSHOT_BUCKETS,
    MAX_AGGREGATE_SNAPSHOT_BYTES,
    AggregateSnapshotQuery,
    AggregateSnapshotResponse,
    DateSeriesAggregateQuery,
    GroupedAggregateSnapshotQuery,
)


def test_aggregate_snapshot_requires_authentication() -> None:
    client = TestClient(create_app())
    try:
        response = client.post("/api/records/aggregate-snapshot", json={})
    finally:
        client.close()

    assert response.status_code == 401


def test_snapshot_group_request_rejects_pagination_and_date_series_requires_dates() -> None:
    common = {
        "module_id": uuid7(),
        "definition": {"columns": []},
    }
    group = {
        **common,
        "mode": "groups",
        "dimension": {"field_id": uuid7(), "expected_type": "text"},
    }

    for pagination in ({"limit": 2}, {"offset": 2}):
        with pytest.raises(ValidationError):
            GroupedAggregateSnapshotQuery(**group, **pagination)
    with pytest.raises(ValidationError):
        DateSeriesAggregateQuery(
            **common,
            date_field={"field_id": uuid7(), "expected_type": "date"},
        )

    assert MAX_AGGREGATE_SNAPSHOT_BUCKETS == 10_000
    assert MAX_AGGREGATE_SNAPSHOT_BYTES == 8 * 1024 * 1024


@dataclass
class _SnapshotFixture:
    engine: Engine
    actor: User
    session_id: UUID
    role_id: UUID
    module_id: UUID
    dimension_id: UUID
    date_field_id: UUID
    record_ids: list[UUID]
    department_id: UUID

    def grouped_payload(self) -> dict[str, object]:
        return {
            "module_id": str(self.module_id),
            "definition": {"columns": []},
            "mode": "groups",
            "dimension": {"field_id": str(self.dimension_id), "expected_type": "select"},
        }

    def date_series_payload(self) -> dict[str, object]:
        return {
            "module_id": str(self.module_id),
            "definition": {"columns": []},
            "mode": "date_series",
            "date_field": {"field_id": str(self.date_field_id), "expected_type": "date"},
            "from_date": "2026-01-01",
            "to_date": "2027-01-01",
        }


@pytest.fixture
def snapshot_fixture(integration_owner_db: Session) -> Generator[_SnapshotFixture, None, None]:
    engine = integration_owner_db.get_bind().engine
    actor_id = uuid7()
    session_id = uuid7()
    role_id = uuid7()
    department_id = uuid7()
    module_id = uuid7()
    dimension_id = uuid7()
    date_field_id = uuid7()
    record_ids = [uuid7(), uuid7()]
    select_values = ["Alpha", "Beta"]
    dimension_key = str(dimension_id)
    date_key = str(date_field_id)

    with Session(engine) as setup:
        role = Role(id=role_id, role=f"snapshot-{role_id.hex}", permissions={"records.read": True})
        actor = User(
            id=actor_id,
            email=f"snapshot-{actor_id}@example.com",
            username=f"snapshot_{actor_id.hex[:12]}",
            status="active",
            role=role,
        )
        department = Department(id=department_id, department_name=f"snapshot-{department_id}")
        module = Module(
            id=module_id,
            department_id=department_id,
            module_name=f"Snapshot {module_id}",
        )
        dimension = Field(
            id=dimension_id,
            module_id=module_id,
            name="Category",
            type=FieldType.SELECT,
            position=0,
            required=False,
            config={"options": [*select_values, "Missing"]},
        )
        date_field = Field(
            id=date_field_id,
            module_id=module_id,
            name="Date",
            type=FieldType.DATE,
            position=1,
            required=False,
            config={},
        )
        db_session = IdentitySession(
            id=session_id,
            user_id=actor_id,
            refresh_token_digest=uuid7().hex * 2,
            csrf_token_digest=uuid7().hex * 2,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        setup.add_all([department, module, dimension, date_field, role, actor])
        setup.flush()
        setup.add(db_session)
        setup.add_all(
            [
                Record(
                    id=record_id,
                    module_id=module_id,
                    data={dimension_key: value, date_key: day},
                )
                for record_id, value, day in zip(
                    record_ids,
                    select_values,
                    ("2026-01-01", "2026-01-03"),
                    strict=True,
                )
            ]
        )
        setup.commit()
        actor = setup.scalar(
            select(User).options(joinedload(User.role)).where(User.id == actor_id)
        )
        assert actor is not None
        setup.expunge(actor)

    fixture = _SnapshotFixture(
        engine=engine,
        actor=actor,
        session_id=session_id,
        role_id=role_id,
        module_id=module_id,
        dimension_id=dimension_id,
        date_field_id=date_field_id,
        record_ids=record_ids,
        department_id=department_id,
    )
    try:
        yield fixture
    finally:
        with engine.begin() as cleanup:
            cleanup.execute(
                text(
                    "DELETE FROM public.security_events "
                    "WHERE actor_id = :actor_id OR subject_id = :module_id"
                ),
                {"actor_id": actor_id, "module_id": module_id},
            )
            cleanup.execute(
                text("DELETE FROM public.identity_sessions WHERE user_id = :actor_id"),
                {"actor_id": actor_id},
            )
            cleanup.execute(
                text("DELETE FROM public.records WHERE module_id = :id"), {"id": module_id}
            )
            cleanup.execute(
                text("DELETE FROM public.fields WHERE module_id = :id"), {"id": module_id}
            )
            cleanup.execute(
                text("DELETE FROM public.modules WHERE id = :id"), {"id": module_id}
            )
            cleanup.execute(
                text("DELETE FROM public.departments WHERE id = :id"),
                {"id": department_id},
            )
            cleanup.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": actor_id})
            cleanup.execute(text("DELETE FROM public.roles WHERE id = :id"), {"id": role_id})


def _post_snapshot(
    fixture: _SnapshotFixture,
    payload: dict[str, object],
    path: str = "/api/records/aggregate-snapshot",
) -> httpx.Response:
    application = create_app()
    application.dependency_overrides[get_current_user] = lambda: fixture.actor
    application.dependency_overrides[get_current_identity] = lambda: CurrentIdentity(
        fixture.actor, fixture.session_id, False, False
    )

    def database() -> Generator[Session, None, None]:
        with AuditSession(bind=fixture.engine) as session:
            session.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=fixture.actor.id,
                request_id=uuid7(),
                request_method="POST",
                request_path=path,
            )
            yield session

    application.dependency_overrides[get_db] = database
    client = TestClient(application)
    try:
        return client.post(path, json=payload)
    finally:
        application.dependency_overrides.clear()
        client.close()


@pytest.mark.integration
def test_snapshot_returns_every_group_and_commits_safe_audit_event(
    snapshot_fixture: _SnapshotFixture,
) -> None:
    payload = snapshot_fixture.grouped_payload()
    # Expand beyond the aggregate-query page size to prove snapshots are complete.
    with Session(snapshot_fixture.engine) as setup:
        dimension = setup.get(Field, snapshot_fixture.dimension_id)
        assert dimension is not None
        values = [f"Category {index:03}" for index in range(105)]
        dimension.config = {"options": values}
        setup.add_all(
            [
                Record(
                    module_id=snapshot_fixture.module_id,
                    data={str(snapshot_fixture.dimension_id): value},
                )
                for value in values[2:]
            ]
        )
        setup.commit()

    result = _post_snapshot(snapshot_fixture, payload)

    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    assert result.headers["x-content-type-options"] == "nosniff"
    body = result.json()
    assert len(body["items"]) == 105
    assert body["pagination"] == {
        "limit": 105,
        "offset": 0,
        "count": 105,
        "total": 105,
        "has_more": False,
    }
    with Session(snapshot_fixture.engine) as observer:
        event = observer.scalar(
            select(SecurityEvent).where(
                SecurityEvent.actor_id == snapshot_fixture.actor.id,
                SecurityEvent.subject_id == snapshot_fixture.module_id,
            )
        )
    assert event is not None
    assert event.event_type == "records.aggregate_snapshot.authorized"
    assert event.event_metadata == {"bucket_count": 105}


@pytest.mark.integration
def test_snapshot_returns_a_complete_empty_group_result(
    snapshot_fixture: _SnapshotFixture,
) -> None:
    payload = snapshot_fixture.grouped_payload()
    payload["definition"] = {
        "columns": [],
        "filters": [
            {
                "field_id": str(snapshot_fixture.dimension_id),
                "expected_type": "select",
                "operator": "eq",
                "value": "Missing",
            }
        ],
    }

    response = _post_snapshot(snapshot_fixture, payload)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [],
        "pagination": {
            "limit": 1,
            "offset": 0,
            "count": 0,
            "total": 0,
            "has_more": False,
        },
    }


@pytest.mark.integration
def test_date_series_snapshot_returns_the_full_explicit_window(
    snapshot_fixture: _SnapshotFixture,
) -> None:
    payload = snapshot_fixture.date_series_payload()
    _, count = aggregation.aggregate_snapshot(
        snapshot_fixture.engine,
        DateSeriesAggregateQuery.model_validate(payload),
    )
    assert count == 366
    response = _post_snapshot(snapshot_fixture, payload)

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["items"]) == 366
    assert body["items"][0]["label"] == "2026-01-01"
    assert body["items"][2]["record_count"] == 1
    assert body["items"][-1]["label"] == "2027-01-01"
    assert body["pagination"]["has_more"] is False


@pytest.mark.integration
def test_max_datetime_series_routes_accept_supported_maximum_date(
    snapshot_fixture: _SnapshotFixture,
) -> None:
    with Session(snapshot_fixture.engine) as setup:
        date_field = setup.get(Field, snapshot_fixture.date_field_id)
        record = setup.get(Record, snapshot_fixture.record_ids[0])
        assert date_field is not None and record is not None
        date_field.type = FieldType.DATETIME
        record.data[str(date_field.id)] = "9999-12-31T00:00:00Z"
        setup.commit()
    payload = snapshot_fixture.date_series_payload()
    payload["date_field"] = {
        "field_id": str(snapshot_fixture.date_field_id),
        "expected_type": "datetime",
    }
    payload["from_date"] = "9999-12-31"
    payload["to_date"] = "9999-12-31"

    for path in ("/api/records/aggregate-query", "/api/records/aggregate-snapshot"):
        response = _post_snapshot(snapshot_fixture, payload, path)

        assert response.status_code == 200, response.text
        assert response.json()["items"] == [
            {"key": "9999-12-31", "label": "9999-12-31", "value": 1, "record_count": 1}
        ]


@pytest.mark.integration
def test_snapshot_uses_one_repeatable_read_snapshot_during_concurrent_record_change(
    snapshot_fixture: _SnapshotFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = aggregation._grouped_aggregate_snapshot

    def update_after_validation(
        snapshot: Session, payload: GroupedAggregateSnapshotQuery, fields: dict[UUID, Field]
    ) -> AggregateSnapshotResponse:
        with Session(snapshot_fixture.engine) as writer:
            record = writer.get(Record, snapshot_fixture.record_ids[0])
            assert record is not None
            record.data[str(snapshot_fixture.dimension_id)] = "Changed"
            writer.commit()
        return original(snapshot, payload, fields)

    monkeypatch.setattr(aggregation, "_grouped_aggregate_snapshot", update_after_validation)
    response = aggregation.aggregate_snapshot(
        snapshot_fixture.engine,
        GroupedAggregateSnapshotQuery.model_validate(snapshot_fixture.grouped_payload()),
    )

    assert response[1] == 2
    assert b"Alpha" in response[0]
    assert b"Changed" not in response[0]


@pytest.mark.integration
@pytest.mark.parametrize(
    "limit_name",
    ["MAX_AGGREGATE_SNAPSHOT_BUCKETS", "MAX_AGGREGATE_SNAPSHOT_BYTES"],
)
def test_snapshot_fails_closed_when_bucket_or_json_byte_limit_is_exceeded(
    snapshot_fixture: _SnapshotFixture,
    monkeypatch: pytest.MonkeyPatch,
    limit_name: str,
) -> None:
    monkeypatch.setattr(aggregation, limit_name, 1)

    response = _post_snapshot(snapshot_fixture, snapshot_fixture.grouped_payload())

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "aggregate_snapshot_limit_exceeded"
    assert b"Alpha" not in response.content


@pytest.mark.integration
@pytest.mark.parametrize("revoke", ["capability", "session"])
def test_snapshot_rechecks_live_capability_and_session_before_release(
    snapshot_fixture: _SnapshotFixture,
    monkeypatch: pytest.MonkeyPatch,
    revoke: str,
) -> None:
    original = query_router.aggregate_snapshot

    def revoke_after_snapshot(engine: Engine, payload: AggregateSnapshotQuery) -> tuple[bytes, int]:
        result = original(engine, payload)
        with Session(engine) as writer:
            if revoke == "capability":
                role = writer.get(Role, snapshot_fixture.role_id)
                assert role is not None
                role.permissions = {"records.write": True}
            else:
                identity_session = writer.get(IdentitySession, snapshot_fixture.session_id)
                assert identity_session is not None
                identity_session.revoked_at = datetime.now(UTC)
            writer.commit()
        return result

    monkeypatch.setattr(query_router, "aggregate_snapshot", revoke_after_snapshot)
    response = _post_snapshot(snapshot_fixture, snapshot_fixture.grouped_payload())

    assert response.status_code == 403
    assert b"Alpha" not in response.content


@pytest.mark.integration
def test_snapshot_fails_closed_when_aggregate_query_is_unavailable(
    snapshot_fixture: _SnapshotFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sqlalchemy.exc import OperationalError

    def unavailable_snapshot(*_args: object, **_kwargs: object) -> tuple[bytes, int]:
        raise OperationalError("aggregate query unavailable", {}, RuntimeError("unavailable"))

    monkeypatch.setattr(query_router, "aggregate_snapshot", unavailable_snapshot)
    response = _post_snapshot(snapshot_fixture, snapshot_fixture.grouped_payload())

    assert response.status_code == 503
    assert response.json()["detail"] == "Unable to create aggregate snapshot"
    assert b"Alpha" not in response.content


@pytest.mark.integration
def test_snapshot_fails_closed_when_authorization_event_cannot_be_written(
    snapshot_fixture: _SnapshotFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sqlalchemy.exc import OperationalError

    def unavailable_event_writer(*_args: object, **_kwargs: object) -> object:
        raise OperationalError("security event unavailable", {}, RuntimeError("unavailable"))

    monkeypatch.setattr(query_router, "append_security_event", unavailable_event_writer)
    response = _post_snapshot(snapshot_fixture, snapshot_fixture.grouped_payload())

    assert response.status_code == 503
    assert response.json()["detail"] == "Unable to record aggregate snapshot authorization"
    assert b"Alpha" not in response.content
