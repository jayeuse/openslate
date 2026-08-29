import re
from pathlib import Path

MIGRATIONS = Path(__file__).parents[1] / "migrations" / "versions"


def _source() -> str:
    matches = sorted(MIGRATIONS.glob("*_0014_*.py"))
    assert len(matches) == 1
    return re.sub(r"\s+", " ", matches[0].read_text(encoding="utf-8")).casefold()



def test_relationship_edge_purge_migration_grants_only_runtime_delete_and_rls_policy() -> None:
    source = _source()

    assert "revision = \"20260830_0014\"" in source
    assert "down_revision = \"20260829_0013\"" in source
    assert re.search(
        r"grant\s+delete\s+on\s+table\s+public\.relationship_edges\s+to\s+openslate_app",
        source,
    )
    assert re.search(
        r"create\s+policy\s+openslate_app_relationship_edges_delete\s+on\s+public\.relationship_edges",
        source,
    )
    assert re.search(r"for\s+delete\s+to\s+openslate_app\s+using\s*\(true\)", source)
    assert re.search(
        r"revoke\s+delete\s+on\s+table\s+public\.relationship_edges\s+from\s+openslate_app",
        source,
    )
