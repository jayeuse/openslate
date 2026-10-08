from __future__ import annotations

import json
import re
from datetime import date
from re import escape, split
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest
from pydantic import TypeAdapter

from app.systems.openview.dashboards.schemas import DashboardUpdate
from app.systems.openview.reports.schedule_schemas import SchedulePatch
from app.systems.openview.reports.schemas import ReportUpdate
from app.systems.openview.views.schemas import ViewUpdate
from app.systems.sandbox.records.query_schemas import (
    AggregateQuery,
    AggregateSnapshotQuery,
    GroupedRecordQuery,
    RecordQuery,
    WindowRecordQuery,
)
from app.systems.sandbox.records.schemas import RecordCreate, RecordUpdate
from app.systems.sandbox.relationships.schemas import RelationshipCreate
from operations.sample.client import SampleClient
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.sample_purge_wire import SamplePurgeWire, report_fixture


def _uuid(value: str) -> str:
    return str(uuid5(NAMESPACE_URL, value))


def _template(method: str, path: str, routes: frozenset[tuple[str, str]]) -> set[tuple[str, str]]:
    matched = set()
    for route_method, route_template in routes:
        if method != route_method:
            continue
        pattern = (
            "^"
            + "".join(
                "[^/]+" if part.startswith("{") else escape(part)
                for part in split(r"(\{[^}]+\})", route_template)
            )
            + "$"
        )
        if re.fullmatch(pattern, path):
            matched.add((method, route_template))
    return matched


