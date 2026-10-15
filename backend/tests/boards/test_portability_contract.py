"""Portable Board configuration rejects live IDs and resolves only active sources."""

import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import func, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.models import Board, BoardWidget
from app.systems.boards.portability import (
    PortabilityError,
    parse_portable_board,
    resolve_portable_board,
)
from app.systems.boards.portability_queries import portable_config
from app.systems.boards.widget_schemas import BoardWidgetConfig
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from tests.boards.portable_chart_support import chart_board, complete_query, reference
from tests.charts.chart_route_support import chart_world as chart_world


def _bundle() -> dict:
    return {
        "kind": "openslate-board",
        "version": 3,
        "configuration": {
            "name": "Operations",
            "description": "Team board",
            "widgets": [
                {
                    "name": "Open requests",
                    "widget_type": "records",
                    "source": {"department_name": "Operations", "module_name": "Requests"},
                    "config": {
                        "fields": [{"name": "Label", "expected_type": "text"}],
                        "filters": [
                            {
                                "name": "Status",
                                "expected_type": "select",
                                "operator": "eq",
                                "value": "Open",
                            }
                        ],
                        "logic": "and",
                        "metric": None,
                        "visualization": "bar",
                        "size": "half",
                        "refresh": "manual",
                        "pinned": False,
                    },
                }
            ],
        },
    }


def _bytes(bundle: dict) -> bytes:
    return json.dumps(bundle).encode()


def _catalog() -> tuple[Department, Module, list[Field]]:
    department = Department(id=uuid7(), department_name="Operations", is_deleted=False)
    module = Module(
        id=uuid7(),
        department_id=department.id,
        module_name="Requests",
        is_deleted=False,
    )
    fields = [
        Field(
            id=uuid7(),
            module_id=module.id,
            name="Label",
            type=FieldType.TEXT,
            is_deleted=False,
            config={},
            position=0,
        ),
        Field(
            id=uuid7(),
            module_id=module.id,
            name="Status",
            type=FieldType.SELECT,
            is_deleted=False,
            config={
                "options": [
                    {"id": str(uuid7()), "label": "Open"},
                    {"id": str(uuid7()), "label": "Closed"},
                ]
            },
            position=1,
        ),
    ]
    return department, module, fields


def _database(departments: list[Department], modules: list[Module], fields: list[Field]) -> Mock:
    db = Mock(spec=Session)
    db.scalars.side_effect = [
        SimpleNamespace(all=lambda: departments),
        SimpleNamespace(all=lambda: modules),
        SimpleNamespace(all=lambda: fields),
    ]
    return db


def test_v3_structure_resolves_exact_active_names_types_without_mutating() -> None:
    department, module, fields = _catalog()
    db = _database([department], [module], fields)

    resolved = resolve_portable_board(db, parse_portable_board(_bytes(_bundle())))

    assert resolved.board.name == "Operations"
    assert resolved.board.description == "Team board"
    assert len(resolved.widgets) == 1
    widget = resolved.widgets[0]
    assert widget.module_id == module.id
    assert widget.config.fields[0].field_id == fields[0].id
    assert widget.config.filters[0].field_id == fields[1].id
    assert widget.config.filters[0].value == fields[1].config["options"][0]["id"]
    statements = [
        str(call.args[0].compile(dialect=postgresql.dialect()))
        for call in db.scalars.call_args_list
    ]
    assert len(statements) == 3
    assert all("FOR UPDATE" in statement for statement in statements)
    # A contended source refuses at once, rows lock in id order, and each locked row is
    # read again after the lock.
    assert all("FOR UPDATE NOWAIT" in statement for statement in statements)
    assert all(
        call.args[0].get_execution_options().get("populate_existing") is True
        for call in db.scalars.call_args_list
    )
    for statement, table in zip(statements, ("departments", "modules", "fields"), strict=True):
        assert f"{table}.is_deleted IS false" in statement
        assert f"{table}.deleted_at IS NULL" in statement
        assert f"ORDER BY {table}.id" in statement
    assert "departments.department_name" in statements[0]
    assert "modules.module_name" in statements[1]
    assert "fields.name" in statements[2]
    assert all("is_deleted" in statement and "deleted_at" in statement for statement in statements)
    db.add.assert_not_called()
    db.flush.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize(
    ("aggregation", "metric_type", "expected"),
    [
        (None, None, "count"),
        (None, "decimal", "sum"),
        ("average", "decimal", "average"),
        ("distinct", "text", "distinct"),
    ],
)
def test_v3_legacy_aggregation_codecs_preserve_meaning_and_named_references(
    aggregation: str | None, metric_type: str | None, expected: str
) -> None:
    department, module, fields = _catalog()
    measure = Field(
        id=uuid7(),
        module_id=module.id,
        name="Measure",
        type=metric_type or "decimal",
        is_deleted=False,
        config={},
        position=2,
    )
    fields.append(measure)
    live = {
        "fields": [{"field_id": fields[0].id, "expected_type": "text"}],
        "filters": [
            {
                "field_id": fields[1].id,
                "expected_type": "select",
                "operator": "eq",
                "value": fields[1].config["options"][0]["id"],
            }
        ],
        "logic": "or",
        "metric": {"field_id": measure.id, "expected_type": metric_type} if metric_type else None,
        "visualization": "pie",
        "refresh": "five-minutes",
    }
    if aggregation is not None:
        live["aggregation"] = aggregation
    config = BoardWidgetConfig.model_validate(live)
    exported = portable_config(config, module.id, {field.id: field for field in fields}, "S", True)
    wanted = {
        "fields": [{"name": "Label", "expected_type": "text"}],
        "filters": [
            {
                "name": "Status",
                "expected_type": "select",
                "operator": "eq",
                "value": "Open",
            }
        ],
        "logic": "or",
        "aggregation": expected,
        "metric": {"name": "Measure", "expected_type": metric_type} if metric_type else None,
        "visualization": "pie",
        "size": "S",
        "refresh": "five-minutes",
        "pinned": True,
    }
    assert exported.model_dump(mode="json") == wanted

    bundle = _bundle()
    bundle["configuration"]["widgets"][0]["config"] = exported.model_dump(mode="json")
    if aggregation is None:
        # Old version-3 files omit this field; import must retain the old projection.
        del bundle["configuration"]["widgets"][0]["config"]["aggregation"]
    db = _database([department], [module], fields)
    resolved = resolve_portable_board(db, parse_portable_board(_bytes(bundle))).widgets[0]

    assert resolved.size == "S" and resolved.pinned is True
    assert resolved.chart_id is None and resolved.module_id == module.id
    assert resolved.config.model_dump(mode="json", exclude={"refresh"}) == config.model_dump(
        mode="json", exclude={"refresh"}
    )
    assert resolved.config.refresh == "manual"
    db.add.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.parametrize(("size", "stored"), [("half", "M"), ("full", "L"), ("S", "S")])
