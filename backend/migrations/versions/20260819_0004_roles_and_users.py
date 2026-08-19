"""Replace scalar user roles with role entities and UUID actors."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

revision: str = "20260819_0004"
down_revision: str | None = "20260819_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACTOR_UUID_PATTERN = (
    r"^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F][0-9a-fA-F]{3}-"
    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)


def upgrade() -> None:
    connection = op.get_bind()

    invalid_actors = connection.execute(
        sa.text(
            """
            SELECT performed_by
            FROM users
            WHERE performed_by IS NOT NULL
              AND performed_by NOT IN ('anonymous', 'system')
              AND performed_by !~ :pattern
            """
        ),
        {"pattern": ACTOR_UUID_PATTERN},
    ).scalars().all()
    if invalid_actors:
        raise RuntimeError(f"Cannot convert malformed user actors: {invalid_actors!r}")

    op.add_column(
        "users",
        sa.Column("performed_by_uuid", postgresql.UUID(as_uuid=True), nullable=True),
    )
    connection.execute(
        sa.text(
            """
            UPDATE users
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
            UPDATE users AS target
            SET performed_by_uuid = NULL
            WHERE performed_by_uuid IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM users AS actor WHERE actor.id = target.performed_by_uuid
              )
            """
        )
    )
    op.drop_column("users", "performed_by")
    op.alter_column("users", "performed_by_uuid", new_column_name="performed_by")
    op.create_foreign_key(
        "fk_users_performed_by_users",
        "users",
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "performed_by",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column("role", sa.String(length=100), nullable=False),
        sa.Column(
            "permissions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("role", name="uq_roles_role"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name="fk_roles_performed_by_users",
            ondelete="SET NULL",
        ),
    )

    existing_roles = connection.execute(sa.text("SELECT DISTINCT role FROM users")).scalars().all()
    role_ids: dict[str, object] = {}
    for role_name in existing_roles:
        if len(role_name) > 100:
            raise RuntimeError(f"Role name exceeds 100 characters: {role_name!r}")
        role_id = uuid7()
        role_ids[role_name] = role_id
        connection.execute(
            sa.text(
                "INSERT INTO roles (id, role, permissions) VALUES (:id, :role, '{}'::jsonb)"
            ),
            {"id": role_id, "role": role_name},
        )
    for role_name in ("admin", "member"):
        if role_name not in role_ids:
            role_id = uuid7()
            role_ids[role_name] = role_id
            connection.execute(
                sa.text(
                    "INSERT INTO roles (id, role, permissions) VALUES (:id, :role, '{}'::jsonb)"
                ),
                {"id": role_id, "role": role_name},
            )

    op.add_column(
        "users",
        sa.Column("role_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    for role_name, role_id in role_ids.items():
        connection.execute(
            sa.text("UPDATE users SET role_id = :role_id WHERE role = :role"),
            {"role_id": role_id, "role": role_name},
        )
    op.alter_column("users", "role_id", nullable=False)
    op.create_foreign_key(
        "fk_users_role_id_roles",
        "users",
        "roles",
        ["role_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_users_role_id", "users", ["role_id"])

    connection.execute(
        sa.text(
            """
            UPDATE users
            SET is_deleted = true,
                deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
            WHERE is_active = false
            """
        )
    )
    op.alter_column("users", "username", type_=sa.String(length=100), existing_nullable=False)
    # The original unnamed constraint can receive either name depending on the
    # metadata naming convention active when revision 0001 was applied.
    connection.execute(
        sa.text("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key")
    )
    connection.execute(sa.text("ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_username"))
    op.create_unique_constraint("uq_users_username", "users", ["username"])
    op.alter_column("users", "password_hash", type_=sa.Text(), existing_nullable=False)
    op.drop_index("ix_users_preferences_gin", table_name="users", postgresql_using="gin")
    op.drop_column("users", "preferences")
    op.drop_column("users", "is_active")
    op.drop_column("users", "role")


def downgrade() -> None:
    raise NotImplementedError("Restore a database backup to downgrade this forward-only migration.")
