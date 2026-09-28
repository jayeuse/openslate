"""Portable Board configuration rejects live IDs and resolves only active sources."""

import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.portability import (
    PortabilityError,
    parse_portable_board,
    resolve_portable_board,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module


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
    assert "departments.department_name" in statements[0]
    assert "modules.module_name" in statements[1]
    assert "fields.name" in statements[2]
    assert all("is_deleted" in statement and "deleted_at" in statement for statement in statements)
    db.add.assert_not_called()
    db.flush.assert_not_called()
    db.commit.assert_not_called()


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
