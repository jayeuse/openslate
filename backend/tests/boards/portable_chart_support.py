"""Literal owned portability fixtures; no production conversion builds expectations."""

import pytest
from sqlalchemy import text
from uuid6 import uuid7

from app.core.database.session import AuditSession
from app.systems.access.policy.models import GroupAccess
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.charts.widget_reference_support import ReferenceRaceWorld, managed_board
from tests.rbac.support import add_department, add_module, make_group_access


def reference(field, kind):
    return {"field_id": str(field.id), "expected_type": kind}


def complete_query(world):
    option_ids = [str(uuid7()), str(uuid7())]
    selected = Field(
        module_id=world.module.id,
        name="Status",
        type=FieldType.SELECT,
        position=4,
        config={
            "options": [
                {"id": option_ids[0], "label": "Open"},
                {"id": option_ids[1], "label": "Closed"},
            ]
        },
    )
    world.db.add(selected)
    world.db.commit()
    query = {
        "module_id": str(world.module.id),
        "mode": "groups",
        "dimension": reference(world.label, "text"),
        "aggregation": "average",
        "measure": reference(world.amount, "number"),
        "date_field": reference(world.date, "date"),
        "from_date": "2025-01-01",
        "to_date": "2025-02-28",
        "definition": {
            "version": 1,
            "columns": [reference(world.label, "text"), reference(world.person, "user")],
            "filters": [
                {**reference(selected, "select"), "operator": "in", "value": option_ids}
                for _ in range(9)
            ],
            "logic": "or",
            "sort": [{**reference(world.amount, "number"), "direction": "desc"}],
            "search_fields": [reference(world.label, "text")],
            "deleted": "include",
            "search": "owned canary",
        },
    }
    return query, selected, option_ids


def family_query(world, family):
    query, selected, options = complete_query(world)
    query["definition"]["filters"].append(
        {**reference(world.person, "user"), "operator": "empty", "value": None}
    )
    if family == "records":
        return (
            {"module_id": query["module_id"], "definition": query["definition"]},
            selected,
            options,
        )
    if family in {"day", "week", "month", "quarter", "year"}:
        query.pop("dimension")
        query.update(mode="date_series", bucket=family)
        windows = {
            "day": ("2025-01-01", "2025-02-28"),
            "week": ("2020-01-01", "2023-12-31"),
            "month": ("2000-01-01", "2029-12-31"),
            "quarter": ("2000-01-01", "2029-12-31"),
            "year": ("1900-01-01", "2100-12-31"),
        }
        query["from_date"], query["to_date"] = windows[family]
    else:
        query["aggregation"] = family
        if family == "count":
            query["measure"] = None
        elif family == "distinct":
            query["measure"] = reference(world.label, "text")
    return query, selected, options


def chart_board(world, query, kind="bar", size="S", pinned=True):
    board = managed_board(world, "reader", "stranger")
    with world.client("manager") as owner:
        created = owner.post("/api/charts", json=world.body(query=query, kind=kind))
        assert created.status_code == 201, created.text
        chart = created.json()
    category = "chart" if kind in {"bar", "line", "pie"} else kind
    with world.client("reader") as reader:
        attached = reader.post(
            f"/api/boards/{board.id}/widgets",
            json={
                "revision": 1,
                "widget": {
                    "name": "Portable reference",
                    "widget_type": category,
                    "module_id": str(world.module.id),
                    "chart_id": chart["id"],
                    "config": None,
                    "size": size,
                    "pinned": pinned,
                },
            },
        )
        assert attached.status_code == 201, attached.text
    return board, chart


def alternate_source(world):
    db = world.db
    original = db.get(Department, world.module.department_id)
    name = original.department_name
    original.department_name = "Retained source " + uuid7().hex
    department = add_department(db, name)
    module = add_module(db, department, world.module.module_name)
    options = [str(uuid7()), str(uuid7())]
    fields = {}
    for position, (label, kind) in enumerate(
        [
            ("Label", FieldType.TEXT),
            ("Amount", FieldType.NUMBER),
            ("Date", FieldType.DATE),
            ("Person", FieldType.USER),
            ("Status", FieldType.SELECT),
        ]
    ):
        config = (
            {
                "options": [
                    {"id": options[0], "label": "Open"},
                    {"id": options[1], "label": "Closed"},
                ]
            }
            if kind == FieldType.SELECT
            else {}
        )
        field = Field(module_id=module.id, name=label, type=kind, position=position, config=config)
        db.add(field)
        fields[label] = field
    db.commit()
    return module, fields, options


