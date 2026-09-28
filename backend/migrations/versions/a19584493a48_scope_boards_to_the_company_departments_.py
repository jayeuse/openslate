"""scope boards to the company, departments and projects

Revision ID: a19584493a48
Revises: 22c73bf93a9d
Create Date: 2026-09-28 10:05:12.114873

Boards get a scope (company, department or project). Project Boards get their
readers from ``board_groups``. Announcements become posts: the announcement
tables, their ``announcement_id`` columns and every constraint, index and
trigger that carried the old names are renamed, and the database functions whose
bodies named the old tables are replaced. Posts, events and tiles lose their
audience columns, and tiles lose their creator. An event reminder becomes an
author-set timing, and ``scheduled_work`` gets one row for each reminder and
occurrence. Grants, templates, favorites, homes, pinned records and personal
post states are dropped.

Existing Boards have no scope and cannot be mapped, so the upgrade refuses to
run while any Board exists; reset the development application data first. The
upgrade creates the company Board and one Board for each existing department.
The downgrade refuses while any Board content exists, removes the seeded Boards
and recreates the dropped tables empty.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

revision: str = "a19584493a48"
down_revision: str | None = "22c73bf93a9d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLES = (
    ("board_announcements", "board_posts"),
    ("board_announcement_revisions", "board_post_revisions"),
    ("board_announcement_revision_attachments", "board_post_revision_attachments"),
    ("board_announcement_revision_record_links", "board_post_revision_record_links"),
    ("board_content_attachments", "board_attachments"),
    ("board_content_record_links", "board_record_links"),
)

# (table after rename, old column, new column)
COLUMNS = (
    ("board_post_revisions", "announcement_id", "post_id"),
    ("board_attachments", "announcement_id", "post_id"),
    ("board_record_links", "announcement_id", "post_id"),
    ("scheduled_work", "announcement_id", "post_id"),
)

_POST_CHECKS = (
    "body_length",
    "body_nonempty",
    "displayed_publication_positive",
    "expiry",
    "links_array_limit",
    "revision_positive",
    "scheduled_time",
    "status",
    "title_nonempty",
)
_REVISION_CHECKS = (
    "body_length",
    "body_nonempty",
    "expiry",
    "fingerprint_hex",
    "links_array_limit",
    "number_positive",
    "title_nonempty",
)

# (table after rename, old constraint, new constraint). Renaming a primary key or
# unique constraint also renames its index.
CONSTRAINTS = (
    ("board_posts", "board_announcements_pkey", "board_posts_pkey"),
    *(
        ("board_posts", f"ck_board_announcements_{suffix}", f"ck_board_posts_{suffix}")
        for suffix in _POST_CHECKS
    ),
    ("board_posts", "fk_board_announcements_author_id_users", "fk_board_posts_author_id_users"),
    ("board_posts", "fk_board_announcements_board_id_boards", "fk_board_posts_board_id_boards"),
    (
        "board_posts",
        "fk_board_announcements_performed_by_users",
        "fk_board_posts_performed_by_users",
    ),
    ("board_post_revisions", "board_announcement_revisions_pkey", "board_post_revisions_pkey"),
    *(
        (
            "board_post_revisions",
            f"ck_board_announcement_revisions_{suffix}",
            f"ck_board_post_revisions_{suffix}",
        )
        for suffix in _REVISION_CHECKS
    ),
    (
        "board_post_revisions",
        "fk_board_announcement_revisions_announcement_id_board_a_8eb6",
        "fk_board_post_revisions_post_id_board_posts",
    ),
    (
        "board_post_revisions",
        "fk_board_announcement_revisions_author_id_users",
        "fk_board_post_revisions_author_id_users",
    ),
    (
        "board_post_revisions",
        "fk_board_announcement_revisions_performed_by_users",
        "fk_board_post_revisions_performed_by_users",
    ),
    (
        "board_post_revisions",
        "uq_board_announcement_revisions_publication",
        "uq_board_post_revisions_publication",
    ),
    (
        "board_post_revisions",
        "uq_board_announcement_revisions_publication_key",
        "uq_board_post_revisions_publication_key",
    ),
    (
        "board_post_revision_attachments",
        "board_announcement_revision_attachments_pkey",
        "board_post_revision_attachments_pkey",
    ),
    (
        "board_post_revision_attachments",
        "uq_board_announcement_revision_attachments",
        "uq_board_post_revision_attachments",
    ),
    (
        "board_post_revision_attachments",
        "fk_board_announcement_revision_attachments_file_id_files",
        "fk_board_post_revision_attachments_file_id_files",
    ),
    (
        "board_post_revision_attachments",
        "fk_board_announcement_revision_attachments_performed_by_users",
        "fk_board_post_revision_attachments_performed_by_users",
    ),
    (
        "board_post_revision_attachments",
        "fk_board_announcement_revision_attachments_revision_id__f437",
        "fk_board_post_revision_attachments_revision_id_board_po_e4cf",
    ),
    (
        "board_post_revision_record_links",
        "board_announcement_revision_record_links_pkey",
        "board_post_revision_record_links_pkey",
    ),
    (
        "board_post_revision_record_links",
        "fk_board_announcement_revision_record_links_module_id_modules",
        "fk_board_post_revision_record_links_module_id_modules",
    ),
    (
        "board_post_revision_record_links",
        "fk_board_announcement_revision_record_links_performed_by_users",
        "fk_board_post_revision_record_links_performed_by_users",
    ),
    (
        "board_post_revision_record_links",
        "fk_board_announcement_revision_record_links_record_id_records",
        "fk_board_post_revision_record_links_record_id_records",
    ),
    (
        "board_post_revision_record_links",
        "fk_board_announcement_revision_record_links_revision_id_9f9a",
        "fk_board_post_revision_record_links_revision_id_board_p_cabc",
    ),
    ("board_attachments", "board_content_attachments_pkey", "board_attachments_pkey"),
    (
        "board_attachments",
        "ck_board_content_attachments_one_owner",
        "ck_board_attachments_one_owner",
    ),
    ("board_attachments", "uq_board_content_attachments_file", "uq_board_attachments_file"),
    (
        "board_attachments",
        "fk_board_content_attachments_announcement_id_board_anno_eceb",
        "fk_board_attachments_post_id_board_posts",
    ),
    (
        "board_attachments",
        "fk_board_content_attachments_board_id_boards",
        "fk_board_attachments_board_id_boards",
    ),
    (
        "board_attachments",
        "fk_board_content_attachments_event_id_board_events",
        "fk_board_attachments_event_id_board_events",
    ),
    (
        "board_attachments",
        "fk_board_content_attachments_file_id_files",
        "fk_board_attachments_file_id_files",
    ),
    (
        "board_attachments",
        "fk_board_content_attachments_performed_by_users",
        "fk_board_attachments_performed_by_users",
    ),
    ("board_record_links", "board_content_record_links_pkey", "board_record_links_pkey"),
    ("board_record_links", "ck_board_content_record_links_label", "ck_board_record_links_label"),
    (
        "board_record_links",
        "ck_board_content_record_links_one_owner",
        "ck_board_record_links_one_owner",
    ),
    ("board_record_links", "uq_board_notice_record_link", "uq_board_post_record_link"),
    (
        "board_record_links",
        "fk_board_content_record_links_announcement_id_board_ann_c51b",
        "fk_board_record_links_post_id_board_posts",
    ),
    *(
        (
            "board_record_links",
            f"fk_board_content_record_links_{suffix}",
            f"fk_board_record_links_{suffix}",
        )
        for suffix in (
            "board_id_boards",
            "event_id_board_events",
            "module_id_modules",
            "performed_by_users",
            "record_id_records",
        )
    ),
    (
        "scheduled_work",
        "fk_scheduled_work_announcement_id_board_announcements",
        "fk_scheduled_work_post_id_board_posts",
    ),
    (
        "scheduled_work",
        "fk_scheduled_work_publication_result_id_board_announcem_1e98",
        "fk_scheduled_work_publication_result_id_board_post_revisions",
    ),
    (
        "scheduled_work",
        "uq_scheduled_work_announcement_occurrence",
        "uq_scheduled_work_post_occurrence",
    ),
)

# Indexes that do not belong to a constraint: (old, new).
INDEXES = (
    ("ix_board_announcements_author_id", "ix_board_posts_author_id"),
    ("ix_board_announcements_board_id", "ix_board_posts_board_id"),
    ("ix_board_announcement_revisions_author_id", "ix_board_post_revisions_author_id"),
    (
        "ix_board_announcement_revision_attachments_file_id",
        "ix_board_post_revision_attachments_file_id",
    ),
    ("ix_board_content_attachments_announcement_id", "ix_board_attachments_post_id"),
    ("ix_board_content_attachments_board_id", "ix_board_attachments_board_id"),
    ("ix_board_content_attachments_event_id", "ix_board_attachments_event_id"),
    ("ix_board_content_record_links_board_id", "ix_board_record_links_board_id"),
    ("ix_board_content_record_links_module_id", "ix_board_record_links_module_id"),
    ("ix_board_content_record_links_record_id", "ix_board_record_links_record_id"),
)

CONTENT_AUDIENCE_CHECK = (
    "(audience_kind IN ('everyone', 'author') "
    "AND audience_user_id IS NULL AND audience_department_id IS NULL) OR "
    "(audience_kind = 'user' "
    "AND audience_user_id IS NOT NULL AND audience_department_id IS NULL) OR "
    "(audience_kind = 'department' "
    "AND audience_user_id IS NULL AND audience_department_id IS NOT NULL)"
)
WIDGET_AUDIENCE_CHECK = (
    "(audience_kind IN ('private', 'everyone') AND audience_user_id IS NULL) OR "
    "(audience_kind = 'user' AND audience_user_id IS NOT NULL)"
)

# (table before the rename, audience department FK name)
CONTENT_AUDIENCES = (
    ("board_announcements", "fk_board_announcements_audience_department_id_departments"),
    (
        "board_announcement_revisions",
        "fk_board_announcement_revisions_audience_department_id__2629",
    ),
    ("board_events", "fk_board_events_audience_department_id_departments"),
)

WORK_CHECKS = {
    "ck_scheduled_work_kind": "kind IN ('report-run', '{publish}', 'event-reminder')",
    "ck_scheduled_work_source": (
        "(kind = 'report-run' AND report_id IS NOT NULL AND {post} IS NULL "
        "AND reminder_id IS NULL{no_occurrence} "
        "AND source_revision IS NULL AND scheduling_actor_id IS NULL "
        "AND publication_result_id IS NULL) OR "
        "(kind = '{publish}' AND report_id IS NULL "
        "AND reminder_id IS NULL{no_occurrence} "
        "AND {post} IS NOT NULL AND source_revision IS NOT NULL "
        "AND source_revision > 0 AND scheduling_actor_id IS NOT NULL AND run_id IS NULL) OR "
        "(kind = 'event-reminder' AND report_id IS NULL AND {post} IS NULL "
        "AND reminder_id IS NOT NULL{occurrence} AND source_revision IS NULL "
        "AND scheduling_actor_id IS NULL AND publication_result_id IS NULL "
        "AND run_id IS NULL)"
    ),
    "ck_scheduled_work_run": (
        "(kind = 'report-run' AND ((state = 'succeeded' AND run_id IS NOT NULL) "
        "OR (state <> 'succeeded' AND run_id IS NULL))) OR "
        "(kind = '{publish}' AND "
        "((state = 'succeeded' AND publication_result_id IS NOT NULL) "
        "OR (state <> 'succeeded' AND publication_result_id IS NULL))) OR "
        "(kind = 'event-reminder' AND run_id IS NULL AND publication_result_id IS NULL)"
    ),
}

NEW_FUNCTIONS = (
    "reject_board_post_revision_update",
    "validate_board_attachment",
    "reject_board_attachment_owner_change",
    "validate_revision_attachment",
    "reject_revision_attachment_update",
    "board_record_link_guard",
    "board_revision_record_link_guard",
    "reject_file_board_move",
)
OLD_FUNCTIONS = (
    "reject_board_announcement_revision_update",
    "validate_board_content_attachment",
    "reject_board_content_owner_change",
    "validate_revision_attachment",
    "reject_revision_attachment_update",
    "board_record_link_guard",
    "board_revision_record_link_guard",
    "reject_file_board_move",
)

POST_FUNCTIONS = (
    """
    CREATE FUNCTION reject_board_post_revision_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'published post revisions are immutable'
            USING ERRCODE = 'check_violation';
    END;
    $$
    """,
    """
    CREATE TRIGGER trg_board_post_revisions_immutable
    BEFORE UPDATE ON board_post_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_board_post_revision_update()
    """,
    """
    CREATE FUNCTION validate_board_attachment()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE content_board uuid;
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM files AS f WHERE f.id = NEW.file_id
            AND f.board_id = NEW.board_id AND f.purpose = 'board_attachment'
        ) THEN
            RAISE EXCEPTION 'file does not belong to owning board'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.event_id IS NOT NULL THEN
            SELECT board_id INTO content_board FROM board_events WHERE id = NEW.event_id;
        ELSE
            SELECT board_id INTO content_board FROM board_posts WHERE id = NEW.post_id;
        END IF;
        IF content_board IS DISTINCT FROM NEW.board_id THEN
            RAISE EXCEPTION 'content does not belong to owning board'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE TRIGGER trg_board_attachment_owner
    BEFORE INSERT OR UPDATE ON board_attachments
    FOR EACH ROW EXECUTE FUNCTION validate_board_attachment()
    """,
    """
    CREATE FUNCTION reject_board_attachment_owner_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF OLD.board_id IS DISTINCT FROM NEW.board_id
            OR OLD.file_id IS DISTINCT FROM NEW.file_id
            OR OLD.event_id IS DISTINCT FROM NEW.event_id
            OR OLD.post_id IS DISTINCT FROM NEW.post_id THEN
            RAISE EXCEPTION 'board file content owner is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE TRIGGER trg_board_attachment_immutable
    BEFORE UPDATE ON board_attachments
    FOR EACH ROW EXECUTE FUNCTION reject_board_attachment_owner_change()
    """,
    """
    CREATE OR REPLACE FUNCTION validate_revision_attachment()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE content_id uuid;
    BEGIN
        SELECT post_id INTO content_id FROM board_post_revisions
        WHERE id = NEW.revision_id;
        IF NOT EXISTS (
            SELECT 1 FROM board_attachments AS a
            WHERE a.file_id = NEW.file_id AND a.post_id = content_id
        ) THEN
            RAISE EXCEPTION 'published file has a different content owner'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE OR REPLACE FUNCTION board_record_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owner_board uuid; source_module uuid;
    BEGIN
        IF TG_OP = 'UPDATE' AND (
            OLD.board_id IS DISTINCT FROM NEW.board_id OR
            OLD.event_id IS DISTINCT FROM NEW.event_id OR
            OLD.post_id IS DISTINCT FROM NEW.post_id OR
            OLD.record_id IS DISTINCT FROM NEW.record_id OR
            OLD.module_id IS DISTINCT FROM NEW.module_id
        ) THEN
            RAISE EXCEPTION 'Board Record link owner is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.event_id IS NOT NULL THEN
            SELECT board_id INTO owner_board FROM board_events WHERE id = NEW.event_id;
        ELSE
            SELECT board_id INTO owner_board FROM board_posts WHERE id = NEW.post_id;
        END IF;
        SELECT module_id INTO source_module FROM records WHERE id = NEW.record_id;
        IF owner_board IS DISTINCT FROM NEW.board_id OR
           source_module IS DISTINCT FROM NEW.module_id THEN
            RAISE EXCEPTION 'Board Record link parent mismatch' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE OR REPLACE FUNCTION board_revision_record_link_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE source_module uuid; current_link uuid;
    BEGIN
        IF TG_OP = 'UPDATE' THEN
            RAISE EXCEPTION 'Published Board Record links are immutable'
                USING ERRCODE = '23514';
        END IF;
        SELECT module_id INTO source_module FROM records WHERE id = NEW.record_id;
        SELECT link.id INTO current_link
          FROM board_record_links AS link
          JOIN board_post_revisions AS revision
            ON revision.post_id = link.post_id
         WHERE revision.id = NEW.revision_id
           AND link.record_id = NEW.record_id
           AND link.module_id = NEW.module_id
           AND link.label = NEW.label;
        IF source_module IS DISTINCT FROM NEW.module_id OR current_link IS NULL THEN
            RAISE EXCEPTION 'Published Board Record link parent mismatch'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
)

