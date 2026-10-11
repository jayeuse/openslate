"""Chart source admission and current authority through real HTTP/PostgreSQL boundaries."""

from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, OperationalError

from app.core.base_model import utc_now
from app.systems.access.identity.models import IdentitySession
from app.systems.openview.charts.models import Chart
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from tests.charts.chart_route_support import chart_world as chart_world
from tests.rbac.support import make_group_access, make_user

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("kind", ["bar", "pie", "summary", "workload", "records", "line"])
def test_every_accepted_query_family_is_saved_without_materialized_results(chart_world, kind):
    world = chart_world
    query = world.grouped()
    if kind == "records":
        query = {
            "module_id": str(world.module.id),
            "definition": {
                "columns": [{"field_id": str(world.label.id), "expected_type": "text"}],
                "filters": [],
                "sort": [],
            },
        }
    if kind == "line":
        query = {
            "module_id": str(world.module.id),
            "definition": {"columns": [], "filters": []},
            "mode": "date_series",
            "date_field": {"field_id": str(world.date.id), "expected_type": "date"},
            "aggregation": "count",
            "from_date": "2015-01-01",
            "to_date": "2025-12-31",
            "bucket": "year",
        }
    with world.client("manager") as client:
        result = client.post("/api/charts", json=world.body(kind=kind, query=query))
        assert result.status_code == 201
        saved = client.get(f"/api/charts/{result.json()['id']}").json()
        assert saved["chart_type"] == kind
        assert saved["query"]["module_id"] == str(world.module.id)
        assert "results" not in saved and "snapshot" not in saved
        if kind == "line":
            assert (
                saved["query"]["bucket"],
                saved["query"]["from_date"],
                saved["query"]["to_date"],
            ) == ("year", "2015-01-01", "2025-12-31")


@pytest.mark.parametrize("metric", ["sum", "average", "min", "max", "distinct"])
def test_snapshot_metric_and_typed_measure_survive_create_and_reload(chart_world, metric):
    world = chart_world
    query = world.grouped()
    measure = world.person if metric == "distinct" else world.amount
    query.update(
        {
            "aggregation": metric,
            "measure": {
                "field_id": str(measure.id),
                "expected_type": "user" if metric == "distinct" else "number",
            },
        }
    )
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body(query=query))
        assert created.status_code == 201
        saved = client.get(f"/api/charts/{created.json()['id']}").json()["query"]
        assert saved["aggregation"] == metric and saved["measure"]["field_id"] == str(measure.id)


def test_an_invalid_request_definition_is_422_and_saves_nothing(chart_world):
    """One HTTP case; tests/charts/test_chart_contracts.py owns every request rule."""

    world = chart_world
    body = world.body()
    body["chart_type"] = "line"
    with world.client("manager") as client:
        assert client.post("/api/charts", json=body).status_code == 422
    assert world.db.scalar(select(func.count()).select_from(Chart)) == 0


@pytest.mark.parametrize(
    "defect", ["wrong-field-type", "foreign-field", "deleted-field", "closed-module"]
)
def test_unavailable_current_sources_are_generic_conflicts_without_writes(chart_world, defect):
    world = chart_world
    body = world.body()
    if defect == "wrong-field-type":
        body["query"]["dimension"]["expected_type"] = "number"
    elif defect == "foreign-field":
        foreign = Field(
            module_id=world.other_module.id,
            name="Foreign field",
            type=FieldType.TEXT,
            position=0,
            config={},
        )
        world.db.add(foreign)
        world.db.flush()
        body["query"]["dimension"]["field_id"] = str(foreign.id)
    elif defect == "deleted-field":
        world.label.is_deleted = True
        world.label.deleted_at = utc_now()
    else:
        world.module.is_deleted = True
        world.module.deleted_at = utc_now()
    with world.client("manager") as client:
        result = client.post("/api/charts", json=body)
        assert result.status_code == 409
        assert result.json()["detail"]["code"] == "chart_invalid"
        assert str(world.label.id) not in result.text
    assert world.db.scalar(select(func.count()).select_from(Chart)) == 0


@pytest.mark.parametrize("invalid_session", ["revoked", "expired", "wrong-user"])
def test_mutations_recheck_the_exact_live_session(chart_world, invalid_session):
    world = chart_world
    now = utc_now()
    session = IdentitySession(
        user_id=world.users["manager"].id,
        refresh_token_digest="a" * 64,
        csrf_token_digest="b" * 64,
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(hours=1),
    )
    if invalid_session == "revoked":
        session.revoked_at = now
    elif invalid_session == "expired":
        session.expires_at = now - timedelta(seconds=1)
    else:
        session.user_id = world.users["reader"].id
    world.db.add(session)
    with world.client("manager", session=session) as client:
        assert client.post("/api/charts", json=world.body()).status_code == 403
    assert world.db.scalar(select(func.count()).select_from(Chart)) == 0


def test_changed_query_is_redacted_and_commit_failure_rolls_back_chart_and_audit(
    chart_world, monkeypatch
):
    world = chart_world
    with world.client("manager") as client:
        initial = client.post("/api/charts", json=world.body()).json()
        chart_id = UUID(initial["id"])
        count = len(world.audit_rows(chart_id))
        original_commit = world.db.commit

        def fail_commit():
            world.db.flush()
            raise IntegrityError("owned failure", {}, Exception("owned dependency canary"))

        monkeypatch.setattr(world.db, "commit", fail_commit)
        failed = client.patch(
            f"/api/charts/{chart_id}", json={"revision": 1, "name": "Must roll back"}
        )
        assert failed.status_code == 409 and "owned dependency canary" not in failed.text
        monkeypatch.setattr(world.db, "commit", original_commit)
        world.db.expire_all()
        assert world.db.get(Chart, chart_id).name == "Reviewed Chart"
        assert len(world.audit_rows(chart_id)) == count
        query = world.grouped()
        query["definition"]["search"] = "Private query canary"
        changed = client.patch(f"/api/charts/{chart_id}", json={"revision": 1, "query": query})
        assert changed.status_code == 200 and changed.json()["revision"] == 2
        assert "Private query canary" not in str(
            [(row.before, row.after) for row in world.audit_rows(chart_id)]
        )


