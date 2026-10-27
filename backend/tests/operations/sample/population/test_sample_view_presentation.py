"""Every saved-view layout points only at fields the view's query shows."""

from __future__ import annotations

from typing import Any
from uuid import NAMESPACE_URL, uuid5

import pytest

from operations.sample.packs.registry import get_pack
from operations.sample.population.openview import _definition, _view_presentation

# Catalog field types as the fields API reports them.
API_TYPES = {
    "Text": "text",
    "Long text": "long_text",
    "Number": "number",
    "Integer": "int",
    "Date": "date",
    "Date/Time": "datetime",
    "Checkbox": "boolean",
    "Select": "select",
    "Email": "email",
    "URL": "url",
    "User": "user",
}
PRESENTATION_FIELDS = (
    "primary_field_id",
    "secondary_field_id",
    "group_by_field_id",
)


def _api_fields(pack_key: str, module: Any) -> list[dict[str, Any]]:
    return [
        {
            "id": str(uuid5(NAMESPACE_URL, f"{pack_key}:{module.key}:{field.key}")),
            "name": field.name,
            "type": API_TYPES[field.type],
            "position": position,
        }
        for position, field in enumerate(module.fields)
    ]


@pytest.mark.parametrize("pack_key", ["harbor", "school"])
def test_layout_fields_are_query_columns_for_every_module(pack_key: str) -> None:
    pack = get_pack(pack_key)
    problems = []
    for module in pack.catalog.modules:
        fields = _api_fields(pack_key, module)
        columns = {column["field_id"] for column in _definition(fields)["columns"]}
        for layout in pack.content.data.layouts:
            presentation = _view_presentation(layout, fields)
            used = {presentation[name] for name in PRESENTATION_FIELDS} - {None}
            used |= set(presentation["column_field_ids"]) | set(presentation["pinned_field_ids"])
            if not used <= columns:
                problems.append(f"{module.key}:{layout}")
    assert problems == []


@pytest.mark.parametrize("pack_key", ["harbor", "school"])
def test_table_views_group_by_the_status_field_the_old_kanban_view_used(pack_key: str) -> None:
    pack = get_pack(pack_key)
    for module in pack.catalog.modules:
        fields = _api_fields(pack_key, module)
        status = str(uuid5(NAMESPACE_URL, f"{pack_key}:{module.key}:status"))
        grouping = {
            layout: _view_presentation(layout, fields)["group_by_field_id"]
            for layout in pack.content.data.layouts
        }
        assert grouping == {"table": status, "grid": None, "gallery": None}, module.key
