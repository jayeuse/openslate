import ast
import re
from pathlib import Path

MIGRATIONS = Path(__file__).parents[1] / "migrations" / "versions"


def _migration_path() -> Path:
    matches = sorted(MIGRATIONS.glob("*_0013_*.py"))
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


def test_lifecycle_migration_is_chained_after_schema_acceptance() -> None:
    assert _revision_values() == {
        "revision": "20260829_0013",
        "down_revision": "20260819_0012",
    }


def test_lifecycle_migration_adds_audit_metadata_and_foundation_tables() -> None:
    source = _source()

    for column in ("actor_label", "note"):
        assert re.search(
            rf"op\.add_column\( ['\"]audit_logs['\"].{{0,300}}['\"]{column}['\"]",
            source,
        )
    for table in (
        "lifecycle_confirmation_challenges",
        "lifecycle_rate_limit_buckets",
        "lifecycle_rate_limit_failures",
    ):
        assert f"op.create_table( \"{table}\"" in source or f"op.create_table('{table}'" in source
    for column in (
        "actor_id",
        "operation",
        "target_type",
        "target_id",
        "impact_digest",
        "token_hash",
        "failed_attempts",
        "status",
        "expires_at",
        "window_started_at",
        "window_expires_at",
        "blocked_until",
    ):
        assert f"\"{column}\"" in source or f"'{column}'" in source


def test_lifecycle_migration_uses_approved_statuses_and_rolling_window() -> None:
    source = _source()

    for status in ("pending", "verifying", "consumed", "expired", "invalidated", "exhausted"):
        assert status in source
    for rejected_status in ("confirmed", "failed", "cancelled"):
        assert f"'{rejected_status}'" not in source
    assert "token_hash" in source and "unique=true" in source
    assert "account_id" not in source
    assert "actor_id" in source
    assert "window_expires_at <=" in source
    assert "window_started_at + interval '15 minutes'" in source
    assert "blocked_until" in source
    assert "failed_attempts >= 0 and failed_attempts <= 5" in source
    assert "attempt_count >= 0 and attempt_count <= 5" in source


def test_lifecycle_migration_reclassifies_all_existing_closed_domain_rows() -> None:
    source = _source()

    for table in ("departments", "modules", "fields"):
        assert re.search(rf"from\s+{table}\s+where\s+is_deleted\s*=\s*true", source)
    assert "gen_random_uuid()" in source
    assert "system_migration" in source
    assert "reclassified as closed on rollout; prior closure history unknown" in source
    assert re.search(r"performed_by\s*,.{0,200}null", source)
    assert "insert into users" not in source


def test_lifecycle_migration_grants_runtime_role_permissions_without_edge_delete() -> None:
    source = _source()

    for table in (
        "lifecycle_confirmation_challenges",
        "lifecycle_rate_limit_buckets",
        "lifecycle_rate_limit_failures",
    ):
        assert re.search(
            rf"grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+table\s+"
            rf"public\.{table}\s+to\s+openslate_app",
            source,
        )
    assert not re.search(r"grant\s+[^;]*delete[^;]*relationship_edges", source)
