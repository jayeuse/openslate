"""drop redundant indexes

Each dropped index has the same predicate as another index on its table, and its
columns are the first columns of that index, so every read it served can use the other
one (plan findings F10 and F21):

- ``ix_users_email`` and ``ix_users_username`` repeat ``uq_users_email`` and
  ``uq_users_username``.
- ``ix_relationship_edges_active_source`` (field_id, source_record_id WHERE NOT
  is_deleted) leads ``uq_relationship_edges_active``.
- ``ix_comms_schedules_author`` (org_id, author_id) leads
  ``uq_comms_schedules_client_key``; ``ix_record_triggers_module_id`` leads
  ``ix_record_triggers_module``; ``ix_sandbox_publications_document_id`` leads
  ``ix_sandbox_publications_document_created``.

Indexes are dropped and recreated concurrently, outside a transaction, so writes to
their tables are not blocked.

Revision ID: 013f822298e6
Revises: e10810d4789c
Create Date: 2026-10-31 19:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "013f822298e6"
down_revision: str | None = "e10810d4789c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (index, table, columns, partial predicate)
INDEXES: tuple[tuple[str, str, tuple[str, ...], str | None], ...] = (
    ("ix_users_email", "users", ("email",), None),
    ("ix_users_username", "users", ("username",), None),
    (
        "ix_relationship_edges_active_source",
        "relationship_edges",
        ("field_id", "source_record_id"),
        "is_deleted = false",
    ),
    ("ix_comms_schedules_author", "comms_schedules", ("org_id", "author_id"), None),
    ("ix_record_triggers_module_id", "record_triggers", ("module_id",), None),
    ("ix_sandbox_publications_document_id", "sandbox_publications", ("document_id",), None),
)


def upgrade() -> None:
    with op.get_context().autocommit_block():
        for name, table, _columns, _where in INDEXES:
            op.drop_index(name, table_name=table, postgresql_concurrently=True, if_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name, table, columns, where in INDEXES:
            op.create_index(
                name,
                table,
                list(columns),
                unique=False,
                postgresql_where=sa.text(where) if where else None,
                postgresql_concurrently=True,
                if_not_exists=True,
            )
