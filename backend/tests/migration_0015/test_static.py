import ast
import re
from pathlib import Path

from scripts.seed_sample_data import FIELD_SPECS, RECORD_SPECS

MIGRATIONS = Path(__file__).parents[2] / "migrations" / "versions"
CANONICAL_DECIMAL = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?$")


def _migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_0015_*.py"))
    assert len(matches) == 1
    return matches[0]


def _source() -> str:
    return re.sub(r"\s+", " ", _migration_path().read_text(encoding="utf-8")).casefold()


def _revision_values() -> dict[str, object]:
    tree = ast.parse(_migration_path().read_text(encoding="utf-8"))
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}:
                values[target.id] = ast.literal_eval(node.value)
    return values


def _assert_canonical_decimal(value: object) -> None:
    assert isinstance(value, str)
    assert CANONICAL_DECIMAL.fullmatch(value)
    assert value != "-0"
    if "." in value:
        integer_part, fractional_part = value.split(".", 1)
        assert not fractional_part.endswith("0")
    else:
        integer_part = value
    assert len(integer_part.removeprefix("-")) <= 38
    assert "." not in value or len(fractional_part) <= 18


def test_decimal_migration_is_chained_after_relationship_purge() -> None:
    assert _revision_values() == {
        "revision": "20260831_0015",
        "down_revision": "20260830_0014",
    }


def test_decimal_migration_covers_decimal_fields_and_records_without_lifecycle_filters() -> None:
    source = _source()

    assert "update public.fields" in source
    assert "update public.records" in source
    assert "f.type = 'decimal'" in source
    assert "jsonb_each" in source
    assert "jsonb_typeof" in source
    assert "::numeric" in source
    assert "to_jsonb" in source
    assert "trim_scale" in source
    assert "exceeds canonical precision or scale" in source
    assert "raise exception" in source
    assert "is_deleted = false" not in source
    assert "is_deleted = true" not in source


def test_decimal_migration_downgrade_converts_only_valid_canonical_strings() -> None:
    source = _source()

    assert "openslate_canonical_text_to_decimal" in source
    assert "decimal string is not canonical" in source
    assert "jsonb_typeof(f.config -> 'minimum') not in ('string', 'null')" in source
    assert "jsonb_typeof(r.data -> f.id::text) not in ('string', 'null')" in source


def test_sample_seed_uses_canonical_strings_for_every_decimal_producer() -> None:
    field_types = {spec[0]: spec[3] for spec in FIELD_SPECS}

    for _logical_id, _module_id, _name, field_type, _required, _position, config in FIELD_SPECS:
        if field_type == "decimal":
            for bound_name in ("minimum", "maximum"):
                if bound_name in config:
                    _assert_canonical_decimal(config[bound_name])

    for _logical_id, _module_id, data in RECORD_SPECS:
        for field_id, value in data.items():
            if field_types.get(field_id) == "decimal":
                _assert_canonical_decimal(value)