def test_v3_legacy_sizes_map_to_widget_sizes(size: str, stored: str) -> None:
    department, module, fields = _catalog()
    bundle = _bundle()
    bundle["configuration"]["widgets"][0]["config"]["size"] = size

    resolved = resolve_portable_board(
        _database([department], [module], fields), parse_portable_board(_bytes(bundle))
    )

    assert resolved.widgets[0].size == stored


def test_v3_normalized_records_query_resolves_named_columns_to_live_fields() -> None:
    department, module, fields = _catalog()
    bundle = _bundle()
    bundle["configuration"]["widgets"][0]["config"] = {
        "version": 1,
        "size": "M",
        "refresh": "manual",
        "pinned": False,
        "query": {"definition": {"columns": [{"name": "Label", "expected_type": "text"}]}},
    }

    resolved = resolve_portable_board(
        _database([department], [module], fields), parse_portable_board(_bytes(bundle))
    )

    query = resolved.widgets[0].config.query
    assert query.module_id == module.id
    assert [column.field_id for column in query.definition.columns] == [fields[0].id]


@pytest.mark.parametrize(
    ("aggregation", "metric_type"),
    [
        # An explicit null fails the literal check here.
        (None, None),
        # One measure pair proves the bundle sends its metric to the aggregate rule, which
        # tests/record_queries/test_group_aggregate_schemas.py owns pair by pair.
        ("count", "number"),
    ],
)
def test_v3_legacy_aggregation_rejects_invalid_measure_pairs(
    aggregation: str | None, metric_type: str | None
) -> None:
    bundle = _bundle()
    config = bundle["configuration"]["widgets"][0]["config"]
    config["aggregation"] = aggregation
    config["metric"] = {"name": "Measure", "expected_type": metric_type} if metric_type else None

    with pytest.raises(PortabilityError) as error:
        parse_portable_board(_bytes(bundle))
    assert error.value.code == "board_bundle_invalid"


@pytest.mark.parametrize("extra", ["id", "audience", "grants", "files", "placements"])
def test_v3_bundle_rejects_nonportable_widget_data(extra: str) -> None:
    bundle = _bundle()
    bundle["configuration"]["widgets"][0][extra] = str(uuid7())

    with pytest.raises(PortabilityError) as error:
        parse_portable_board(_bytes(bundle))

    assert error.value.code == "board_bundle_invalid"


