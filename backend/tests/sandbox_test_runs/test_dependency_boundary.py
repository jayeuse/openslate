"""Guard the temporary-input path against operational item persistence."""

from __future__ import annotations

import ast
from pathlib import Path


def test_temporary_input_evaluator_and_service_do_not_import_operational_item_models() -> None:
    package = Path(__file__).parents[2] / "app" / "systems" / "sandbox" / "test_runs"
    for name in ("evaluator.py", "service.py", "relationships.py"):
        tree = ast.parse((package / name).read_text())
        imported = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        assert "Record" not in imported
        assert "RelationshipEdge" not in imported
