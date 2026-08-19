"""Reshape audit logs into entity and before/after columns."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260819_0006"
down_revision: str | None = "20260819_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACTOR_UUID_PATTERN = (
    r"^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


def upgrade() -> None:
    connection = op.get_bind()
    too_long_entity_types = connection.execute(
        sa.text("SELECT table_name FROM audit_logs WHERE length(table_name) > 50")
    ).scalars().all()
    if too_long_entity_types:
        raise RuntimeError(f"Audit entity types exceed 50 characters: {too_long_entity_types!r}")
    too_long_methods = connection.execute(
        sa.text("SELECT request_method FROM audit_logs WHERE length(request_method) > 10")
    ).scalars().all()
    if too_long_methods:
        raise RuntimeError(f"Audit request methods exceed 10 characters: {too_long_methods!r}")
    invalid_actors = connection.execute(
        sa.text(
            """
            SELECT performed_by
            FROM audit_logs
            WHERE performed_by IS NOT NULL
              AND performed_by NOT IN ('anonymous', 'system')
              AND performed_by !~ :pattern
            """
        ),
        {"pattern": ACTOR_UUID_PATTERN},
    ).scalars().all()
    if invalid_actors:
        raise RuntimeError(f"Cannot convert malformed audit actors: {invalid_actors!r}")

    op.drop_index("ix_audit_logs_record", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
    op.add_column(
        "audit_logs",
        sa.Column("performed_by_uuid", postgresql.UUID(as_uuid=True), nullable=True),
    )
    connection.execute(
        sa.text(
            """
            UPDATE audit_logs
            SET performed_by_uuid = CASE
                WHEN performed_by LIKE 'user:%' THEN substring(performed_by FROM 6)::uuid
                ELSE NULL
            END
            """
        )
    )
    connection.execute(
        sa.text(
            """
            UPDATE audit_logs AS entry
            SET performed_by_uuid = NULL
            WHERE performed_by_uuid IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM users AS actor WHERE actor.id = entry.performed_by_uuid
              )
            """
        )
    )
    op.drop_column("audit_logs", "performed_by")
    op.alter_column("audit_logs", "performed_by_uuid", new_column_name="performed_by")
    op.create_foreign_key(
        "fk_audit_logs_performed_by_users",
        "audit_logs",
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
    )

    op.alter_column("audit_logs", "table_name", new_column_name="entity_type")
    op.alter_column(
        "audit_logs",
        "entity_type",
        type_=sa.String(length=50),
        existing_nullable=False,
    )
    op.alter_column("audit_logs", "record_id", new_column_name="entity_id", nullable=True)
    op.add_column(
        "audit_logs",
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "audit_logs",
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    connection.execute(
        sa.text(
            """
            UPDATE audit_logs
            SET before = snapshot -> 'before',
                after = snapshot -> 'after'
            """
        )
    )
    op.drop_column("audit_logs", "snapshot")
    op.alter_column("audit_logs", "action", type_=sa.String(length=50), existing_nullable=False)
    op.alter_column(
        "audit_logs",
        "request_method",
        type_=sa.String(length=10),
        existing_nullable=True,
    )
    op.alter_column("audit_logs", "request_path", type_=sa.Text(), existing_nullable=True)
    op.drop_column("audit_logs", "deleted_at")
    op.drop_column("audit_logs", "is_deleted")
    op.drop_column("audit_logs", "updated_at")

    op.create_index(
        "ix_audit_logs_entity",
        "audit_logs",
        ["entity_type", "entity_id", "created_at"],
    )
    op.create_index("ix_audit_logs_actor", "audit_logs", ["performed_by", "created_at"])
    op.create_index("ix_audit_logs_request", "audit_logs", ["request_id"])


def downgrade() -> None:
    raise NotImplementedError("Restore a database backup to downgrade this forward-only migration.")