def test_v3_bundle_rejects_oversize_unknown_version_and_duplicate_keys() -> None:
    with pytest.raises(PortabilityError) as oversized:
        parse_portable_board(b" " * (1024 * 1024 + 1))
    assert oversized.value.code == "board_bundle_too_large"

    bundle = _bundle()
    for retired in (1, 2):
        bundle["version"] = retired
        with pytest.raises(PortabilityError) as version:
            parse_portable_board(_bytes(bundle))
        assert version.value.code == "board_bundle_invalid"

    for scope_field in ("department_name", "default_section", "scope"):
        scoped = _bundle()
        scoped["configuration"][scope_field] = "Operations"
        with pytest.raises(PortabilityError) as scoped_error:
            parse_portable_board(_bytes(scoped))
        assert scoped_error.value.code == "board_bundle_invalid"

    bundle["version"] = 3.0
    with pytest.raises(PortabilityError) as coerced_version:
        parse_portable_board(_bytes(bundle))
    assert coerced_version.value.code == "board_bundle_invalid"

    with pytest.raises(PortabilityError) as duplicate:
        parse_portable_board(b'{"kind":"openslate-board","kind":"openslate-board"}')
    assert duplicate.value.code == "board_bundle_invalid"

    with pytest.raises(PortabilityError) as non_json_number:
        parse_portable_board(_bytes(_bundle()).replace(b'"value": "Open"', b'"value": NaN'))
    assert non_json_number.value.code == "board_bundle_invalid"

    # A complete bundle that repeats one key is refused, not read with the last value.
    repeated = _bytes(_bundle()).replace(
        b'"name": "Operations"', b'"name": "Operations", "name": "Operations"'
    )
    with pytest.raises(PortabilityError) as repeated_key:
        parse_portable_board(repeated)
    assert repeated_key.value.code == "board_bundle_invalid"


def test_v3_bundle_of_exactly_the_size_limit_is_accepted() -> None:
    raw = _bytes(_bundle())
    padded = raw + b" " * (1024 * 1024 - len(raw))

    assert len(padded) == 1024 * 1024
    assert parse_portable_board(padded).configuration.name == "Operations"


@pytest.mark.parametrize(
    ("section", "count"),
    [("widgets", 13), ("fields", 25), ("filters", 9)],
)
def test_v3_bundle_enforces_widget_and_reference_limits(section: str, count: int) -> None:
    bundle = _bundle()
    widget = bundle["configuration"]["widgets"][0]
    if section == "widgets":
        bundle["configuration"]["widgets"] = [deepcopy(widget) for _ in range(count)]
    elif section == "fields":
        widget["config"]["fields"] = [
            {"name": f"Field {index}", "expected_type": "text"} for index in range(count)
        ]
    else:
        widget["config"]["filters"] = [
            deepcopy(widget["config"]["filters"][0]) for _ in range(count)
        ]

    with pytest.raises(PortabilityError) as error:
        parse_portable_board(_bytes(bundle))
    assert error.value.code == "board_bundle_invalid"


def test_v3_resolution_rejects_missing_or_ambiguous_source_without_writes() -> None:
    bundle = parse_portable_board(_bytes(_bundle()))
    department, module, fields = _catalog()
    for db in (
        _database([], [module], fields),
        _database([department, department], [module], fields),
        _database([department], [], fields),
        _database([department], [module, module], fields),
        _database([department], [module], [fields[0]]),
        _database([department], [module], [fields[0], fields[1], fields[1]]),
    ):
        with pytest.raises(PortabilityError) as error:
            resolve_portable_board(db, bundle)
        assert error.value.code == "board_source_unavailable"
        db.add.assert_not_called()
        db.commit.assert_not_called()


def test_v3_resolution_rejects_type_or_filter_value_mismatch() -> None:
    department, module, fields = _catalog()
    bundle = _bundle()
    bundle["configuration"]["widgets"][0]["config"]["fields"][0]["expected_type"] = "date"
    with pytest.raises(PortabilityError) as mismatch:
        resolve_portable_board(
            _database([department], [module], fields), parse_portable_board(_bytes(bundle))
        )
    assert mismatch.value.code == "board_source_unavailable"

    bundle = _bundle()
    bundle["configuration"]["widgets"][0]["config"]["filters"][0]["value"] = "Gone"
    with pytest.raises(PortabilityError) as invalid_filter:
        resolve_portable_board(
            _database([department], [module], fields), parse_portable_board(_bytes(bundle))
        )
    assert invalid_filter.value.code == "board_source_unavailable"


def test_v3_resolution_rejects_closed_department() -> None:
    department, module, fields = _catalog()
    department.is_deleted = True

    with pytest.raises(PortabilityError) as error:
        resolve_portable_board(
            _database([department], [module], fields), parse_portable_board(_bytes(_bundle()))
        )
    assert error.value.code == "board_source_unavailable"


