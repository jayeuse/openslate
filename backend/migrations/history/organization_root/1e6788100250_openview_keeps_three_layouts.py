"""openview keeps three layouts

Revision ID: 1e6788100250
Revises: c3f8d2e6a1b7
Create Date: 2026-10-27 10:30:00.000000

OpenView keeps the Table, Grid and Gallery layouts (BR77, BR78). The upgrade deletes
every saved view whose layout is kanban, calendar or timeline, archived and default
views included, in every organization. A module whose default view goes opens on the
built-in default. No table refers to saved views by foreign key, and audit rows of the
deleted views stay. The upgrade then removes the seven calendar and timeline settings
(date_field_id, timeline_start_field_id, timeline_end_field_id,
timeline_deadline_field_id, timeline_progress_field_id, date_range, scale) from every
remaining view, because the presentation schema refuses unknown keys. A view without
them is not written.

The schema has no column or constraint for these values; the presentation schema in
the application code holds them. So the downgrade changes nothing: it restores the
schema values, not the rows. The deleted views and the removed settings come back only
from a backup.

Caution: do not run this migration on an installation without a backup. The deleted
rows cannot come back without one. Follow infra/supabase/RESTORE.md for the backup step.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "1e6788100250"
down_revision: str | None = "c3f8d2e6a1b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Constants, never client text: the arrays are spelled into the statements.
REMOVED_LAYOUTS = "ARRAY['kanban', 'calendar', 'timeline']"
REMOVED_KEYS = (
    "ARRAY['date_field_id', 'timeline_start_field_id', 'timeline_end_field_id', "
    "'timeline_deadline_field_id', 'timeline_progress_field_id', 'date_range', 'scale']"
)


def upgrade() -> None:
    op.execute(
        f"DELETE FROM public.saved_views WHERE presentation->>'layout' = ANY({REMOVED_LAYOUTS})"
    )
    op.execute(
        f"UPDATE public.saved_views SET presentation = presentation - {REMOVED_KEYS} "
        f"WHERE presentation ?| {REMOVED_KEYS}"
    )


def downgrade() -> None:
    pass
