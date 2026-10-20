"""comms notification references

Revision ID: 7270134f320d
Revises: 7742d43bd994
Create Date: 2026-10-20 20:10:54.669269
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '7270134f320d'
down_revision: str | None = '7742d43bd994'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PREVIOUS_REFERENCE = (
    "(kind = 'report-run' AND subject_type = 'report_run' AND work_id IS NOT NULL) OR "
    "(kind = 'post-publish' AND subject_type = 'board_post' AND work_id IS NOT NULL) OR "
    "(kind = 'event-reminder' AND subject_type = 'board_event' AND work_id IS NOT NULL) OR "
    "(kind = 'report-run-failed' AND subject_type = 'scheduled_work' "
    "AND work_id IS NOT NULL AND subject_id = work_id) OR "
    "(kind = 'backup-failed' AND subject_type = 'backup_run' AND work_id IS NULL) OR "
    "(kind = 'record-assigned' AND subject_type = 'record' AND work_id IS NULL) OR "
    "(kind = 'invitation-accepted' AND subject_type = 'user' AND work_id IS NULL) OR "
    "(kind = 'sandbox-published' AND subject_type = 'sandbox_version' AND work_id IS NULL) OR "
    "(kind = 'access-changed' AND subject_type = 'user' AND work_id IS NULL "
    "AND subject_id = recipient_id)"
)


def upgrade() -> None:
    # Model-generated column/index/FK, with the model CHECKs Alembic does not detect.
    op.add_column(
        'in_app_notifications', sa.Column('comms_conversation_id', sa.Uuid(), nullable=True),
    )
    op.create_index(
        'uq_in_app_notifications_comms_recipient', 'in_app_notifications',
        ['org_id', 'recipient_id', 'subject_id'], unique=True,
        postgresql_where=sa.text("subject_type = 'comms_message'"),
    )
    op.create_foreign_key(
        'fk_in_app_notifications_comms_conversation', 'in_app_notifications',
        'comms_conversations', ['org_id', 'comms_conversation_id'], ['org_id', 'id'],
        ondelete='RESTRICT',
    )
    op.create_check_constraint(
        "ck_in_app_notifications_comms_reference", "in_app_notifications",
        "(subject_type = 'comms_message') = (comms_conversation_id IS NOT NULL)",
    )
    op.drop_constraint("ck_in_app_notifications_reference", "in_app_notifications", type_="check")
    op.create_check_constraint(
        "ck_in_app_notifications_reference", "in_app_notifications",
        PREVIOUS_REFERENCE + " OR "
        "(kind IN ('comms-mention','comms-direct','comms-thread-reply','comms-keyword') "
        "AND subject_type = 'comms_message' AND work_id IS NULL AND org_id IS NOT NULL)",
    )


def downgrade() -> None:
    # Refuse downgrade if Comms notices exist; never delete them to make an old schema fit.
    op.drop_constraint("ck_in_app_notifications_reference", "in_app_notifications", type_="check")
    op.create_check_constraint(
        "ck_in_app_notifications_reference", "in_app_notifications", PREVIOUS_REFERENCE,
    )
    op.drop_constraint(
        "ck_in_app_notifications_comms_reference", "in_app_notifications", type_="check",
    )
    op.drop_constraint(
        'fk_in_app_notifications_comms_conversation', 'in_app_notifications', type_='foreignkey',
    )
    op.drop_index(
        'uq_in_app_notifications_comms_recipient', table_name='in_app_notifications',
        postgresql_where=sa.text("subject_type = 'comms_message'"),
    )
    op.drop_column('in_app_notifications', 'comms_conversation_id')
    # ### end Alembic commands ###