def multi_source_board(world):
    db = world.db
    board = managed_board(world, "reader")
    sources = []
    for department_index in range(2):
        department = add_department(db, "Portable multiple " + uuid7().hex)
        make_group_access(db, [world.users["reader"]], department, level="read")
        for name in ("Alpha", "Beta"):
            module = add_module(db, department, name)
            label = Field(
                module_id=module.id, name="Label", type=FieldType.TEXT, position=0, config={}
            )
            amount = Field(
                module_id=module.id, name="Amount", type=FieldType.NUMBER, position=1, config={}
            )
            db.add_all([label, amount])
            db.flush()
            if (department_index, name) in {(0, "Alpha"), (1, "Beta")}:
                sources.append((department, module, label, amount))
    db.commit()
    first, second = sources
    with world.client("reader") as reader:
        legacy = reader.post(
            f"/api/boards/{board.id}/widgets",
            json={
                "revision": 1,
                "widget": {
                    "name": "Legacy selected",
                    "widget_type": "records",
                    "module_id": str(first[1].id),
                    "size": "M",
                    "pinned": False,
                    "config": {"fields": [reference(first[2], "text")], "filters": []},
                },
            },
        )
        assert legacy.status_code == 201, legacy.text
        normalized = reader.post(
            f"/api/boards/{board.id}/widgets",
            json={
                "revision": 2,
                "widget": {
                    "name": "Normalized selected",
                    "widget_type": "summary",
                    "module_id": str(second[1].id),
                    "size": "L",
                    "pinned": True,
                    "config": {
                        "version": 1,
                        "query": {
                            "module_id": str(second[1].id),
                            "mode": "groups",
                            "definition": {},
                            "dimension": reference(second[3], "number"),
                            "aggregation": "sum",
                            "measure": reference(second[3], "number"),
                        },
                    },
                },
            },
        )
        assert normalized.status_code == 201, normalized.text
    return board, sources


@pytest.fixture
def portable_race_world():
    """One guarded runtime/owner graph, with exact extra source/copy cleanup."""
    world = ReferenceRaceWorld()
    world.extra_module_ids, world.extra_field_ids, world.extra_access_ids = [], [], []
    world.copied_board_ids = []
    try:
        yield world
    finally:
        with world.owner.begin() as connection:
            ids = [
                *world.extra_module_ids,
                *world.extra_field_ids,
                *world.extra_access_ids,
                *world.copied_board_ids,
            ]
            connection.execute(
                text(
                    "DELETE FROM public.audit_logs WHERE performed_by = ANY(:actors) "
                    "OR entity_id = ANY(:ids)"
                ),
                {"actors": list(world.actors.values()), "ids": ids},
            )
            for table, column, keys in (
                ("board_widgets", "board_id", [world.board_id, *world.copied_board_ids]),
                ("boards", "id", world.copied_board_ids),
                ("fields", "id", world.extra_field_ids),
                ("modules", "id", world.extra_module_ids),
                ("group_access", "id", world.extra_access_ids),
            ):
                if keys:
                    connection.execute(
                        text(f"DELETE FROM public.{table} WHERE {column} = ANY(:ids)"),
                        {"ids": keys},
                    )
        world.cleanup()


def prepare_cross_pair_board(world):
    with AuditSession(world.owner) as db:
        db.get(Module, world.module_id).module_name = "Alpha"
        access = GroupAccess(
            group_id=world.group_id, department_id=world.other_department_id, level="read"
        )
        db.add(access)
        db.flush()
        world.extra_access_ids.append(access.id)
        selected_module = None
        for department_id, name in [
            (world.department_id, "Beta"),
            (world.other_department_id, "Alpha"),
            (world.other_department_id, "Beta"),
        ]:
            module = Module(department_id=department_id, module_name=name)
            db.add(module)
            db.flush()
            world.extra_module_ids.append(module.id)
            if department_id == world.department_id:
                world.unselected_module_id = module.id
            if (department_id, name) == (world.other_department_id, "Beta"):
                selected_module = module
                for position, (label, kind) in enumerate(
                    [("Label", FieldType.TEXT), ("Amount", FieldType.NUMBER)]
                ):
                    field = Field(
                        module_id=module.id, name=label, type=kind, position=position, config={}
                    )
                    db.add(field)
                    db.flush()
                    world.extra_field_ids.append(field.id)
                    if label == "Amount":
                        selected_field = field
        extra = Field(
            module_id=world.module_id, name="Amount", type=FieldType.NUMBER, position=1, config={}
        )
        db.add(extra)
        db.flush()
        world.extra_field_ids.append(extra.id)
        world.unselected_field_id = extra.id
        selected_module_id, selected_field_id = selected_module.id, selected_field.id
        db.commit()
    with world.client() as member:
        first = member.post(
            f"/api/boards/{world.board_id}/widgets",
            json={
                "revision": 1,
                "widget": {
                    "name": "First selected pair",
                    "widget_type": "records",
                    "module_id": str(world.module_id),
                    "config": {
                        "fields": [{"field_id": str(world.field_id), "expected_type": "text"}]
                    },
                },
            },
        )
        assert first.status_code == 201, first.text
        second = member.post(
            f"/api/boards/{world.board_id}/widgets",
            json={
                "revision": 2,
                "widget": {
                    "name": "Second selected pair",
                    "widget_type": "summary",
                    "module_id": str(selected_module_id),
                    "config": {
                        "query": {
                            "module_id": str(selected_module_id),
                            "definition": {},
                            "mode": "groups",
                            "dimension": {
                                "field_id": str(selected_field_id),
                                "expected_type": "number",
                            },
                            "aggregation": "sum",
                            "measure": {
                                "field_id": str(selected_field_id),
                                "expected_type": "number",
                            },
                        }
                    },
                },
            },
        )
        assert second.status_code == 201, second.text
