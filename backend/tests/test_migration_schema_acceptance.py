import ast
import re
from pathlib import Path

MIGRATIONS = Path(__file__).parents[1] / "migrations" / "versions"


def _migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_0012_*.py"))
    assert len(matches) == 1
    return matches[0]


def test_schema_acceptance_migration_is_after_relationship_head() -> None:
    tree = ast.parse(_migration_path().read_text(encoding="utf-8"))
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in {"revision", "down_revision"}:
                values[target.id] = ast.literal_eval(node.value)

    assert values == {"revision": "20260819_0012", "down_revision": "20260819_0011"}


def test_schema_acceptance_migration_adds_nonnull_false_default() -> None:
    source = re.sub(r"\s+", " ", _migration_path().read_text(encoding="utf-8")).casefold()

    assert re.search(r"op\.add_column\( ['\"]modules['\"].{0,300}"
                     r"['\"]is_schema_accepted['\"]", source)
    assert (
        "server_default=sa.text(\"false\")" in source
        or "server_default=sa.text('false')" in source
    )
    assert "nullable=false" in source