ANNOUNCEMENT_FUNCTIONS = (
    """
    CREATE FUNCTION reject_board_announcement_revision_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        RAISE EXCEPTION 'published announcement revisions are immutable'
            USING ERRCODE = 'check_violation';
    END;
    $$
    """,
    """
    CREATE TRIGGER trg_board_announcement_revisions_immutable
    BEFORE UPDATE ON board_announcement_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_board_announcement_revision_update()
    """,
    """
    CREATE FUNCTION validate_board_content_attachment()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE content_board uuid;
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM files AS f WHERE f.id = NEW.file_id
            AND f.board_id = NEW.board_id AND f.purpose = 'board_attachment'
        ) THEN
            RAISE EXCEPTION 'file does not belong to owning board'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.event_id IS NOT NULL THEN
            SELECT board_id INTO content_board FROM board_events WHERE id = NEW.event_id;
        ELSE
            SELECT board_id INTO content_board FROM board_announcements
            WHERE id = NEW.announcement_id;
        END IF;
        IF content_board IS DISTINCT FROM NEW.board_id THEN
            RAISE EXCEPTION 'content does not belong to owning board'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE TRIGGER trg_board_content_attachment_owner
    BEFORE INSERT OR UPDATE ON board_content_attachments
    FOR EACH ROW EXECUTE FUNCTION validate_board_content_attachment()
    """,
    """
    CREATE FUNCTION reject_board_content_owner_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
        IF OLD.board_id IS DISTINCT FROM NEW.board_id
            OR OLD.file_id IS DISTINCT FROM NEW.file_id
            OR OLD.event_id IS DISTINCT FROM NEW.event_id
            OR OLD.announcement_id IS DISTINCT FROM NEW.announcement_id THEN
            RAISE EXCEPTION 'board file content owner is immutable'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE TRIGGER trg_board_content_attachment_immutable
    BEFORE UPDATE ON board_content_attachments
    FOR EACH ROW EXECUTE FUNCTION reject_board_content_owner_change()
    """,
    """
    CREATE OR REPLACE FUNCTION validate_revision_attachment()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE content_id uuid;
    BEGIN
        SELECT announcement_id INTO content_id FROM board_announcement_revisions
        WHERE id = NEW.revision_id;
        IF NOT EXISTS (
            SELECT 1 FROM board_content_attachments AS a
            WHERE a.file_id = NEW.file_id AND a.announcement_id = content_id
        ) THEN
            RAISE EXCEPTION 'published file has a different content owner'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE OR REPLACE FUNCTION board_record_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owner_board uuid; source_module uuid;
    BEGIN
        IF TG_OP = 'UPDATE' AND (
            OLD.board_id IS DISTINCT FROM NEW.board_id OR
            OLD.event_id IS DISTINCT FROM NEW.event_id OR
            OLD.announcement_id IS DISTINCT FROM NEW.announcement_id OR
            OLD.record_id IS DISTINCT FROM NEW.record_id OR
            OLD.module_id IS DISTINCT FROM NEW.module_id
        ) THEN
            RAISE EXCEPTION 'Board Record link owner is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.event_id IS NOT NULL THEN
            SELECT board_id INTO owner_board FROM board_events WHERE id = NEW.event_id;
        ELSE
            SELECT board_id INTO owner_board FROM board_announcements
                WHERE id = NEW.announcement_id;
        END IF;
        SELECT module_id INTO source_module FROM records WHERE id = NEW.record_id;
        IF owner_board IS DISTINCT FROM NEW.board_id OR
           source_module IS DISTINCT FROM NEW.module_id THEN
            RAISE EXCEPTION 'Board Record link parent mismatch' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
    """
    CREATE OR REPLACE FUNCTION board_revision_record_link_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE source_module uuid; current_link uuid;
    BEGIN
        IF TG_OP = 'UPDATE' THEN
            RAISE EXCEPTION 'Published Board Record links are immutable'
                USING ERRCODE = '23514';
        END IF;
        SELECT module_id INTO source_module FROM records WHERE id = NEW.record_id;
        SELECT link.id INTO current_link
          FROM board_content_record_links AS link
          JOIN board_announcement_revisions AS revision
            ON revision.announcement_id = link.announcement_id
         WHERE revision.id = NEW.revision_id
           AND link.record_id = NEW.record_id
           AND link.module_id = NEW.module_id
           AND link.label = NEW.label;
        IF source_module IS DISTINCT FROM NEW.module_id OR current_link IS NULL THEN
            RAISE EXCEPTION 'Published Board Record link parent mismatch'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END;
    $$
    """,
)

BOARD_CONTENT_TABLES = (
    "board_posts",
    "board_events",
    "board_widgets",
    "board_groups",
    "board_attachments",
    "board_record_links",
    "board_event_reminders",
)


def _raise_if(condition: str, message: str, hint: str) -> None:
    op.execute(
        f"""
        DO $guard$
        BEGIN
            IF {condition} THEN
                RAISE EXCEPTION '{message}'
                    USING HINT = '{hint}',
                          ERRCODE = 'object_not_in_prerequisite_state';
            END IF;
        END
        $guard$;
        """
    )


def _grant_functions(names: Sequence[str]) -> None:
    signatures = ", ".join(f"public.{name}()" for name in names)
    op.execute(
        f"REVOKE ALL ON FUNCTION {signatures} FROM PUBLIC, anon, authenticated, service_role"
    )
    op.execute(f"GRANT EXECUTE ON FUNCTION {signatures} TO openslate_app")


def _rename_objects(*, forward: bool) -> None:
    def pair(old: str, new: str) -> tuple[str, str]:
        return (old, new) if forward else (new, old)

    for old, new in TABLES:
        source, target = pair(old, new)
        op.rename_table(source, target)
    table_names = {new: new if forward else old for old, new in TABLES}
    for table, old, new in COLUMNS:
        source, target = pair(old, new)
        op.alter_column(table_names.get(table, table), source, new_column_name=target)
    for table, old, new in CONSTRAINTS:
        source, target = pair(old, new)
        op.execute(
            f"ALTER TABLE public.{table_names.get(table, table)} "
            f"RENAME CONSTRAINT {source} TO {target}"
        )
    for old, new in INDEXES:
        source, target = pair(old, new)
        op.execute(f"ALTER INDEX public.{source} RENAME TO {target}")


def _drop_content_audiences() -> None:
    for table, department_fk in CONTENT_AUDIENCES:
        op.drop_index(f"ix_{table}_audience_department_id", table_name=table)
        op.drop_index(f"ix_{table}_audience_user_id", table_name=table)
        op.drop_constraint(department_fk, table, type_="foreignkey")
        op.drop_constraint(f"fk_{table}_audience_user_id_users", table, type_="foreignkey")
        op.drop_constraint(f"ck_{table}_audience", table, type_="check")
        op.drop_column(table, "audience_department_id")
        op.drop_column(table, "audience_user_id")
        op.drop_column(table, "audience_kind")
    op.drop_index("ix_board_widgets_creator_id", table_name="board_widgets")
    op.drop_constraint("fk_board_widgets_creator_id_users", "board_widgets", type_="foreignkey")
    op.drop_constraint(
        "fk_board_widgets_audience_user_id_users", "board_widgets", type_="foreignkey"
    )
    op.drop_constraint("ck_board_widgets_audience", "board_widgets", type_="check")
    op.drop_column("board_widgets", "creator_id")
    op.drop_column("board_widgets", "audience_user_id")
    op.drop_column("board_widgets", "audience_kind")


def _restore_content_audiences() -> None:
    for table, department_fk in CONTENT_AUDIENCES:
        op.add_column(
            table,
            sa.Column("audience_kind", sa.VARCHAR(length=20), nullable=False),
        )
        op.add_column(table, sa.Column("audience_user_id", sa.UUID(), nullable=True))
        op.add_column(table, sa.Column("audience_department_id", sa.UUID(), nullable=True))
        op.create_check_constraint(f"ck_{table}_audience", table, CONTENT_AUDIENCE_CHECK)
        op.create_foreign_key(
            f"fk_{table}_audience_user_id_users",
            table,
            "users",
            ["audience_user_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        op.create_foreign_key(
            department_fk,
            table,
            "departments",
            ["audience_department_id"],
            ["id"],
            ondelete="RESTRICT",
        )
        op.create_index(f"ix_{table}_audience_user_id", table, ["audience_user_id"])
        op.create_index(f"ix_{table}_audience_department_id", table, ["audience_department_id"])
    op.add_column("board_widgets", sa.Column("audience_kind", sa.VARCHAR(20), nullable=False))
    op.add_column("board_widgets", sa.Column("audience_user_id", sa.UUID(), nullable=True))
    op.add_column("board_widgets", sa.Column("creator_id", sa.UUID(), nullable=False))
    op.create_check_constraint("ck_board_widgets_audience", "board_widgets", WIDGET_AUDIENCE_CHECK)
    op.create_foreign_key(
        "fk_board_widgets_audience_user_id_users",
        "board_widgets",
        "users",
        ["audience_user_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        "fk_board_widgets_creator_id_users",
        "board_widgets",
        "users",
        ["creator_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_board_widgets_creator_id", "board_widgets", ["creator_id"])


def _drop_personal_tables() -> None:
    op.drop_index(
        "ix_board_announcement_personal_states_announcement_id",
        table_name="board_announcement_personal_states",
    )
    op.drop_table("board_announcement_personal_states")
    op.drop_index("uq_board_grants_active_user_decision", table_name="board_grants")
    op.drop_index("uq_board_grants_active_everyone_decision", table_name="board_grants")
    op.drop_index("ix_board_grants_principal_user_id", table_name="board_grants")
    op.drop_index("ix_board_grants_board_id", table_name="board_grants")
    op.drop_table("board_grants")
    op.drop_table("board_templates")
    op.drop_index("ix_board_favorites_board_id", table_name="board_favorites")
    op.drop_table("board_favorites")
    op.drop_index("ix_board_homes_board_id", table_name="board_homes")
    op.drop_table("board_homes")
    op.drop_index("ix_board_record_placements_record_id", table_name="board_record_placements")
    op.drop_table("board_record_placements")


def _base_columns() -> list[sa.Column[object]]:
    return [
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.BOOLEAN(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
    ]


def _performed_by(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["performed_by"], ["users.id"], name=f"fk_{table}_performed_by_users", ondelete="SET NULL"
    )


def _restore_personal_tables() -> None:
    op.create_table(
        "board_templates",
        sa.Column("name", sa.VARCHAR(length=80), nullable=False),
        sa.Column("bundle", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        *_base_columns(),
        sa.CheckConstraint(
            "length(btrim(name::text)) > 0", name="ck_board_templates_name_nonempty"
        ),
        _performed_by("board_templates"),
        sa.PrimaryKeyConstraint("id", name="board_templates_pkey"),
    )
    for table, unique in (
        ("board_favorites", ("uq_board_favorites_user_board", ["user_id", "board_id"])),
        ("board_homes", ("uq_board_homes_user_id", ["user_id"])),
    ):
        op.create_table(
            table,
            sa.Column("user_id", sa.UUID(), nullable=False),
            sa.Column("board_id", sa.UUID(), nullable=False),
            *_base_columns(),
            sa.ForeignKeyConstraint(
                ["board_id"], ["boards.id"], name=f"fk_{table}_board_id_boards", ondelete="RESTRICT"
            ),
            _performed_by(table),
            sa.ForeignKeyConstraint(
                ["user_id"], ["users.id"], name=f"fk_{table}_user_id_users", ondelete="RESTRICT"
            ),
            sa.PrimaryKeyConstraint("id", name=f"{table}_pkey"),
            sa.UniqueConstraint(*unique[1], name=unique[0]),
        )
        op.create_index(f"ix_{table}_board_id", table, ["board_id"])
    op.create_table(
        "board_grants",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("principal_type", sa.VARCHAR(length=20), nullable=False),
        sa.Column("principal_user_id", sa.UUID(), nullable=True),
        sa.Column("permission", sa.VARCHAR(length=20), nullable=False),
        sa.Column("effect", sa.VARCHAR(length=10), nullable=False),
        *_base_columns(),
        sa.CheckConstraint("effect IN ('allow', 'deny')", name="ck_board_grants_effect"),
        sa.CheckConstraint(
            "permission IN ('view', 'edit', 'manage')", name="ck_board_grants_permission"
        ),
        sa.CheckConstraint(
            "(principal_type = 'user' AND principal_user_id IS NOT NULL) OR "
            "(principal_type = 'everyone' AND principal_user_id IS NULL)",
            name="ck_board_grants_principal_reference",
        ),
        sa.CheckConstraint(
            "principal_type IN ('user', 'everyone')", name="ck_board_grants_principal_type"
        ),
        sa.ForeignKeyConstraint(
            ["board_id"], ["boards.id"], name="fk_board_grants_board_id_boards", ondelete="RESTRICT"
        ),
        _performed_by("board_grants"),
        sa.ForeignKeyConstraint(
            ["principal_user_id"],
            ["users.id"],
            name="fk_board_grants_principal_user_id_users",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="board_grants_pkey"),
    )
    op.create_index("ix_board_grants_board_id", "board_grants", ["board_id"])
    op.create_index("ix_board_grants_principal_user_id", "board_grants", ["principal_user_id"])
    op.create_index(
        "uq_board_grants_active_everyone_decision",
        "board_grants",
        ["board_id", "permission", "effect"],
        unique=True,
        postgresql_where=sa.text("principal_type = 'everyone' AND is_deleted = false"),
    )
    op.create_index(
        "uq_board_grants_active_user_decision",
        "board_grants",
        ["board_id", "principal_user_id", "permission", "effect"],
        unique=True,
        postgresql_where=sa.text("principal_type = 'user' AND is_deleted = false"),
    )
    op.create_table(
        "board_record_placements",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("record_id", sa.UUID(), nullable=False),
        *_base_columns(),
        sa.ForeignKeyConstraint(
            ["board_id"],
            ["boards.id"],
            name="fk_board_record_placements_board_id_boards",
            ondelete="RESTRICT",
        ),
        _performed_by("board_record_placements"),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["records.id"],
            name="fk_board_record_placements_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="board_record_placements_pkey"),
        sa.UniqueConstraint(
            "board_id", "record_id", name="uq_board_record_placements_board_record"
        ),
    )
    op.create_index(
        "ix_board_record_placements_record_id", "board_record_placements", ["record_id"]
    )
    op.create_table(
        "board_announcement_personal_states",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("announcement_id", sa.UUID(), nullable=False),
        sa.Column("read", sa.BOOLEAN(), server_default=sa.text("false"), nullable=False),
        sa.Column("bookmarked", sa.BOOLEAN(), server_default=sa.text("false"), nullable=False),
        *_base_columns(),
        sa.ForeignKeyConstraint(
            ["announcement_id"],
            ["board_announcements.id"],
            name="fk_board_announcement_personal_states_announcement_id_b_ad94",
            ondelete="RESTRICT",
        ),
        _performed_by("board_announcement_personal_states"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_board_announcement_personal_states_user_id_users",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="board_announcement_personal_states_pkey"),
        sa.UniqueConstraint(
            "user_id",
            "announcement_id",
            name="uq_board_announcement_personal_states_user_announcement",
        ),
    )
    op.create_index(
        "ix_board_announcement_personal_states_announcement_id",
        "board_announcement_personal_states",
        ["announcement_id"],
    )


def _drop_work_checks() -> None:
    for name in WORK_CHECKS:
        op.drop_constraint(name, "scheduled_work", type_="check")


def _create_work_checks(*, publish: str, post: str, occurrence: bool) -> None:
    """Recreate the checks that name the publish kind, the post column and occurrences."""

    op.execute(
        sa.text(
            "UPDATE public.scheduled_work SET kind = :publish "
            "WHERE kind IN ('announcement-publish', 'post-publish')"
        ).bindparams(publish=publish)
    )
    values = {
        "publish": publish,
        "post": post,
        "no_occurrence": " AND occurrence_start_at IS NULL" if occurrence else "",
        "occurrence": " AND occurrence_start_at IS NOT NULL" if occurrence else "",
    }
    for name, check in WORK_CHECKS.items():
        op.create_check_constraint(name, "scheduled_work", check.format(**values))


def _seed_boards() -> None:
    bind = op.get_bind()
    insert = sa.text(
        "INSERT INTO public.boards (id, scope, department_id, name, status) "
        "VALUES (:id, :scope, :department_id, :name, :status)"
    )
    bind.execute(
        insert,
        {
            "id": uuid7(),
            "scope": "company",
            "department_id": None,
            "name": "Company",
            "status": "active",
        },
    )
    departments = bind.execute(
        sa.text("SELECT id, department_name, is_deleted FROM public.departments ORDER BY id")
    ).all()
    for department_id, name, closed in departments:
        bind.execute(
            insert,
            {
                "id": uuid7(),
                "scope": "department",
                "department_id": department_id,
                "name": name[:200],
                "status": "archived" if closed else "active",
            },
        )


def upgrade() -> None:
    _raise_if(
        "EXISTS (SELECT 1 FROM public.boards)",
        "Boards has content that cannot be moved to company, department and project Boards.",
        "Reset the development application data, then run the migration again. "
        "Existing Boards are not converted.",
    )
    _drop_content_audiences()
    _drop_personal_tables()

    op.execute(
        "DROP TRIGGER trg_board_announcement_revisions_immutable "
        "ON public.board_announcement_revisions"
    )
    op.execute(
        "DROP TRIGGER trg_board_content_attachment_owner ON public.board_content_attachments"
    )
    op.execute(
        "DROP TRIGGER trg_board_content_attachment_immutable ON public.board_content_attachments"
    )
    op.execute("DROP FUNCTION public.reject_board_announcement_revision_update()")
    op.execute("DROP FUNCTION public.validate_board_content_attachment()")
    op.execute("DROP FUNCTION public.reject_board_content_owner_change()")

    _drop_work_checks()
    _rename_objects(forward=True)

    op.drop_index("ix_boards_owner_id", table_name="boards")
    op.drop_constraint("fk_boards_owner_id_users", "boards", type_="foreignkey")
    op.drop_constraint("ck_boards_default_section", "boards", type_="check")
    op.drop_column("boards", "owner_id")
    op.drop_column("boards", "default_section")
    op.add_column("boards", sa.Column("scope", sa.String(length=20), nullable=False))
    op.create_check_constraint(
        "ck_boards_scope", "boards", "scope IN ('company', 'department', 'project')"
    )
    op.create_check_constraint(
        "ck_boards_department_scope",
        "boards",
        "(scope = 'department') = (department_id IS NOT NULL)",
    )
    op.create_index(
        "uq_boards_company",
        "boards",
        ["scope"],
        unique=True,
        postgresql_where=sa.text("scope = 'company' AND NOT is_deleted"),
    )
    op.create_index(
        "uq_boards_department",
        "boards",
        ["department_id"],
        unique=True,
        postgresql_where=sa.text("scope = 'department' AND NOT is_deleted"),
    )

    op.create_table(
        "board_groups",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("level", sa.String(length=10), nullable=False),
        *_base_columns(),
        sa.CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_board_groups_level"),
        sa.ForeignKeyConstraint(
            ["board_id"], ["boards.id"], name="fk_board_groups_board_id_boards", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["group_id"], ["groups.id"], name="fk_board_groups_group_id_groups", ondelete="RESTRICT"
        ),
        _performed_by("board_groups"),
        sa.PrimaryKeyConstraint("id", name="board_groups_pkey"),
    )
    op.create_index("ix_board_groups_group_id", "board_groups", ["group_id"])
    op.create_index(
        "uq_board_groups_board_group_active",
        "board_groups",
        ["board_id", "group_id"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )

    op.drop_index("ix_board_event_reminders_board_recipient", table_name="board_event_reminders")
    op.drop_index("ix_board_event_reminders_event_id", table_name="board_event_reminders")
    op.drop_constraint(
        "uq_board_event_reminders_choice", "board_event_reminders", type_="unique"
    )
    op.drop_constraint(
        "fk_board_event_reminders_recipient_id_users", "board_event_reminders", type_="foreignkey"
    )
    op.drop_constraint(
        "ck_board_event_reminders_occurrence_id", "board_event_reminders", type_="check"
    )
    op.drop_constraint("ck_board_event_reminders_timing", "board_event_reminders", type_="check")
    for column in ("recipient_id", "occurrence_id", "occurrence_start_at", "due_at"):
        op.drop_column("board_event_reminders", column)
    op.create_check_constraint(
        "ck_board_event_reminders_timing",
        "board_event_reminders",
        "timing IN ('start', '15m', '1d')",
    )
    op.create_unique_constraint(
        "uq_board_event_reminders_event_timing", "board_event_reminders", ["event_id", "timing"]
    )
    op.create_index("ix_board_event_reminders_board_id", "board_event_reminders", ["board_id"])

    op.drop_constraint("uq_scheduled_work_reminder", "scheduled_work", type_="unique")
    op.add_column(
        "scheduled_work",
        sa.Column("occurrence_start_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_unique_constraint(
        "uq_scheduled_work_reminder", "scheduled_work", ["reminder_id", "occurrence_start_at"]
    )
    _create_work_checks(publish="post-publish", post="post_id", occurrence=True)

    for statement in POST_FUNCTIONS:
        op.execute(statement)
    _grant_functions(NEW_FUNCTIONS)
    _seed_boards()


def downgrade() -> None:
    content = " OR ".join(
        f"EXISTS (SELECT 1 FROM public.{table})" for table in BOARD_CONTENT_TABLES
    )
    _raise_if(
        f"{content} OR EXISTS (SELECT 1 FROM public.files WHERE board_id IS NOT NULL) "
        "OR EXISTS (SELECT 1 FROM public.boards WHERE scope = 'project')",
        "Boards has posts, events, tiles, files or project Boards that the old model cannot hold.",
        "Reset the development application data, then run the downgrade again.",
    )
    op.execute("DELETE FROM public.boards")

    op.execute("DROP TRIGGER trg_board_post_revisions_immutable ON public.board_post_revisions")
    op.execute("DROP TRIGGER trg_board_attachment_owner ON public.board_attachments")
    op.execute("DROP TRIGGER trg_board_attachment_immutable ON public.board_attachments")
    op.execute("DROP FUNCTION public.reject_board_post_revision_update()")
    op.execute("DROP FUNCTION public.validate_board_attachment()")
    op.execute("DROP FUNCTION public.reject_board_attachment_owner_change()")

    _drop_work_checks()
    op.drop_constraint("uq_scheduled_work_reminder", "scheduled_work", type_="unique")
    op.drop_column("scheduled_work", "occurrence_start_at")
    op.create_unique_constraint("uq_scheduled_work_reminder", "scheduled_work", ["reminder_id"])

    op.drop_index("ix_board_event_reminders_board_id", table_name="board_event_reminders")
    op.drop_constraint(
        "uq_board_event_reminders_event_timing", "board_event_reminders", type_="unique"
    )
    op.drop_constraint("ck_board_event_reminders_timing", "board_event_reminders", type_="check")
    op.add_column(
        "board_event_reminders", sa.Column("recipient_id", sa.UUID(), nullable=False)
    )
    op.add_column(
        "board_event_reminders",
        sa.Column("occurrence_id", sa.VARCHAR(length=100), nullable=False),
    )
    op.add_column(
        "board_event_reminders",
        sa.Column("occurrence_start_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
    )
    op.add_column(
        "board_event_reminders",
        sa.Column("due_at", postgresql.TIMESTAMP(timezone=True), nullable=False),
    )
    op.create_check_constraint(
        "ck_board_event_reminders_timing",
        "board_event_reminders",
        "timing IN ('now', 'start', '15m', '1d')",
    )
    op.create_check_constraint(
        "ck_board_event_reminders_occurrence_id",
        "board_event_reminders",
        "length(btrim(occurrence_id)) > 0",
    )
    op.create_foreign_key(
        "fk_board_event_reminders_recipient_id_users",
        "board_event_reminders",
        "users",
        ["recipient_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint(
        "uq_board_event_reminders_choice",
        "board_event_reminders",
        ["event_id", "recipient_id", "occurrence_id"],
    )
    op.create_index("ix_board_event_reminders_event_id", "board_event_reminders", ["event_id"])
    op.create_index(
        "ix_board_event_reminders_board_recipient",
        "board_event_reminders",
        ["board_id", "recipient_id"],
    )

    op.drop_index("uq_board_groups_board_group_active", table_name="board_groups")
    op.drop_index("ix_board_groups_group_id", table_name="board_groups")
    op.drop_table("board_groups")

    op.drop_index("uq_boards_department", table_name="boards")
    op.drop_index("uq_boards_company", table_name="boards")
    op.drop_constraint("ck_boards_department_scope", "boards", type_="check")
    op.drop_constraint("ck_boards_scope", "boards", type_="check")
    op.drop_column("boards", "scope")
    op.add_column("boards", sa.Column("owner_id", sa.UUID(), nullable=False))
    op.add_column(
        "boards",
        sa.Column(
            "default_section",
            sa.VARCHAR(length=30),
            server_default=sa.text("'overview'"),
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_boards_default_section",
        "boards",
        "default_section IN ('overview', 'calendar', 'announcements')",
    )
    op.create_foreign_key(
        "fk_boards_owner_id_users", "boards", "users", ["owner_id"], ["id"], ondelete="RESTRICT"
    )
    op.create_index("ix_boards_owner_id", "boards", ["owner_id"])

    _rename_objects(forward=False)
    _create_work_checks(publish="announcement-publish", post="announcement_id", occurrence=False)

    for statement in ANNOUNCEMENT_FUNCTIONS:
        op.execute(statement)
    _grant_functions(OLD_FUNCTIONS)
    _restore_personal_tables()
    _restore_content_audiences()
