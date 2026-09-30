"""OpenView sources and publishers follow the pack's structure and grants."""

from dataclasses import replace
from datetime import date
from uuid import uuid4

import httpx

from operations.sample_client import SampleClient
from operations.sample_openview import _source_plans, populate_openview
from tests.operations.test_sample_actor_access import _restricted_pack
from tests.operations.test_sample_packs import _TINY_PACK


def _tables(pack):
    department_id = str(uuid4())
    departments = {"ops": {"id": department_id, "name": "Operations"}}
    modules, fields = {}, {}
    for module in pack.catalog.modules:
        module_id = str(uuid4())
        modules[module.key] = {"id": module_id, "department_id": department_id}
        fields[module.key] = [
            {
                "id": str(uuid4()),
                "module_id": module_id,
                "name": name,
                "type": kind,
                "position": index,
            }
            for index, (name, kind) in enumerate(
                (("Name", "text"), ("Status", "select"), ("Date", "date"), ("Count", "int"))
            )
        ]
    return departments, modules, fields


def test_a_single_module_department_has_one_report_source():
    pack = replace(
        _TINY_PACK, catalog=replace(_TINY_PACK.catalog, modules=(_TINY_PACK.catalog.modules[0],))
    )
    departments, modules, fields = _tables(pack)
    plans = _source_plans(departments, modules, fields, organization=pack)
    assert [key for key, _module, _fields in plans["ops"]] == ["requests"]


def test_reports_use_module_managers_and_dashboards_use_department_leads(tmp_path):
    import json

    pack = _restricted_pack()
    access = dict(pack.actors.group_access)
    access["clerk-grants"] = (("ops", None, "read"), ("ops", "updates", "manage"))
    pack = replace(
        pack,
        actors=replace(pack.actors, group_access=access),
        content=replace(
            pack.content,
            data=replace(pack.content.data, leads={"ops": "internal_ops_lead"}, layouts=("table",)),
        ),
    )
    departments, modules, fields = _tables(pack)
    writes = []
    report_modules = {}

    def client_for(person):
        def handler(request):
            body = json.loads(request.content) if request.content else {}
            if request.url.path == "/api/auth/login":
                return httpx.Response(
                    200, json={}, headers={"set-cookie": "openslate_csrf=c; Path=/"}
                )
            if request.method == "POST":
                writes.append((person, request.url.path, body.get("module_id")))
            result = {"id": str(uuid4())}
            if request.url.path == "/api/reports":
                report_modules[result["id"]] = body["module_id"]
            if request.url.path.endswith("/schedule"):
                module_id = report_modules[request.url.path.split("/")[-2]]
                expected_manager = (
                    "internal_ops_lead"
                    if module_id == modules["requests"]["id"]
                    else "internal_ops_02"
                )
                assert person == expected_manager
            if request.url.path == "/api/dashboards":
                result["widgets"] = [{"id": str(uuid4())} for _ in range(4)]
            if request.url.path.endswith("/runs"):
                result.update(report_id=request.url.path.split("/")[-2], row_count=2)
            if request.url.path.endswith("/schedule"):
                result.update(report_id=request.url.path.split("/")[-2], enabled=False)
            return httpx.Response(201, json=result)

        client = SampleClient(
            "https://api.example.test",
            "https://ui.example.test",
            tmp_path / f"{person}.jsonl",
            transport=httpx.MockTransport(handler),
        )
        client.login(f"{person}@northside.example", "fixture-value")
        return client

    lead = client_for("internal_ops_lead")
    clerk = client_for("internal_ops_02")
    try:
        counts = populate_openview(
            lead,
            departments=departments,
            modules=modules,
            fields=fields,
            anchor_date=date(2026, 9, 30),
            seed=17,
            writers={"ops": lead},
            organization=pack,
            actor_clients={"internal_ops_lead": lead, "internal_ops_02": clerk},
        )
        assert counts["reports"] == 2
        reports = [(person, module) for person, path, module in writes if path == "/api/reports"]
        assert reports == [
            ("internal_ops_lead", modules["requests"]["id"]),
            ("internal_ops_02", modules["updates"]["id"]),
        ]
        assert [(person, path) for person, path, _ in writes if path == "/api/dashboards"] == [
            ("internal_ops_lead", "/api/dashboards")
        ]
    finally:
        lead.close()
        clerk.close()
