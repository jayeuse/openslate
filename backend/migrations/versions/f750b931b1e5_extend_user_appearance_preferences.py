"""Extend personal preferences without rewriting existing color modes.

Revision ID: f750b931b1e5
Revises: 32182dce4bf8
Create Date: 2026-10-06 10:21:06.580842
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f750b931b1e5"
down_revision: str | None = "32182dce4bf8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "appearance",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text('\'{"motion": "system", "keyboard_shortcuts": true}\'::jsonb'),
            nullable=False,
        ),
    )
    # Autogenerate omits CHECK changes and this existing-column default.
    op.create_check_constraint(
        "ck_users_appearance",
        "users",
        "CASE WHEN jsonb_typeof(appearance) = 'object' THEN "
        "(appearance ?& ARRAY['motion','keyboard_shortcuts'] AND "
        "appearance - ARRAY['motion','keyboard_shortcuts'] = '{}'::jsonb AND "
        "appearance ->> 'motion' IN ('system','reduce') AND "
        "jsonb_typeof(appearance -> 'keyboard_shortcuts') = 'boolean') IS TRUE "
        "ELSE false END",
    )
    op.drop_constraint("ck_users_theme_preference", "users", type_="check")
    op.create_check_constraint(
        "ck_users_theme_preference", "users", "theme_preference IN ('light','dark','system')"
    )
    op.alter_column("users", "theme_preference", server_default=sa.text("'system'"))


def downgrade() -> None:
    unrepresentable = op.get_bind().scalar(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM users WHERE theme_preference='system' OR "
            'appearance <> \'{"motion": "system", "keyboard_shortcuts": true}\'::jsonb)'
        )
    )
    if unrepresentable:
        raise RuntimeError("Cannot downgrade while users have System or nondefault appearance")
    op.alter_column("users", "theme_preference", server_default=sa.text("'light'"))
    op.drop_constraint("ck_users_theme_preference", "users", type_="check")
    op.create_check_constraint(
        "ck_users_theme_preference", "users", "theme_preference IN ('light','dark')"
    )
    op.drop_constraint("ck_users_appearance", "users", type_="check")
    op.drop_column("users", "appearance")
