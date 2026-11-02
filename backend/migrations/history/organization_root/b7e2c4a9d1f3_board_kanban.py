"""board kanban

Revision ID: b7e2c4a9d1f3
Revises: 4e015d0fb2ab
Create Date: 2026-10-26 20:00:00.000000

Each Board gets its own Kanban: stages and labels (managers), cards that are
objectives or record cards (writers), card labels and checklist items. Every new
table is organization-scoped with the standard row policy. Board attachments and
record links gain a third owner, a card, and their content guards learn it. The
downgrade drops the Kanban tables
with their rows and deletes card-owned attachment and record-link rows; only a
backup restores them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7e2c4a9d1f3"
down_revision: str | None = "4e015d0fb2ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCOPE = "(SELECT nullif(current_setting('openslate.org_id', true), '')::uuid)"
TABLES = (
    "board_stages",
    "board_labels",
    "board_cards",
    "board_card_labels",
    "board_card_checklist_items",
)
TWO_OWNERS = (
    "(event_id IS NOT NULL AND post_id IS NULL) OR (event_id IS NULL AND post_id IS NOT NULL)"
)
THREE_OWNERS = "num_nonnulls(event_id, post_id, card_id) = 1"


def _guards(card: bool) -> tuple[str, ...]:
    """The Board content guards; with ``card`` they also know a card owner."""

    card_immutable = "OLD.card_id IS DISTINCT FROM NEW.card_id OR" if card else ""
    card_owner = (
        "ELSIF NEW.card_id IS NOT NULL THEN SELECT board_id INTO {target} "
        "FROM public.board_cards WHERE org_id = NEW.org_id AND id = NEW.card_id;"
        if card
        else ""
    )
    return (
        f"""
        CREATE OR REPLACE FUNCTION public.board_record_link_guard() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        DECLARE owner_board uuid; source_module uuid;
        BEGIN
            IF TG_OP = 'UPDATE' AND (
                OLD.org_id IS DISTINCT FROM NEW.org_id OR
                OLD.board_id IS DISTINCT FROM NEW.board_id OR
                OLD.event_id IS DISTINCT FROM NEW.event_id OR
                OLD.post_id IS DISTINCT FROM NEW.post_id OR {card_immutable}
                OLD.record_id IS DISTINCT FROM NEW.record_id OR
                OLD.module_id IS DISTINCT FROM NEW.module_id
            ) THEN
                RAISE EXCEPTION 'Board Record link owner is immutable' USING ERRCODE = '23514';
            END IF;
            IF NEW.event_id IS NOT NULL THEN
                SELECT board_id INTO owner_board FROM public.board_events
                WHERE org_id = NEW.org_id AND id = NEW.event_id;
            {card_owner.format(target="owner_board")}
            ELSE
                SELECT board_id INTO owner_board FROM public.board_posts
                WHERE org_id = NEW.org_id AND id = NEW.post_id;
            END IF;
            SELECT module_id INTO source_module FROM public.records
            WHERE org_id = NEW.org_id AND id = NEW.record_id;
            IF owner_board IS DISTINCT FROM NEW.board_id OR
               source_module IS DISTINCT FROM NEW.module_id THEN
                RAISE EXCEPTION 'Board Record link parent mismatch' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $guard$;
        """,
        f"""
        CREATE OR REPLACE FUNCTION public.reject_board_attachment_owner_change()
        RETURNS trigger LANGUAGE plpgsql AS $guard$
        BEGIN
            IF OLD.org_id IS DISTINCT FROM NEW.org_id
                OR OLD.board_id IS DISTINCT FROM NEW.board_id
                OR OLD.file_id IS DISTINCT FROM NEW.file_id
                OR {card_immutable}
                OLD.event_id IS DISTINCT FROM NEW.event_id
                OR OLD.post_id IS DISTINCT FROM NEW.post_id THEN
                RAISE EXCEPTION 'board file content owner is immutable'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $guard$;
        """,
        f"""
        CREATE OR REPLACE FUNCTION public.validate_board_attachment() RETURNS trigger
        LANGUAGE plpgsql AS $guard$
        DECLARE content_board uuid;
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM public.files AS f
                WHERE f.org_id = NEW.org_id AND f.id = NEW.file_id
                  AND f.board_id = NEW.board_id AND f.purpose = 'board_attachment'
            ) THEN
                RAISE EXCEPTION 'file does not belong to owning board'
                    USING ERRCODE = 'check_violation';
            END IF;
            IF NEW.event_id IS NOT NULL THEN
                SELECT board_id INTO content_board FROM public.board_events
                WHERE org_id = NEW.org_id AND id = NEW.event_id;
            {card_owner.format(target="content_board")}
            ELSE
                SELECT board_id INTO content_board FROM public.board_posts
                WHERE org_id = NEW.org_id AND id = NEW.post_id;
            END IF;
            IF content_board IS DISTINCT FROM NEW.board_id THEN
                RAISE EXCEPTION 'content does not belong to owning board'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $guard$;
        """,
    )


def upgrade() -> None:
    op.create_table(
        "board_stages",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("color", sa.String(length=10), nullable=True),
        sa.Column("wip_limit", sa.Integer(), nullable=True),
        sa.Column(
            "card_sort", sa.String(length=10), server_default=sa.text("'manual'"), nullable=False
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "card_sort IN ('manual', 'due', 'newest', 'title')", name="ck_board_stages_card_sort"
        ),
        sa.CheckConstraint(
            "color IS NULL OR color IN ('chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5')",
            name="ck_board_stages_color",
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_board_stages_name_nonempty"),
        sa.CheckConstraint("position >= 0", name="ck_board_stages_position"),
        sa.CheckConstraint("revision > 0", name="ck_board_stages_revision_positive"),
        sa.CheckConstraint("wip_limit IS NULL OR wip_limit >= 1", name="ck_board_stages_wip_limit"),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_stages_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_stages_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_stages_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_stages_pkey")),
        sa.UniqueConstraint("org_id", "board_id", "id", name="uq_board_stages_board_key"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_stages_org_id_id"),
    )
    op.create_index("ix_board_stages_board_id", "board_stages", ["board_id"], unique=False)
    op.create_index(
        "uq_board_stages_board_position_active",
        "board_stages",
        ["board_id", "position"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL AND NOT is_deleted"),
    )
    op.create_table(
        "board_labels",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("color", sa.String(length=10), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "color IN ('chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5')",
            name="ck_board_labels_color",
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_board_labels_name_nonempty"),
        sa.CheckConstraint("position >= 0", name="ck_board_labels_position"),
        sa.CheckConstraint("revision > 0", name="ck_board_labels_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_labels_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_labels_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_labels_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_labels_pkey")),
        sa.UniqueConstraint("org_id", "board_id", "id", name="uq_board_labels_board_key"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_labels_org_id_id"),
    )
    op.create_index(
        "uq_board_labels_board_name",
        "board_labels",
        ["board_id", sa.literal_column("lower(name)")],
        unique=True,
    )
    op.create_table(
        "board_cards",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("stage_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("module_id", sa.Uuid(), nullable=True),
        sa.Column("record_id", sa.Uuid(), nullable=True),
        sa.Column("assignee_id", sa.UUID(), nullable=True),
        sa.Column("start_on", sa.Date(), nullable=True),
        sa.Column("due_on", sa.Date(), nullable=True),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "(kind = 'objective' AND title IS NOT NULL AND length(btrim(title)) > 0 "
            "AND module_id IS NULL AND record_id IS NULL) OR "
            "(kind = 'record' AND title IS NULL AND description IS NULL "
            "AND module_id IS NOT NULL AND record_id IS NOT NULL)",
            name="ck_board_cards_kind_columns",
        ),
        sa.CheckConstraint("kind IN ('objective', 'record')", name="ck_board_cards_kind"),
        sa.CheckConstraint(
            "description IS NULL OR length(description) <= 5000",
            name="ck_board_cards_description_length",
        ),
        sa.CheckConstraint("revision > 0", name="ck_board_cards_revision_positive"),
        sa.CheckConstraint(
            "start_on IS NULL OR due_on IS NULL OR start_on <= due_on", name="ck_board_cards_dates"
        ),
        sa.ForeignKeyConstraint(
            ["assignee_id"],
            ["users.id"],
            name=op.f("fk_board_cards_assignee_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id", "stage_id"],
            ["board_stages.org_id", "board_stages.board_id", "board_stages.id"],
            name="fk_board_cards_stage_id_board_stages",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_cards_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_cards_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_board_cards_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_cards_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_cards_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_cards_pkey")),
        sa.UniqueConstraint("org_id", "board_id", "id", name="uq_board_cards_board_key"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_cards_org_id_id"),
    )
    op.create_index("ix_board_cards_assignee_id", "board_cards", ["assignee_id"], unique=False)
    op.create_index("ix_board_cards_board_id", "board_cards", ["board_id"], unique=False)
    op.create_index("ix_board_cards_module_id", "board_cards", ["module_id"], unique=False)
    op.create_index("ix_board_cards_record_id", "board_cards", ["record_id"], unique=False)
    op.create_index(
        "uq_board_cards_board_record_active",
        "board_cards",
        ["board_id", "record_id"],
        unique=True,
        postgresql_where=sa.text(
            "record_id IS NOT NULL AND archived_at IS NULL AND NOT is_deleted"
        ),
    )
    op.create_index(
        "uq_board_cards_stage_rank_active",
        "board_cards",
        ["stage_id", "rank"],
        unique=True,
        postgresql_where=sa.text("archived_at IS NULL AND NOT is_deleted"),
    )
    op.create_table(
        "board_card_labels",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("card_id", sa.Uuid(), nullable=False),
        sa.Column("label_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id", "card_id"],
            ["board_cards.org_id", "board_cards.board_id", "board_cards.id"],
            name="fk_board_card_labels_card_id_board_cards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id", "label_id"],
            ["board_labels.org_id", "board_labels.board_id", "board_labels.id"],
            name="fk_board_card_labels_label_id_board_labels",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_card_labels_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_card_labels_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_card_labels_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_card_labels_pkey")),
        sa.UniqueConstraint("card_id", "label_id", name="uq_board_card_labels_pair"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_card_labels_org_id_id"),
    )
    op.create_index(
        "ix_board_card_labels_board_id", "board_card_labels", ["board_id"], unique=False
    )
    op.create_index(
        "ix_board_card_labels_label_id", "board_card_labels", ["label_id"], unique=False
    )
    op.create_table(
        "board_card_checklist_items",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("card_id", sa.Uuid(), nullable=False),
        sa.Column("done", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("text", sa.String(length=200), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.CheckConstraint("length(btrim(text)) > 0", name="ck_board_card_checklist_items_text"),
        sa.CheckConstraint("position >= 0", name="ck_board_card_checklist_items_position"),
        sa.CheckConstraint("revision > 0", name="ck_board_card_checklist_items_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id", "card_id"],
            ["board_cards.org_id", "board_cards.board_id", "board_cards.id"],
            name="fk_board_card_checklist_items_card_id_board_cards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_card_checklist_items_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_card_checklist_items_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_card_checklist_items_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_card_checklist_items_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_card_checklist_items_org_id_id"),
    )
    op.create_index(
        "ix_board_card_checklist_items_board_id",
        "board_card_checklist_items",
        ["board_id"],
        unique=False,
    )
    op.create_index(
        "uq_board_card_checklist_items_card_position",
        "board_card_checklist_items",
        ["card_id", "position"],
        unique=True,
    )

    # Deliberate model-derived audit FKs and row policies omitted by autogenerate.
    for table in TABLES:
        op.create_foreign_key(
            f"fk_{table}_performed_by_users",
            table,
            "users",
            ["performed_by"],
            ["id"],
            ondelete="SET NULL",
        )
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY organization_rows ON public.{table} TO openslate_app "
            f"USING (org_id = {SCOPE}) WITH CHECK (org_id = {SCOPE})"
        )
    for table in ("board_attachments", "board_record_links"):
        op.add_column(table, sa.Column("card_id", sa.Uuid(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_card_id_board_cards",
            table,
            "board_cards",
            ["org_id", "card_id"],
            ["org_id", "id"],
            ondelete="RESTRICT",
        )
        op.drop_constraint(f"ck_{table}_one_owner", table, type_="check")
        op.create_check_constraint(f"ck_{table}_one_owner", table, THREE_OWNERS)
    op.create_index("ix_board_attachments_card_id", "board_attachments", ["card_id"])
    op.create_unique_constraint(
        "uq_board_card_record_link", "board_record_links", ["card_id", "record_id"]
    )
    # The content guards must find a card owner's Board, and keep it immutable.
    for statement in _guards(card=True):
        op.execute(statement)


def downgrade() -> None:
    op.drop_constraint("uq_board_card_record_link", "board_record_links", type_="unique")
    op.drop_index("ix_board_attachments_card_id", table_name="board_attachments")
    for table in ("board_attachments", "board_record_links"):
        # A card-owned row has no event or post to fall back to.
        op.execute(f"DELETE FROM public.{table} WHERE card_id IS NOT NULL")
        op.drop_constraint(f"ck_{table}_one_owner", table, type_="check")
        op.create_check_constraint(f"ck_{table}_one_owner", table, TWO_OWNERS)
    for statement in _guards(card=False):
        op.execute(statement)
    for table in ("board_attachments", "board_record_links"):
        op.drop_constraint(f"fk_{table}_card_id_board_cards", table, type_="foreignkey")
        op.drop_column(table, "card_id")
    # The row policies, indexes and audit FKs go with their tables.
    for table in reversed(TABLES):
        op.drop_table(table)
