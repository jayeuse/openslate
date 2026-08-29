"""Allow the application role to physically purge relationship edges."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision = "20260830_0014"
down_revision = "20260829_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            GRANT DELETE ON TABLE public.relationship_edges TO openslate_app;
            DROP POLICY IF EXISTS openslate_app_relationship_edges_delete
                ON public.relationship_edges;
            CREATE POLICY openslate_app_relationship_edges_delete
                ON public.relationship_edges AS PERMISSIVE FOR DELETE
                TO openslate_app USING (true);
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DROP POLICY IF EXISTS openslate_app_relationship_edges_delete
                ON public.relationship_edges;
            REVOKE DELETE ON TABLE public.relationship_edges FROM openslate_app;
            """
        )
    )
