import ast
import re
from pathlib import Path

MIGRATIONS = Path(__file__).parents[1] / "migrations" / "versions"


def _migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_0011_*.py"))
    assert matches, "The relationship migration is not implemented"
    assert len(matches) == 1, "The relationship migration must have one file"
    return matches[0]


def _source() -> str:
    return re.sub(r"\s+", " ", _migration_path().read_text(encoding="utf-8")).casefold()


def _revision_values() -> dict[str, object]:
    tree = ast.parse(_migration_path().read_text(encoding="utf-8"))
    values: dict[str, object] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}:
            values[target.id] = ast.literal_eval(node.value)
    return values


def test_relationship_migration_is_chained_after_0010() -> None:
    values = _revision_values()

    assert str(values["revision"]).endswith("_0011")
    assert values["down_revision"] == "20260819_0010"


def test_relationship_migration_adds_metadata_and_edge_constraints() -> None:
    source = _source()

    for column in (
        "relationship_target_module_id",
        "relationship_multiple_targets",
        "relationship_multiple_sources",
    ):
        assert re.search(
            rf"op\.add_column\( ['\"]fields['\"].{{0,250}}['\"]{column}['\"]",
            source,
        )

    assert re.search(r"op\.create_table\( ['\"]relationship_edges['\"]", source)
    for column in ("field_id", "source_record_id", "target_record_id"):
        assert re.search(rf"['\"]{column}['\"]", source)


def test_relationship_migration_enforces_active_duplicate_and_self_link_rules() -> None:
    source = _source()

    assert "is_deleted = false" in source
    assert "source_record_id <> target_record_id" in source
    assert "unique" in source
