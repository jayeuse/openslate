"""comms moderation

Revision ID: 58464a7e16e7
Revises: 7270134f320d
Create Date: 2026-10-20 22:27:40.383007
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '58464a7e16e7'
down_revision: str | None = '7270134f320d'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Model-generated operations, with explicit bound-org RLS and the generation CHECK.
    op.create_table('comms_reports',
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('conversation_id', sa.Uuid(), nullable=False),
    sa.Column('message_id', sa.Uuid(), nullable=False),
    sa.Column('reporter_id', sa.UUID(), nullable=False),
    sa.Column('reason', sa.Text(), nullable=False),
    sa.Column('status', sa.Text(), server_default='open', nullable=False),
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True),
              server_default=sa.text('now()'), nullable=False),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('is_deleted', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True),
              server_default=sa.text('now()'), nullable=False),
    sa.Column('performed_by', sa.UUID(), nullable=True),
    sa.CheckConstraint("status IN ('open','resolved')", name='ck_comms_reports_status'),
    sa.CheckConstraint('char_length(btrim(reason)) BETWEEN 1 AND 2000',
                       name='ck_comms_reports_reason'),
    sa.ForeignKeyConstraint(
        ['org_id', 'conversation_id', 'message_id'],
        ['comms_messages.org_id', 'comms_messages.conversation_id', 'comms_messages.id'],
        name='fk_comms_reports_message', ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'],
                           name=op.f('fk_comms_reports_org_id_organizations'), ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['performed_by'], ['users.id'],
                           name=op.f('fk_comms_reports_performed_by_users'),
                           ondelete='SET NULL', use_alter=True),
    sa.ForeignKeyConstraint(['reporter_id'], ['users.id'],
                           name=op.f('fk_comms_reports_reporter_id_users'), ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id', name=op.f('comms_reports_pkey')),
    sa.UniqueConstraint('org_id', 'id', name='uq_comms_reports_org_id_id')
    )
    op.create_index('ix_comms_reports_queue', 'comms_reports',
                    ['org_id', 'created_at', 'id'], unique=False)
    op.create_index('ix_comms_reports_reporter', 'comms_reports', ['reporter_id'], unique=False)
    op.create_foreign_key(
        "fk_comms_reports_performed_by_users", "comms_reports", "users",
        ["performed_by"], ["id"], ondelete="SET NULL",
    )
    op.create_index('ix_comms_reports_source', 'comms_reports',
                    ['org_id', 'conversation_id', 'message_id'], unique=False)
    op.add_column('comms_messages', sa.Column(
        'mutation_generation', sa.BigInteger(), server_default=sa.text('0'), nullable=False,
    ))
    op.create_check_constraint(
        "ck_comms_messages_mutation_generation", "comms_messages",
        "mutation_generation BETWEEN 0 AND 9007199254740991",
    )
    op.execute("ALTER TABLE public.comms_reports ENABLE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY organization_rows ON public.comms_reports TO openslate_app
        USING (org_id = nullif(current_setting('openslate.org_id', true), '')::uuid)
        WITH CHECK (org_id = nullif(current_setting('openslate.org_id', true), '')::uuid)
    """)


def downgrade() -> None:
    # Do not silently discard reported content when moving to an older application.
    op.execute("""
        DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM public.comms_reports) THEN
                RAISE EXCEPTION 'Comms reports prevent downgrade';
            END IF;
        END $$
    """)
    op.drop_constraint("ck_comms_messages_mutation_generation", "comms_messages", type_="check")
    op.drop_column('comms_messages', 'mutation_generation')
    op.drop_index('ix_comms_reports_source', table_name='comms_reports')
    op.drop_index('ix_comms_reports_reporter', table_name='comms_reports')
    op.drop_index('ix_comms_reports_queue', table_name='comms_reports')
    op.drop_table('comms_reports')
    # ### end Alembic commands ###
