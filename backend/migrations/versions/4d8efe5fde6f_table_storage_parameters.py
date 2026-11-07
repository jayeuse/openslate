"""table storage parameters

Per-table autovacuum for the tables that churn most, and room for new row versions on
`records` (plan findings F12 and F18). `ALTER TABLE ... SET` takes SHARE UPDATE EXCLUSIVE,
so reads and writes continue, and nothing is rewritten: only new and rewritten pages keep
the free space. Alembic does not compare storage parameters, so
`tests/migrations/test_table_storage_parameters.py` owns them.

Revision ID: 4d8efe5fde6f
Revises: cf8cb7605f48
Create Date: 2026-11-07 09:53:50.923005
"""
from collections.abc import Sequence

from alembic import op

revision: str = "4d8efe5fde6f"
down_revision: str | None = "cf8cb7605f48"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

AUTOVACUUM = {
    "autovacuum_vacuum_scale_factor": "0.02",
    "autovacuum_analyze_scale_factor": "0.01",
}
INSERT_AUTOVACUUM = {**AUTOVACUUM, "autovacuum_vacuum_insert_scale_factor": "0.02"}
PARAMETERS = {
    "record_trigger_events": INSERT_AUTOVACUUM,
    "in_app_notifications": INSERT_AUTOVACUUM,
    "relationship_edges": AUTOVACUUM,
    "records": {**AUTOVACUUM, "fillfactor": "90"},
}


def upgrade() -> None:
    for table, parameters in PARAMETERS.items():
        values = ", ".join(f"{name} = {value}" for name, value in parameters.items())
        op.execute(f"ALTER TABLE {table} SET ({values})")


def downgrade() -> None:
    for table, parameters in PARAMETERS.items():
        op.execute(f"ALTER TABLE {table} RESET ({', '.join(parameters)})")