@pytest.mark.parametrize("pack_key", pack_keys())
@pytest.mark.parametrize("schedule_id", (_uuid("schedule"), None, "not-a-uuid"))
def test_openview_executor_sends_every_declared_route_with_server_request_shapes(
    tmp_path, monkeypatch: pytest.MonkeyPatch, pack_key: str, schedule_id: str | None
) -> None:
    waits: list[float] = []
    monkeypatch.setattr("operations.sample.controls.openview_mutations.time.sleep", waits.append)
    from operations.sample.controls.openview import (
        CONTROL_ROUTES,
        execute_openview_control,
        plan_openview_controls,
    )

    dataset = build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack_key)
    )
    actions = plan_openview_controls(dataset)
    records: dict[str, dict[str, object]] = {}
    seen: list[tuple[str, str]] = []
    counter = 0
    delete_attempts = 0
    pack = dataset.organization
    department_key = str(
        next(
            action.values["department_key"]
            for action in actions
            if action.values.get("operation") == "view_patch"
        )
    )
    source_module = str(
        next(
            action.values["module_key"]
            for action in actions
            if action.values.get("operation") == "view_patch"
        )
    )
    targets = {action.values["operation"]: action.target_key for action in actions}
    view_target, dashboard_target, report_target = (
        targets[f"{resource}_patch"] for resource in ("view", "dashboard", "report")
    )
    live_modules = {module.key: _uuid(f"module:{module.key}") for module in pack.catalog.modules}
    live_fields = {
        f"{module.key}:{field.key}": _uuid(f"field:{module.key}:{field.key}")
        for module in pack.catalog.modules
        for field in module.fields
    }
    live_records = {
        record.logical_id: _uuid(f"record:{record.logical_id}") for record in dataset.records
    }
    relation_key = str(
        next(
            action.values["relation_key"]
            for action in actions
            if action.values.get("operation") == "relationship_delete"
        )
    )
    view_id, dashboard_id, report_id = (
        _uuid("saved-view"),
        _uuid("dashboard"),
        _uuid("report"),
    )
    mappings = {
        "modules": live_modules,
        "fields": live_fields,
        "records": live_records,
        "relationships": {relation_key: _uuid(f"relationship-field:{relation_key}")},
        "views": {view_target: view_id},
        "dashboards": {dashboard_target: dashboard_id},
        "reports": {report_target: report_id},
    }
    name_id = live_fields[f"{source_module}:name"]
    title_fields = {
        live_id: live_fields[f"{module_key}:name"] for module_key, live_id in live_modules.items()
    }
    resource_state: dict[str, dict[str, object]] = {
        "view": {
            "id": view_id,
            "module_id": live_modules[source_module],
            "name": "Existing view",
            "revision": 3,
            "is_deleted": False,
        },
        "dashboard": {
            "id": dashboard_id,
            "department_id": _uuid(f"department:{department_key}"),
            "name": "Existing dashboard",
            "revision": 5,
            "is_deleted": False,
        },
        "report": report_fixture(
            report_id, live_modules[source_module], name_id, name="Existing report"
        ),
        "schedule": {
            "id": schedule_id,
            "report_id": report_id,
            "revision": 2,
            "enabled": False,
            "cadence": "daily",
            "timezone_name": pack.identity.timezone,
            "local_time": "09:00",
            "weekday": None,
            "month_day": None,
            "next_due_at": None,
            "created_at": "2026-10-01T00:00:00Z",
            "updated_at": "2026-10-01T00:00:00Z",
        },
    }

    purge_wire = SamplePurgeWire(
        "report", source=resource_state["report"], actor_id=_uuid("user:admin")
    )

    def response(status: int, body: object | None = None) -> httpx.Response:
        nonlocal counter
        headers = {"X-Request-ID": _uuid(f"request:{counter}")}
        counter += 1
        if status == 204:
            return httpx.Response(status, headers=headers)
        return httpx.Response(status, headers=headers, json=body)

    def pagination(limit, offset=0):
        return {"limit": limit, "offset": offset, "count": 0, "total": 0, "has_more": False}

    def record_response(record_id: str) -> dict[str, object]:
        row = records[record_id]
        return {
            "id": record_id,
            "module_id": row["module_id"],
            "data": row["data"],
            "display_values": {},
            "created_at": "2026-10-01T00:00:00Z",
            "updated_at": row["updated_at"],
            "deleted_at": None if not row["is_deleted"] else "2026-10-01T00:01:00Z",
            "is_deleted": row["is_deleted"],
            "performed_by": _uuid("user:admin"),
        }

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal delete_attempts
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        seen.append((request.method, request.url.path))
        path, method = request.url.path, request.method
        purge_response = purge_wire.route(request)
        if purge_response is not None:
            return purge_response
        if path.endswith(
            ("/query", "/grouped-query", "/window-query", "/aggregate-query", "/aggregate-snapshot")
        ):
            body = json.loads(request.content)
            if path.endswith("/grouped-query"):
                GroupedRecordQuery.model_validate(body)
                return response(
                    200,
                    {
                        "items": [],
                        "pagination": None,
                        "groups": [],
                        "group_pagination": pagination(body["group_limit"], body["group_offset"]),
                        "selected_group": None,
                    },
                )
            if path.endswith("/window-query"):
                query = WindowRecordQuery.model_validate(body)
                return response(
                    200,
                    {
                        "items": [],
                        "pagination": pagination(query.limit, query.offset),
                        "timezone": pack.identity.timezone,
                    },
                )
            if path.endswith("/aggregate-query"):
                TypeAdapter(AggregateQuery).validate_python(body)
            elif path.endswith("/aggregate-snapshot"):
                TypeAdapter(AggregateSnapshotQuery).validate_python(body)
                return response(
                    200,
                    {
                        "items": [],
                        "pagination": pagination(12),
                    },
                )
            else:
                query = RecordQuery.model_validate(body)
                return response(
                    200,
                    {
                        "items": [],
                        "pagination": pagination(query.limit, query.offset),
                    },
                )
            return response(
                200,
                {
                    "items": [],
                    "pagination": pagination(12),
                },
            )
        if method == "POST" and path == "/api/records":
            payload = RecordCreate.model_validate(json.loads(request.content))
            record_id = _uuid(f"created:{counter}")
            records[record_id] = {
                "module_id": str(payload.module_id),
                "data": payload.data,
                "updated_at": "2026-10-01T00:00:00Z",
                "is_deleted": False,
            }
            return response(201, record_response(record_id))
        if path.startswith("/api/records/"):
            record_id = path.split("/")[3]
            if method == "GET":
                return response(200, record_response(record_id))
            row = records[record_id]
            if method == "PATCH":
                payload = RecordUpdate.model_validate(json.loads(request.content))
                assert request.headers["if-match"] == f'"{row["updated_at"]}"'
                lifecycle = next(a for a in actions if a.values["operation"] == "record_lifecycle")
                # Like the server, replace every active value; only the name may differ.
                submitted = payload.data or {}
                assert set(submitted) == set(row["data"])
                changed = {key for key in submitted if submitted[key] != row["data"][key]}
                assert {submitted[key] for key in changed} <= {
                    lifecycle.values["temporary_name"],
                    lifecycle.values.get("edited_name"),
                }
                row["data"] = dict(submitted)
                row["updated_at"] = f"2026-10-01T00:00:{counter % 60:02d}Z"
                return response(200, record_response(record_id))
            if method == "POST" and path.endswith("/purge/preview"):
                assert row["is_deleted"] is True
                # The delete queued automation work that is still pending at the first review.
                row["previews"] = row.get("previews", 0) + 1
                blockers = (
                    [
                        {
                            "code": "purge_trigger_dependency",
                            "entity_type": "record_trigger_events",
                            "entity_id": _uuid(f"event:{record_id}"),
                            "detail": "Automation work is still pending",
                        }
                    ]
                    if row["previews"] == 1
                    else []
                )
                return response(
                    200,
                    {
                        "token": f"token-{counter}",
                        "confirmation_name": row["data"][title_fields[row["module_id"]]],
                        "impact": {
                            "target_type": "record",
                            "target_id": record_id,
                            "operation": "purge",
                            "blockers": blockers,
                        },
                    },
                )
            if method == "POST" and path.endswith("/purge"):
                body = json.loads(request.content)
                assert row["is_deleted"] is True
                assert body["confirmation_name"] == row["data"][title_fields[row["module_id"]]]
                assert body["password"] == "fixture-admin-password"
                del records[record_id]
                for relationship_id, edge in list(records.items()):
                    if (
                        edge.get("source_record_id") == record_id
                        or edge.get("target_record_id") == record_id
                    ):
                        del records[relationship_id]
                return response(
                    200,
                    {
                        "operation_id": _uuid(f"operation:{counter}"),
                        "impact": {
                            "target_type": "record",
                            "target_id": record_id,
                            "operation": "purge",
                        },
                    },
                )
            if method == "DELETE":
                row["is_deleted"] = True
                return response(204)
            if method == "POST" and path.endswith("/restore"):
                row["is_deleted"] = False
                return response(200, record_response(record_id))
        if path == "/api/relationships" and method == "POST":
            payload = RelationshipCreate.model_validate(json.loads(request.content))
            relationship_id = _uuid(f"relationship:{counter}")
            records[relationship_id] = {
                "id": relationship_id,
                "field_id": str(payload.field_id),
                "source_record_id": str(payload.source_record_id),
                "target_record_id": str(payload.target_record_id),
                "created_at": "2026-10-01T00:00:00Z",
                "updated_at": "2026-10-01T00:00:00Z",
                "deleted_at": None,
                "is_deleted": False,
                "performed_by": _uuid("user:admin"),
                "visibility": "available",
                "hidden_reasons": [],
            }
            return response(201, records[relationship_id])
        if path.startswith("/api/relationships/"):
            relationship_id = path.rsplit("/", 1)[1]
            edge = records[relationship_id]
            if method == "GET":
                return response(200, edge)
            if method == "DELETE":
                delete_attempts += 1
                if delete_attempts == 1:
                    return response(
                        503, {"detail": "Relationship operation is temporarily unavailable"}
                    )
                edge["is_deleted"] = True
                edge["deleted_at"] = "2026-10-01T00:01:00Z"
                return response(204)
        for resource in ("view", "dashboard", "report", "schedule"):
            resource_path = {
                "view": "/api/views/",
                "dashboard": "/api/dashboards/",
                "report": "/api/reports/",
                "schedule": "/api/reports/",
            }[resource]
            if not path.startswith(resource_path):
                continue
            if resource == "schedule" and not path.endswith("/schedule"):
                continue
            if resource == "report" and path.endswith("/schedule"):
                continue
            if resource == "schedule":
                resource_state = resource_state_map["schedule"]
            else:
                resource_state = resource_state_map[resource]
            if method == "GET":
                return response(200, resource_state)
            if method == "PATCH":
                body = json.loads(request.content)
                if resource != "schedule":
                    planned = next(
                        a for a in actions if a.values["operation"] == f"{resource}_patch"
                    )
                    assert body["name"] in {
                        f"Existing {resource}",
                        planned.values.get("edited_name"),
                    }
                if resource == "view":
                    payload = ViewUpdate.model_validate(body)
                elif resource == "dashboard":
                    payload = DashboardUpdate.model_validate(body)
                elif resource == "report":
                    payload = ReportUpdate.model_validate(body)
                else:
                    payload = SchedulePatch.model_validate(body)
                assert payload.revision == resource_state["revision"]
                for key, value in body.items():
                    if key != "revision":
                        resource_state[key] = value
                resource_state["revision"] = int(resource_state["revision"]) + 1
                if resource == "schedule" and "local_time" in body:
                    resource_state["local_time"] = body["local_time"]
                return response(200, resource_state)
        raise AssertionError(f"Unexpected request: {method} {path}")

    resource_state_map = resource_state
    user_keys = {
        "admin",
        *(person.key for person in pack.actors.people),
        *(action.actor_key for action in actions),
    }
    clients: dict[str, SampleClient] = {}
    try:
        for actor in user_keys:
            client = SampleClient(
                "http://sample.test",
                "http://localhost",
                tmp_path / f"{actor}.jsonl",
                transport=httpx.MockTransport(handler),
            )
            assert client.login(f"{actor}@sample.test", "fixture-password").status_code == 200
            clients[actor] = client
        context = PhaseExecutionContext(
            clients=clients,
            user_ids={actor: _uuid(f"user:{actor}") for actor in user_keys},
            group_ids={},
            department_ids={key: _uuid(f"department:{key}") for key, _ in pack.catalog.departments},
            module_ids=live_modules,
            field_ids=live_fields,
            mappings=mappings,
            admin_password="fixture-admin-password",
        )
        if schedule_id != _uuid("schedule"):
            schedule_action = next(
                action for action in actions if action.values.get("operation") == "schedule_patch"
            )
            with pytest.raises(SamplePhaseActionError, match="report schedule.*invalid"):
                execute_openview_control(schedule_action, dataset, context)
            return
        results = [execute_openview_control(action, dataset, context) for action in actions]
    finally:
        for client in clients.values():
            client.close()

    matched = set().union(*(_template(method, path, CONTROL_ROUTES) for method, path in seen))
    assert matched == CONTROL_ROUTES
    assert len(results) == len(actions)
    assert all(result["outcome"] == "completed" for result in results)
    assert not records
    journal = [
        json.loads(line)
        for path in tmp_path.glob("*.jsonl")
        for line in path.read_text().splitlines()
    ]
    completed = [row for row in journal if row["event"] == "request_finished"]
    journey = [method for method, path in seen if path.startswith("/api/relationships/")]
    assert journey == ["DELETE", "GET", "DELETE", "GET"]
    assert [row["status_code"] for row in completed if row["status_code"] == 503] == [503]
    assert [row.get("failure_code") for row in completed if row["status_code"] == 503] == [
        "relationship_busy"
    ]
    assert waits.count(0.3) == 1
    assert [
        row["status_code"]
        for result in results
        for row in result["request_evidence"]
        if row["step"] == "delete_control_relationship"
    ] == [204]