def test_v3_resolution_rejects_closed_module_and_soft_deleted_field() -> None:
    department, module, fields = _catalog()
    module.is_deleted = True
    with pytest.raises(PortabilityError):
        resolve_portable_board(
            _database([department], [module], fields), parse_portable_board(_bytes(_bundle()))
        )
    module.is_deleted = False
    fields[0].is_deleted = True
    with pytest.raises(PortabilityError):
        resolve_portable_board(
            _database([department], [module], fields), parse_portable_board(_bytes(_bundle()))
        )


@pytest.mark.integration
@pytest.mark.parametrize(
    "shape", ["mixed", "module_id", "field_id", "chart_id", "category", "unknown"]
)
def test_normalized_bundle_rejects_mixed_or_typed_id_grammar(chart_world, shape):
    world = chart_world
    query, _, _ = complete_query(world)
    board, _ = chart_board(world, query)
    with world.client("admin") as admin:
        bundle = admin.get(f"/api/boards/{board.id}/configuration").json()
        config = bundle["configuration"]["widgets"][0]["config"]
        if shape == "mixed":
            config["fields"] = []
        elif shape == "module_id":
            config["query"]["module_id"] = str(world.module.id)
        elif shape == "field_id":
            config["query"]["dimension"]["field_id"] = str(world.label.id)
        elif shape == "chart_id":
            config["chart_id"] = str(uuid7())
        elif shape == "category":
            bundle["configuration"]["widgets"][0]["widget_type"] = "records"
        else:
            config["future_option"] = True
        before = [
            world.db.scalar(select(func.count()).select_from(model))
            for model in (Board, BoardWidget, AuditLog)
        ]
        result = admin.post(
            "/api/boards/import",
            content=_bytes(bundle),
            headers={"Content-Type": "application/octet-stream"},
        )
        assert (
            result.status_code == 422 and result.json()["detail"]["code"] == "board_bundle_invalid"
        )
        with Session(world.db.get_bind()) as durable:
            assert [
                durable.scalar(select(func.count()).select_from(model))
                for model in (Board, BoardWidget, AuditLog)
            ] == before


@pytest.mark.integration
@pytest.mark.parametrize("predicate", ["scalar", "list"])
def test_normalized_person_predicates_are_not_portable(chart_world, predicate):
    world = chart_world
    query, _, _ = complete_query(world)
    board, _ = chart_board(world, query)
    with world.client("admin") as admin:
        bundle = admin.get(f"/api/boards/{board.id}/configuration").json()
        filters = bundle["configuration"]["widgets"][0]["config"]["query"]["definition"]["filters"]
        filters[0] = {
            "name": "Person",
            "expected_type": "user",
            "operator": "eq" if predicate == "scalar" else "in",
            "value": str(world.users["manager"].id)
            if predicate == "scalar"
            else [str(world.users["manager"].id)],
        }
        result = admin.post(
            "/api/boards/import",
            content=_bytes(bundle),
            headers={"Content-Type": "application/octet-stream"},
        )
        assert (
            result.status_code == 422 and result.json()["detail"]["code"] == "board_bundle_invalid"
        )
    if predicate == "scalar":
        query["definition"]["filters"][0] = {
            **reference(world.person, "user"),
            "operator": "eq",
            "value": str(world.users["manager"].id),
        }
        other, _ = chart_board(world, query)
        with world.client("reader") as reader:
            result = reader.get(f"/api/boards/{other.id}/configuration")
            assert result.status_code == 422 and str(world.users["manager"].id) not in result.text


@pytest.mark.integration
@pytest.mark.parametrize("failure", ["later_source", "commit"])
def test_normalized_multiwidget_or_commit_failure_is_atomic(chart_world, monkeypatch, failure):
    world = chart_world
    query, _, _ = complete_query(world)
    board, _ = chart_board(world, query)
    with world.client("admin") as admin:
        bundle = admin.get(f"/api/boards/{board.id}/configuration").json()
        if failure == "later_source":
            second = deepcopy(bundle["configuration"]["widgets"][0])
            second["config"]["query"]["dimension"]["name"] = "Missing owned field"
            bundle["configuration"]["widgets"].append(second)
        before = [
            world.db.scalar(select(func.count()).select_from(model))
            for model in (Board, BoardWidget, AuditLog)
        ]
        if failure == "commit":

            def refuse_commit():
                world.db.flush()
                raise OperationalError(
                    "owned injected commit failure", {}, RuntimeError("unavailable")
                )

            monkeypatch.setattr(world.db, "commit", refuse_commit)
        result = admin.post(
            "/api/boards/import",
            content=_bytes(bundle),
            headers={"Content-Type": "application/octet-stream"},
        )
        assert result.status_code == (409 if failure == "later_source" else 503)
        assert result.headers["Cache-Control"] == "private, no-store"
        with Session(world.db.get_bind()) as durable:
            assert [
                durable.scalar(select(func.count()).select_from(model))
                for model in (Board, BoardWidget, AuditLog)
            ] == before