def test_archive_can_close_an_unused_chart_after_its_source_module_closes(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        world.module.is_deleted = True
        world.module.deleted_at = utc_now()
        world.db.commit()
        result = client.delete(f"/api/charts/{created['id']}", params={"revision": 1})
        assert result.status_code == 204


def test_stale_cached_admin_identity_cannot_write_after_role_demotion(chart_world):
    world = chart_world
    actor = world.users["admin"]
    identifier = actor.id
    actor.role = "member"
    world.db.commit()
    stale = make_user("cached-chart-admin", role="admin")
    stale.id = identifier
    world.users["admin"] = stale
    with world.client("admin") as client:
        assert client.post("/api/charts", json=world.body()).status_code == 403
    assert world.db.scalar(select(func.count()).select_from(Chart)) == 0


def test_current_locked_module_department_controls_edit_not_stored_chart_owner(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        chart_id = UUID(created["id"])
        world.module.department_id = world.other_module.department_id
        new_department = world.db.get(Department, world.other_module.department_id)
        make_group_access(
            world.db, [world.users["manager"]], new_department, world.module, level="read"
        )
        world.db.commit()
        assert client.get(f"/api/charts/{chart_id}").status_code == 200
        assert (
            client.patch(
                f"/api/charts/{chart_id}", json={"revision": 1, "name": "Wrong owner"}
            ).status_code
            == 403
        )
        world.db.expire_all()
        assert world.db.get(Chart, chart_id).revision == 1


def test_restore_preserves_stale_query_metadata_then_active_patch_repairs_fields(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        chart_id = UUID(created["id"])
        assert client.delete(f"/api/charts/{chart_id}", params={"revision": 1}).status_code == 204
        stored_query = created["query"]
        before = len(world.audit_rows(chart_id))
        world.label.type = FieldType.NUMBER
        world.db.commit()
        invalid_revision = client.post(f"/api/charts/{chart_id}/restore", json={"revision": 1})
        assert invalid_revision.status_code == 409
        assert invalid_revision.json()["detail"]["code"] == "stale_revision"
        with world.client("reader") as reader:
            assert (
                reader.post(f"/api/charts/{chart_id}/restore", json={"revision": 2}).status_code
                == 403
            )
        restored = client.post(f"/api/charts/{chart_id}/restore", json={"revision": 2})
        assert restored.status_code == 200
        assert restored.json()["query"] == stored_query
        assert restored.json()["revision"] == 3
        world.db.expire_all()
        assert world.db.get(Chart, chart_id).is_deleted is False
        assert world.db.get(Chart, chart_id).query == stored_query
        assert len(world.audit_rows(chart_id)) == before + 1
        repaired_query = world.grouped()
        repaired_query["dimension"] = {"field_id": str(world.person.id), "expected_type": "user"}
        repaired = client.patch(
            f"/api/charts/{chart_id}", json={"revision": 3, "query": repaired_query}
        )
        assert repaired.status_code == 200 and repaired.json()["revision"] == 4
        assert repaired.json()["query"]["dimension"]["field_id"] == str(world.person.id)
        assert repaired.json()["query"]["dimension"]["expected_type"] == "user"
        assert len(world.audit_rows(chart_id)) == before + 2


def test_partial_family_change_is_atomic_and_matching_replacement_succeeds(chart_world):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        chart_id = UUID(created["id"])
        invalid = client.patch(
            f"/api/charts/{chart_id}", json={"revision": 1, "chart_type": "line"}
        )
        assert invalid.status_code == 409
        assert client.get(f"/api/charts/{chart_id}").json()["revision"] == 1
        line = {
            "module_id": str(world.module.id),
            "definition": {"columns": [], "filters": []},
            "mode": "date_series",
            "date_field": {"field_id": str(world.date.id), "expected_type": "date"},
            "aggregation": "count",
            "from_date": "2025-01-01",
            "to_date": "2025-12-31",
            "bucket": "month",
        }
        saved = client.patch(
            f"/api/charts/{chart_id}", json={"revision": 1, "chart_type": "line", "query": line}
        )
        assert saved.status_code == 200 and saved.json()["revision"] == 2
        assert saved.json()["query"]["bucket"] == "month"


def test_database_read_failure_is_generic_unavailable_without_losing_saved_state(
    chart_world, monkeypatch
):
    world = chart_world
    with world.client("manager") as client:
        created = client.post("/api/charts", json=world.body()).json()
        original_scalar = world.db.scalar

        def unavailable(*args, **kwargs):
            raise OperationalError("owned read failure", {}, Exception("PRIVATE DATABASE CANARY"))

        monkeypatch.setattr(world.db, "scalar", unavailable)
        failed = client.get(f"/api/charts/{created['id']}")
        assert failed.status_code == 503 and failed.json()["detail"]["code"] == "chart_unavailable"
        assert failed.headers["cache-control"] == "private, no-store"
        assert "PRIVATE DATABASE CANARY" not in failed.text
        monkeypatch.setattr(world.db, "scalar", original_scalar)
        assert client.get(f"/api/charts/{created['id']}").json()["revision"] == 1
