"""Merge Access and Boards/OpenView migration histories.

Revision ID: 997ba6cad7ac
Revises: 2bf95b237416, 7b005128820a
Create Date: 2026-09-24 15:20:27.939679
"""
from collections.abc import Sequence

revision: str = "997ba6cad7ac"
down_revision: tuple[str, str] = ("2bf95b237416", "7b005128820a")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
