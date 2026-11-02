"""slate operations fresh root

Revision ID: e46611902f25
Revises:
Create Date: 2026-11-02 17:28:17.903262
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e46611902f25"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Objects that autogenerate does not create. They reproduce the schema of the archived
# organization root at its head (013f822298e6), with the slateops names.

FUNCTIONS = (
    r"""
CREATE OR REPLACE FUNCTION public.board_record_link_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE owner_board uuid; source_module uuid;
        BEGIN
            IF TG_OP = 'UPDATE' AND (
                OLD.org_id IS DISTINCT FROM NEW.org_id OR
                OLD.board_id IS DISTINCT FROM NEW.board_id OR
                OLD.event_id IS DISTINCT FROM NEW.event_id OR
                OLD.post_id IS DISTINCT FROM NEW.post_id OR OLD.card_id IS DISTINCT FROM
                    NEW.card_id OR
                OLD.record_id IS DISTINCT FROM NEW.record_id OR
                OLD.module_id IS DISTINCT FROM NEW.module_id
            ) THEN
                RAISE EXCEPTION 'Board Record link owner is immutable' USING ERRCODE =
                    '23514';
            END IF;
            IF NEW.event_id IS NOT NULL THEN
                SELECT board_id INTO owner_board FROM public.board_events
                WHERE org_id = NEW.org_id AND id = NEW.event_id;
            ELSIF NEW.card_id IS NOT NULL THEN SELECT board_id INTO owner_board FROM
                public.board_cards WHERE org_id = NEW.org_id AND id = NEW.card_id;
            ELSE
                SELECT board_id INTO owner_board FROM public.board_posts
                WHERE org_id = NEW.org_id AND id = NEW.post_id;
            END IF;
            SELECT module_id INTO source_module FROM public.records
            WHERE org_id = NEW.org_id AND id = NEW.record_id;
            IF owner_board IS DISTINCT FROM NEW.board_id OR
               source_module IS DISTINCT FROM NEW.module_id THEN
                RAISE EXCEPTION 'Board Record link parent mismatch' USING ERRCODE =
                    '23514';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.board_record_link_guard() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.board_revision_record_link_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE source_module uuid; current_link uuid;
        BEGIN
            IF TG_OP = 'UPDATE' THEN
                RAISE EXCEPTION 'Published Board Record links are immutable'
                    USING ERRCODE = '23514';
            END IF;
            SELECT module_id INTO source_module FROM public.records
            WHERE org_id = NEW.org_id AND id = NEW.record_id;
            SELECT link.id INTO current_link
            FROM public.board_record_links AS link
            JOIN public.board_post_revisions AS revision
              ON revision.org_id = link.org_id AND revision.post_id = link.post_id
            WHERE revision.org_id = NEW.org_id AND revision.id = NEW.revision_id
              AND link.record_id = NEW.record_id AND link.module_id = NEW.module_id;
            IF source_module IS DISTINCT FROM NEW.module_id OR current_link IS NULL THEN
                RAISE EXCEPTION 'Published Board Record link parent mismatch'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.board_revision_record_link_guard() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.can_join_realtime_topic(topic text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
    claims jsonb;
    claimed_org uuid;
    claimed_user uuid;
    prefix text;
BEGIN
    claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
    IF claims IS NULL OR pg_catalog.jsonb_typeof(claims) <> 'object'
       OR claims ->> 'purpose' IS DISTINCT FROM 'realtime'
       OR claims ->> 'role' IS DISTINCT FROM 'authenticated' THEN
        RETURN false;
    END IF;
    claimed_org := (claims ->> 'org_id')::uuid;
    claimed_user := (claims ->> 'sub')::uuid;
    IF topic IS NULL OR claimed_org IS NULL OR claimed_user IS NULL THEN
        RETURN false;
    END IF;
    prefix := 'org:' || claimed_org::text || ':';
    IF NOT pg_catalog.starts_with(topic, prefix)
       OR pg_catalog.length(topic) <= pg_catalog.length(prefix) THEN
        RETURN false;
    END IF;
    IF topic = prefix || 'probe' OR topic = prefix || 'presence'
       OR topic = prefix || 'user:' || claimed_user::text THEN
        NULL;
    ELSIF pg_catalog.starts_with(topic, prefix || 'conversation:') THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.comms_realtime_grants AS g
             JOIN public.comms_conversations AS c
               ON c.org_id = g.org_id AND c.id = g.conversation_id
            WHERE g.org_id = claimed_org AND g.user_id = claimed_user
              AND can_join_realtime_topic.topic =
                  prefix || 'conversation:' || g.conversation_id::text
              AND g.expires_at > pg_catalog.now()
              AND c.is_deleted IS FALSE AND c.deleted_at IS NULL
              AND c.archived_at IS NULL
        ) THEN
            RETURN false;
        END IF;
    ELSE
        RETURN false;
    END IF;
    RETURN EXISTS (
        SELECT 1
          FROM public.memberships AS m
          JOIN public.users AS u ON u.id = m.user_id
          JOIN public.organizations AS o ON o.id = m.org_id
         WHERE m.org_id = claimed_org
           AND m.user_id = claimed_user
           AND m.is_deleted IS FALSE
           AND m.status = 'active'
           AND (m.invitation_accepted_at IS NOT NULL OR m.invitation_sent_at IS NULL)
           AND (m.expires_at IS NULL OR m.expires_at > pg_catalog.now())
           AND u.status = 'active'
           AND u.is_deleted IS FALSE
           AND o.is_deleted IS FALSE
    );
EXCEPTION
    WHEN invalid_text_representation THEN
        RETURN false;
END;
$$;
ALTER FUNCTION public.can_join_realtime_topic(topic text) OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.guard_comms_message_revision() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
        BEGIN
            IF TG_OP = 'UPDATE' THEN
                RAISE EXCEPTION 'message revisions are immutable'
                    USING ERRCODE = '23514',
                          CONSTRAINT = 'ck_comms_message_revisions_immutable';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM public.comms_messages AS message
                WHERE message.org_id = NEW.org_id AND message.id = NEW.message_id
            ) THEN
                RAISE EXCEPTION 'message revision parent organization mismatch'
                    USING ERRCODE = '23514',
                          CONSTRAINT = 'ck_comms_message_revisions_parent_org';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.guard_comms_message_revision() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.guard_comms_retention_erasure() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
        BEGIN
            IF OLD.retention_erased_at IS NOT NULL
               AND NEW.retention_erased_at IS DISTINCT FROM OLD.retention_erased_at THEN
                RAISE EXCEPTION 'Retention erasure is irreversible'
                    USING ERRCODE='23514', CONSTRAINT='ck_comms_retention_irreversible';
            END IF;
            RETURN NEW;
        END $$;
ALTER FUNCTION public.guard_comms_retention_erasure() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.guard_erased_comms_revision() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
        BEGIN
            IF EXISTS (SELECT 1 FROM public.comms_messages
                       WHERE org_id=NEW.org_id AND id=NEW.message_id
                         AND retention_erased_at IS NOT NULL) THEN
                RAISE EXCEPTION 'Expired content cannot acquire revisions'
                    USING ERRCODE='23514', CONSTRAINT='ck_comms_retention_revision';
            END IF;
            RETURN NEW;
        END $$;
ALTER FUNCTION public.guard_erased_comms_revision() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.reject_board_attachment_owner_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            IF OLD.org_id IS DISTINCT FROM NEW.org_id
                OR OLD.board_id IS DISTINCT FROM NEW.board_id
                OR OLD.file_id IS DISTINCT FROM NEW.file_id
                OR OLD.card_id IS DISTINCT FROM NEW.card_id OR
                OLD.event_id IS DISTINCT FROM NEW.event_id
                OR OLD.post_id IS DISTINCT FROM NEW.post_id THEN
                RAISE EXCEPTION 'board file content owner is immutable'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.reject_board_attachment_owner_change() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.reject_board_post_revision_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION 'published post revisions are immutable'
                USING ERRCODE = 'check_violation';
        END;
        $$;
ALTER FUNCTION public.reject_board_post_revision_update() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.reject_comms_message_attachment_owner_change() RETURNS
    trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
        BEGIN
            IF OLD.org_id IS DISTINCT FROM NEW.org_id
                OR OLD.message_id IS DISTINCT FROM NEW.message_id
                OR OLD.file_id IS DISTINCT FROM NEW.file_id THEN
                RAISE EXCEPTION 'message attachment owner is immutable'
                    USING ERRCODE = '23514',
                          CONSTRAINT = 'ck_comms_message_attachments_owner_immutable';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.reject_comms_message_attachment_owner_change() OWNER TO
    slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.reject_comms_message_fingerprint_change() RETURNS
    trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
        BEGIN
            IF OLD.send_fingerprint IS DISTINCT FROM NEW.send_fingerprint THEN
                RAISE EXCEPTION 'original message fingerprint is immutable'
                    USING ERRCODE = '23514',
                          CONSTRAINT = 'ck_comms_messages_fingerprint_immutable';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.reject_comms_message_fingerprint_change() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.reject_file_board_move() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            IF OLD.org_id IS DISTINCT FROM NEW.org_id OR
               OLD.board_id IS DISTINCT FROM NEW.board_id THEN
                RAISE EXCEPTION 'file board ownership is immutable'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.reject_file_board_move() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.reject_revision_attachment_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION 'published attachment snapshots are immutable'
                USING ERRCODE = 'check_violation';
        END;
        $$;
ALTER FUNCTION public.reject_revision_attachment_update() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.retain_security_events() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "TimeZone" TO 'UTC'
    AS $$
        DECLARE
            platform_days integer;
            as_of timestamptz;
            cutoff timestamptz;
            total_deleted integer := 0;
            deleted_scope record;
            proof_id uuid;
            operation_id uuid;
        BEGIN
            IF NOT pg_catalog.pg_try_advisory_xact_lock(22328052256015694::bigint) THEN
                RETURN 0;
            END IF;
            SELECT p.security_event_retention_days INTO STRICT platform_days
            FROM public.platform_settings AS p WHERE p.singleton_key IS TRUE FOR SHARE;
            PERFORM o.id FROM public.organizations AS o ORDER BY o.id FOR SHARE;
            as_of := pg_catalog.transaction_timestamp();
            FOR deleted_scope IN
                WITH candidates AS (
                    SELECT e.id FROM public.security_events AS e
                    LEFT JOIN public.organizations AS o ON o.id = e.org_id
                    WHERE e.occurred_at < as_of - pg_catalog.make_interval(
                        days => CASE WHEN e.org_id IS NULL THEN platform_days
                                     ELSE o.security_event_retention_days END
                    )
                    ORDER BY e.occurred_at, e.id LIMIT 1000 FOR UPDATE OF e SKIP LOCKED
                ), deleted AS (
                    DELETE FROM public.security_events AS e USING candidates AS c
                    WHERE e.id = c.id RETURNING e.org_id
                )
                SELECT d.org_id, pg_catalog.count(*) AS deleted_events,
                       CASE WHEN d.org_id IS NULL THEN platform_days
                            ELSE o.security_event_retention_days END AS retention_days
                FROM deleted AS d
                LEFT JOIN public.organizations AS o ON o.id = d.org_id
                GROUP BY d.org_id, o.security_event_retention_days
            LOOP
                cutoff := as_of - pg_catalog.make_interval(days =>
                    deleted_scope.retention_days);
                proof_id := pg_catalog.gen_random_uuid();
                operation_id := pg_catalog.gen_random_uuid();
                IF proof_id = operation_id THEN
                    RAISE EXCEPTION
                        'Unable to generate independent retention proof identifiers';
                END IF;
                INSERT INTO public.security_events (
                    id, org_id, occurred_at, event_type, outcome, source, operation_id,
                    actor_id, subject_id, labels, fingerprint, reason,
                    request_id, request_method, request_path, metadata
                ) VALUES (
                    proof_id, deleted_scope.org_id, as_of, 'security.retention',
                        'success',
                    'security.event_retention', operation_id,
                    NULL, NULL, '{}'::jsonb, NULL, NULL, NULL, NULL, NULL,
                    pg_catalog.jsonb_build_object(
                        'scope', 'security_events', 'retention_days',
                            deleted_scope.retention_days,
                        'batch_limit', 1000, 'as_of', as_of, 'cutoff', cutoff,
                        'deleted_events', deleted_scope.deleted_events
                    )
                );
                total_deleted := total_deleted + deleted_scope.deleted_events;
            END LOOP;
            RETURN total_deleted;
        END;
        $$;
ALTER FUNCTION public.retain_security_events() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.validate_board_attachment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
            ELSIF NEW.card_id IS NOT NULL THEN SELECT board_id INTO content_board FROM
                public.board_cards WHERE org_id = NEW.org_id AND id = NEW.card_id;
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
        $$;
ALTER FUNCTION public.validate_board_attachment() OWNER TO slateops_owner;
""",
    r"""
CREATE OR REPLACE FUNCTION public.validate_revision_attachment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE content_id uuid;
        BEGIN
            SELECT post_id INTO content_id FROM public.board_post_revisions
            WHERE org_id = NEW.org_id AND id = NEW.revision_id;
            IF NOT EXISTS (
                SELECT 1 FROM public.board_attachments AS a
                WHERE a.org_id = NEW.org_id AND a.file_id = NEW.file_id
                  AND a.post_id = content_id
            ) THEN
                RAISE EXCEPTION 'published file has a different content owner'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$;
ALTER FUNCTION public.validate_revision_attachment() OWNER TO slateops_owner;
SET default_tablespace = '';
SET default_table_access_method = heap;
""",
)

# Alembic renders use_alter declarations but does not emit their later CREATEs.

DEFERRED_FOREIGN_KEYS = (
    r"""
ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT fk_audit_logs_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.backup_export_operations
    ADD CONSTRAINT fk_backup_export_operations_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.backup_policies
    ADD CONSTRAINT fk_backup_policies_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.backup_runs
    ADD CONSTRAINT fk_backup_runs_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_attachments
    ADD CONSTRAINT fk_board_attachments_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_calendar_sources
    ADD CONSTRAINT fk_board_calendar_sources_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_card_checklist_items
    ADD CONSTRAINT fk_board_card_checklist_items_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_card_labels
    ADD CONSTRAINT fk_board_card_labels_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_cards
    ADD CONSTRAINT fk_board_cards_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_event_reminders
    ADD CONSTRAINT fk_board_event_reminders_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_events
    ADD CONSTRAINT fk_board_events_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_groups
    ADD CONSTRAINT fk_board_groups_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_labels
    ADD CONSTRAINT fk_board_labels_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_post_revision_attachments
    ADD CONSTRAINT fk_board_post_revision_attachments_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_post_revision_record_links
    ADD CONSTRAINT fk_board_post_revision_record_links_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_post_revisions
    ADD CONSTRAINT fk_board_post_revisions_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_posts
    ADD CONSTRAINT fk_board_posts_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_record_links
    ADD CONSTRAINT fk_board_record_links_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.board_stages
    ADD CONSTRAINT fk_board_stages_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.boards
    ADD CONSTRAINT fk_boards_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.charts
    ADD CONSTRAINT fk_charts_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_capability_grants
    ADD CONSTRAINT fk_comms_capability_grants_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_categories
    ADD CONSTRAINT fk_comms_categories_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_channel_access
    ADD CONSTRAINT fk_comms_channel_access_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_conversation_counters
    ADD CONSTRAINT fk_comms_conversation_counters_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_conversations
    ADD CONSTRAINT fk_comms_conversations_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_direct_blocks
    ADD CONSTRAINT fk_comms_direct_blocks_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_expired_sends
    ADD CONSTRAINT fk_comms_expired_sends_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_export_entries
    ADD CONSTRAINT fk_comms_export_entries_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_export_sources
    ADD CONSTRAINT fk_comms_export_sources_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_exports
    ADD CONSTRAINT fk_comms_exports_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_member_preferences
    ADD CONSTRAINT fk_comms_member_preferences_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_members
    ADD CONSTRAINT fk_comms_members_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_mentions
    ADD CONSTRAINT fk_comms_mentions_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_message_attachments
    ADD CONSTRAINT fk_comms_message_attachments_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_message_record_links
    ADD CONSTRAINT fk_comms_message_record_links_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_message_revisions
    ADD CONSTRAINT fk_comms_message_revisions_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_messages
    ADD CONSTRAINT fk_comms_messages_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_personal_preferences
    ADD CONSTRAINT fk_comms_personal_preferences_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_reactions
    ADD CONSTRAINT fk_comms_reactions_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_read_states
    ADD CONSTRAINT fk_comms_read_states_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_reports
    ADD CONSTRAINT fk_comms_reports_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_retention_policies
    ADD CONSTRAINT fk_comms_retention_policies_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_retention_sweeps
    ADD CONSTRAINT fk_comms_retention_sweeps_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_schedules
    ADD CONSTRAINT fk_comms_schedules_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_setting_locks
    ADD CONSTRAINT fk_comms_setting_locks_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_settings
    ADD CONSTRAINT fk_comms_settings_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_templates
    ADD CONSTRAINT fk_comms_templates_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_thread_follows
    ADD CONSTRAINT fk_comms_thread_follows_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.comms_threads
    ADD CONSTRAINT fk_comms_threads_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.dashboard_widgets
    ADD CONSTRAINT fk_dashboard_widgets_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.dashboards
    ADD CONSTRAINT fk_dashboards_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.departments
    ADD CONSTRAINT fk_departments_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.fields
    ADD CONSTRAINT fk_fields_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.files
    ADD CONSTRAINT fk_files_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.group_access
    ADD CONSTRAINT fk_group_access_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT fk_group_members_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.groups
    ADD CONSTRAINT fk_groups_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.in_app_notifications
    ADD CONSTRAINT fk_in_app_notifications_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT fk_memberships_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.modules
    ADD CONSTRAINT fk_modules_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.modules
    ADD CONSTRAINT fk_modules_title_field_id_fields FOREIGN KEY (org_id, title_field_id)
        REFERENCES public.fields(org_id, id) ON DELETE RESTRICT;
""",
    r"""
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT fk_organizations_logo_file_id_files FOREIGN KEY (id, logo_file_id)
        REFERENCES public.files(org_id, id) ON DELETE RESTRICT;
""",
    r"""
ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT fk_organizations_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.platform_operators
    ADD CONSTRAINT fk_platform_operators_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT fk_platform_settings_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.record_trigger_actions
    ADD CONSTRAINT fk_record_trigger_actions_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.record_trigger_conditions
    ADD CONSTRAINT fk_record_trigger_conditions_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.record_trigger_events
    ADD CONSTRAINT fk_record_trigger_events_performed_by_users FOREIGN KEY
        (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.record_trigger_events
    ADD CONSTRAINT fk_record_trigger_events_root_event_id_record_trigger_events FOREIGN
        KEY (org_id, root_event_id) REFERENCES public.record_trigger_events(org_id, id)
        ON DELETE RESTRICT;
""",
    r"""
ALTER TABLE ONLY public.record_trigger_runs
    ADD CONSTRAINT fk_record_trigger_runs_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.record_triggers
    ADD CONSTRAINT fk_record_triggers_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.record_triggers
    ADD CONSTRAINT fk_record_triggers_publisher_id_users FOREIGN KEY (publisher_id)
        REFERENCES public.users(id) ON DELETE RESTRICT;
""",
    r"""
ALTER TABLE ONLY public.records
    ADD CONSTRAINT fk_records_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.relationship_edges
    ADD CONSTRAINT fk_relationship_edges_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.report_run_rows
    ADD CONSTRAINT fk_report_run_rows_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.report_runs
    ADD CONSTRAINT fk_report_runs_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT fk_report_schedules_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.reports
    ADD CONSTRAINT fk_reports_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.sandbox_bindings
    ADD CONSTRAINT fk_sandbox_bindings_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.sandbox_documents
    ADD CONSTRAINT fk_sandbox_documents_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.sandbox_publications
    ADD CONSTRAINT fk_sandbox_publications_actor_id_users FOREIGN KEY (actor_id)
        REFERENCES public.users(id) ON DELETE RESTRICT;
""",
    r"""
ALTER TABLE ONLY public.sandbox_publications
    ADD CONSTRAINT fk_sandbox_publications_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.sandbox_test_runs
    ADD CONSTRAINT fk_sandbox_test_runs_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT fk_sandbox_versions_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.sandbox_versions
    ADD CONSTRAINT fk_sandbox_versions_source_version_id_sandbox_versions FOREIGN KEY
        (org_id, source_version_id) REFERENCES public.sandbox_versions(org_id, id) ON
        DELETE RESTRICT;
""",
    r"""
ALTER TABLE ONLY public.saved_views
    ADD CONSTRAINT fk_saved_views_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.update_statuses
    ADD CONSTRAINT fk_update_statuses_performed_by_users FOREIGN KEY (performed_by)
        REFERENCES public.users(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_avatar_file_id_files FOREIGN KEY (avatar_file_id) REFERENCES
        public.files(id) ON DELETE SET NULL;
""",
    r"""
ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_performed_by_users FOREIGN KEY (performed_by) REFERENCES
        public.users(id) ON DELETE SET NULL;
""",
)

TRIGGERS = (
    r"""
CREATE TRIGGER board_record_link_guard_trigger BEFORE INSERT OR UPDATE ON
    public.board_record_links FOR EACH ROW EXECUTE FUNCTION
    public.board_record_link_guard();
""",
    r"""
CREATE TRIGGER board_revision_record_link_guard_trigger BEFORE INSERT OR UPDATE ON
    public.board_post_revision_record_links FOR EACH ROW EXECUTE FUNCTION
    public.board_revision_record_link_guard();
""",
    r"""
CREATE TRIGGER trg_board_attachment_immutable BEFORE UPDATE ON public.board_attachments
    FOR EACH ROW EXECUTE FUNCTION public.reject_board_attachment_owner_change();
""",
    r"""
CREATE TRIGGER trg_board_attachment_owner BEFORE INSERT OR UPDATE ON
    public.board_attachments FOR EACH ROW EXECUTE FUNCTION
    public.validate_board_attachment();
""",
    r"""
CREATE TRIGGER trg_board_post_revisions_immutable BEFORE UPDATE ON
    public.board_post_revisions FOR EACH ROW EXECUTE FUNCTION
    public.reject_board_post_revision_update();
""",
    r"""
CREATE TRIGGER trg_board_revision_attachment_immutable BEFORE UPDATE ON
    public.board_post_revision_attachments FOR EACH ROW EXECUTE FUNCTION
    public.reject_revision_attachment_update();
""",
    r"""
CREATE TRIGGER trg_board_revision_attachment_owner BEFORE INSERT ON
    public.board_post_revision_attachments FOR EACH ROW EXECUTE FUNCTION
    public.validate_revision_attachment();
""",
    r"""
CREATE TRIGGER trg_comms_message_attachment_owner BEFORE UPDATE ON
    public.comms_message_attachments FOR EACH ROW EXECUTE FUNCTION
    public.reject_comms_message_attachment_owner_change();
""",
    r"""
CREATE TRIGGER trg_comms_message_fingerprint_immutable BEFORE UPDATE ON
    public.comms_messages FOR EACH ROW EXECUTE FUNCTION
    public.reject_comms_message_fingerprint_change();
""",
    r"""
CREATE TRIGGER trg_comms_message_retention_erasure BEFORE UPDATE ON
    public.comms_messages FOR EACH ROW EXECUTE FUNCTION
    public.guard_comms_retention_erasure();
""",
    r"""
CREATE TRIGGER trg_comms_message_revision_immutable BEFORE INSERT OR UPDATE ON
    public.comms_message_revisions FOR EACH ROW EXECUTE FUNCTION
    public.guard_comms_message_revision();
""",
    r"""
CREATE TRIGGER trg_comms_retention_revision BEFORE INSERT ON
    public.comms_message_revisions FOR EACH ROW EXECUTE FUNCTION
    public.guard_erased_comms_revision();
""",
    r"""
CREATE TRIGGER trg_file_comms_retention_erasure BEFORE UPDATE ON public.files FOR EACH
    ROW EXECUTE FUNCTION public.guard_comms_retention_erasure();
""",
    r"""
CREATE TRIGGER trg_files_board_immutable BEFORE UPDATE ON public.files FOR EACH ROW
    EXECUTE FUNCTION public.reject_file_board_move();
""",
)

ROW_SECURITY = (
    r"""
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_attachments ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_calendar_sources ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_card_checklist_items ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_card_labels ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_cards ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_event_reminders ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_events ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_groups ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_labels ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_post_revision_attachments ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_post_revision_record_links ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_post_revisions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_posts ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_record_links ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.board_stages ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.boards ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.charts ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_capability_grants ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_categories ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_channel_access ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_conversation_counters ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_conversations ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_direct_blocks ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_expired_sends ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_export_entries ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_export_sources ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_exports ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_member_preferences ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_members ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_mentions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_message_attachments ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_message_record_links ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_message_revisions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_messages ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_personal_preferences ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_presence ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_reactions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_read_states ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_realtime_admissions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_realtime_grants ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_reports ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_retention_policies ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_retention_sweeps ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_schedules ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_setting_locks ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_settings ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_templates ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_thread_follows ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_threads ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.comms_typing ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.dashboard_widgets ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.dashboards ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.fields ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.group_access ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.in_app_notifications ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.lifecycle_confirmation_challenges ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.lifecycle_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.lifecycle_rate_limit_failures ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.modules ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.record_trigger_actions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.record_trigger_conditions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.record_trigger_events ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.record_trigger_runs ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.record_triggers ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.records ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.relationship_edges ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.report_run_eligible_users ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.report_run_rows ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.report_runs ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.sandbox_bindings ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.sandbox_documents ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.sandbox_publications ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.sandbox_test_runs ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.sandbox_versions ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.scheduled_work ENABLE ROW LEVEL SECURITY;
""",
    r"""
ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;
""",
)

POLICIES = (
    r"""
CREATE POLICY comms_presence_org_isolation ON public.comms_presence TO slateops_app
    USING ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY comms_realtime_admissions_org_isolation ON
    public.comms_realtime_admissions TO slateops_app USING ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid)) WITH
    CHECK ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid));
""",
    r"""
CREATE POLICY comms_realtime_grants_org_isolation ON public.comms_realtime_grants TO
    slateops_app USING ((org_id = (NULLIF(current_setting('slateops.org_id'::text,
    true), ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY comms_typing_org_isolation ON public.comms_typing TO slateops_app USING
    ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_appends ON public.audit_logs FOR INSERT TO slateops_app WITH
    CHECK (true);
""",
    r"""
CREATE POLICY organization_appends ON public.security_events FOR INSERT TO slateops_app
    WITH CHECK (true);
""",
    r"""
CREATE POLICY organization_rows ON public.audit_logs FOR SELECT TO slateops_app USING
    (((org_id IS NULL) OR (org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))));
""",
    r"""
CREATE POLICY organization_rows ON public.board_attachments TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_calendar_sources TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_card_checklist_items TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_card_labels TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_cards TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_event_reminders TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_events TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_groups TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_labels TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_post_revision_attachments TO
    slateops_app USING ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_post_revision_record_links TO
    slateops_app USING ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_post_revisions TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_posts TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_record_links TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.board_stages TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.boards TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.charts TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_capability_grants TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_categories TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_channel_access TO slateops_app USING
    ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_conversation_counters TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_conversations TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_direct_blocks TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_expired_sends TO slateops_app USING
    ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_export_entries TO slateops_app USING
    ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_export_sources TO slateops_app USING
    ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_exports TO slateops_app USING ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid)) WITH
    CHECK ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_member_preferences TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_members TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_mentions TO slateops_app USING ((org_id
    = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid
    AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_message_attachments TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_message_record_links TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_message_revisions TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_messages TO slateops_app USING ((org_id
    = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid
    AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_personal_preferences TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_reactions TO slateops_app USING ((org_id
    = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid
    AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_read_states TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_reports TO slateops_app USING ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid)) WITH
    CHECK ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_retention_policies TO slateops_app USING
    ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_retention_sweeps TO slateops_app USING
    ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid)) WITH CHECK ((org_id =
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_schedules TO slateops_app USING ((org_id
    = (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid)) WITH
    CHECK ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_setting_locks TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_settings TO slateops_app USING ((org_id
    = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid
    AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_templates TO slateops_app USING ((org_id
    = (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid)) WITH
    CHECK ((org_id = (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_thread_follows TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.comms_threads TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.dashboard_widgets TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.dashboards TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.departments TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.fields TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.files TO slateops_app USING (((org_id IS NULL)
    OR (org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif")))) WITH CHECK (((org_id IS NULL) OR (org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))));
""",
    r"""
CREATE POLICY organization_rows ON public.group_access TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.group_members TO slateops_app USING ((org_id =
    ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.groups TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.in_app_notifications TO slateops_app USING
    (((org_id IS NULL) OR (org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")))) WITH CHECK (((org_id IS NULL) OR (org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))));
""",
    r"""
CREATE POLICY organization_rows ON public.lifecycle_confirmation_challenges TO
    slateops_app USING ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.lifecycle_rate_limit_buckets TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.lifecycle_rate_limit_failures TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.modules TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.record_trigger_actions TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.record_trigger_conditions TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.record_trigger_events TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.record_trigger_runs TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.record_triggers TO slateops_app USING ((org_id
    = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid
    AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.records TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.relationship_edges TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.report_run_eligible_users TO slateops_app
    USING ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.report_run_rows TO slateops_app USING ((org_id
    = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid
    AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.report_runs TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.report_schedules TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.reports TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.sandbox_bindings TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.sandbox_documents TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.sandbox_publications TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.sandbox_test_runs TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.sandbox_versions TO slateops_app USING
    ((org_id = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true),
    ''::text))::uuid AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.saved_views TO slateops_app USING ((org_id = (
    SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.scheduled_work TO slateops_app USING ((org_id
    = ( SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid
    AS "nullif"))) WITH CHECK ((org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif")));
""",
    r"""
CREATE POLICY organization_rows ON public.security_events FOR SELECT TO slateops_app
    USING (((org_id IS NULL) OR (org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))));
""",
)

PRIVILEGES = (
    r"""
REVOKE ALL ON FUNCTION public.board_record_link_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.board_record_link_guard() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.board_revision_record_link_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.board_revision_record_link_guard() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.guard_comms_message_revision() FROM PUBLIC;
""",
    r"""
REVOKE ALL ON FUNCTION public.guard_comms_retention_erasure() FROM PUBLIC;
""",
    r"""
REVOKE ALL ON FUNCTION public.guard_erased_comms_revision() FROM PUBLIC;
""",
    r"""
REVOKE ALL ON FUNCTION public.reject_board_attachment_owner_change() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_board_attachment_owner_change() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.reject_board_post_revision_update() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_board_post_revision_update() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.reject_comms_message_attachment_owner_change() FROM
    PUBLIC;
""",
    r"""
REVOKE ALL ON FUNCTION public.reject_comms_message_fingerprint_change() FROM PUBLIC;
""",
    r"""
REVOKE ALL ON FUNCTION public.reject_file_board_move() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_file_board_move() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.reject_revision_attachment_update() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_revision_attachment_update() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.retain_security_events() FROM PUBLIC;
GRANT ALL ON FUNCTION public.retain_security_events() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.validate_board_attachment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_board_attachment() TO slateops_app;
""",
    r"""
REVOKE ALL ON FUNCTION public.validate_revision_attachment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_revision_attachment() TO slateops_app;
""",
    r"""
GRANT SELECT ON TABLE public.alembic_version TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT ON TABLE public.audit_logs TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.backup_export_operations TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.backup_policies TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.backup_runs TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_attachments TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_calendar_sources TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_card_checklist_items TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_card_labels TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_cards TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_event_reminders TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_events TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_groups TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_labels TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_post_revision_attachments TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_post_revision_record_links TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_post_revisions TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_posts TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_record_links TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.board_stages TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.boards TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.charts TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_capability_grants TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_categories TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_channel_access TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_conversation_counters TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_conversations TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_direct_blocks TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_expired_sends TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_export_entries TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_export_sources TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_exports TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_member_preferences TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_members TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_mentions TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_message_attachments TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_message_record_links TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_message_revisions TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_messages TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_personal_preferences TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_presence TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_reactions TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_read_states TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_realtime_admissions TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_realtime_grants TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_reports TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_retention_policies TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_retention_sweeps TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_schedules TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_setting_locks TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_settings TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_templates TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_thread_follows TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_threads TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.comms_typing TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.dashboard_widgets TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.dashboards TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.departments TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fields TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.files TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_access TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.group_members TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.groups TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.identity_mfa_observations TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.identity_rate_limit_buckets TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.identity_sessions TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.in_app_notifications TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lifecycle_confirmation_challenges TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lifecycle_rate_limit_buckets TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lifecycle_rate_limit_failures TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.memberships TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.modules TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_operators TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_settings TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.record_trigger_actions TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.record_trigger_conditions TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.record_trigger_events TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.record_trigger_runs TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.record_triggers TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.records TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.relationship_edges TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.report_run_eligible_users TO
    slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.report_run_rows TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.report_runs TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.report_schedules TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reports TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sandbox_bindings TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sandbox_documents TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sandbox_publications TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sandbox_test_runs TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sandbox_versions TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.saved_views TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.scheduled_work TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT ON TABLE public.security_events TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.update_statuses TO slateops_app;
""",
    r"""
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO slateops_app;
""",
    r"""
ALTER DEFAULT PRIVILEGES FOR ROLE slateops_owner IN SCHEMA public GRANT SELECT,USAGE ON
    SEQUENCES TO slateops_app;
""",
    r"""
ALTER DEFAULT PRIVILEGES FOR ROLE slateops_owner IN SCHEMA public GRANT
    SELECT,INSERT,DELETE,UPDATE ON TABLES TO slateops_app;
""",
)

DEFERRED_FOREIGN_KEY_NAMES = (
    ("audit_logs", "fk_audit_logs_performed_by_users"),
    ("backup_export_operations", "fk_backup_export_operations_performed_by_users"),
    ("backup_policies", "fk_backup_policies_performed_by_users"),
    ("backup_runs", "fk_backup_runs_performed_by_users"),
    ("board_attachments", "fk_board_attachments_performed_by_users"),
    ("board_calendar_sources", "fk_board_calendar_sources_performed_by_users"),
    ("board_card_checklist_items", "fk_board_card_checklist_items_performed_by_users"),
    ("board_card_labels", "fk_board_card_labels_performed_by_users"),
    ("board_cards", "fk_board_cards_performed_by_users"),
    ("board_event_reminders", "fk_board_event_reminders_performed_by_users"),
    ("board_events", "fk_board_events_performed_by_users"),
    ("board_groups", "fk_board_groups_performed_by_users"),
    ("board_labels", "fk_board_labels_performed_by_users"),
    ("board_post_revision_attachments", "fk_board_post_revision_attachments_performed_by_users"),
    ("board_post_revision_record_links", "fk_board_post_revision_record_links_performed_by_users"),
    ("board_post_revisions", "fk_board_post_revisions_performed_by_users"),
    ("board_posts", "fk_board_posts_performed_by_users"),
    ("board_record_links", "fk_board_record_links_performed_by_users"),
    ("board_stages", "fk_board_stages_performed_by_users"),
    ("boards", "fk_boards_performed_by_users"),
    ("charts", "fk_charts_performed_by_users"),
    ("comms_capability_grants", "fk_comms_capability_grants_performed_by_users"),
    ("comms_categories", "fk_comms_categories_performed_by_users"),
    ("comms_channel_access", "fk_comms_channel_access_performed_by_users"),
    ("comms_conversation_counters", "fk_comms_conversation_counters_performed_by_users"),
    ("comms_conversations", "fk_comms_conversations_performed_by_users"),
    ("comms_direct_blocks", "fk_comms_direct_blocks_performed_by_users"),
    ("comms_expired_sends", "fk_comms_expired_sends_performed_by_users"),
    ("comms_export_entries", "fk_comms_export_entries_performed_by_users"),
    ("comms_export_sources", "fk_comms_export_sources_performed_by_users"),
    ("comms_exports", "fk_comms_exports_performed_by_users"),
    ("comms_member_preferences", "fk_comms_member_preferences_performed_by_users"),
    ("comms_members", "fk_comms_members_performed_by_users"),
    ("comms_mentions", "fk_comms_mentions_performed_by_users"),
    ("comms_message_attachments", "fk_comms_message_attachments_performed_by_users"),
    ("comms_message_record_links", "fk_comms_message_record_links_performed_by_users"),
    ("comms_message_revisions", "fk_comms_message_revisions_performed_by_users"),
    ("comms_messages", "fk_comms_messages_performed_by_users"),
    ("comms_personal_preferences", "fk_comms_personal_preferences_performed_by_users"),
    ("comms_reactions", "fk_comms_reactions_performed_by_users"),
    ("comms_read_states", "fk_comms_read_states_performed_by_users"),
    ("comms_reports", "fk_comms_reports_performed_by_users"),
    ("comms_retention_policies", "fk_comms_retention_policies_performed_by_users"),
    ("comms_retention_sweeps", "fk_comms_retention_sweeps_performed_by_users"),
    ("comms_schedules", "fk_comms_schedules_performed_by_users"),
    ("comms_setting_locks", "fk_comms_setting_locks_performed_by_users"),
    ("comms_settings", "fk_comms_settings_performed_by_users"),
    ("comms_templates", "fk_comms_templates_performed_by_users"),
    ("comms_thread_follows", "fk_comms_thread_follows_performed_by_users"),
    ("comms_threads", "fk_comms_threads_performed_by_users"),
    ("dashboard_widgets", "fk_dashboard_widgets_performed_by_users"),
    ("dashboards", "fk_dashboards_performed_by_users"),
    ("departments", "fk_departments_performed_by_users"),
    ("fields", "fk_fields_performed_by_users"),
    ("files", "fk_files_performed_by_users"),
    ("group_access", "fk_group_access_performed_by_users"),
    ("group_members", "fk_group_members_performed_by_users"),
    ("groups", "fk_groups_performed_by_users"),
    ("in_app_notifications", "fk_in_app_notifications_performed_by_users"),
    ("memberships", "fk_memberships_performed_by_users"),
    ("modules", "fk_modules_performed_by_users"),
    ("modules", "fk_modules_title_field_id_fields"),
    ("organizations", "fk_organizations_logo_file_id_files"),
    ("organizations", "fk_organizations_performed_by_users"),
    ("platform_operators", "fk_platform_operators_performed_by_users"),
    ("platform_settings", "fk_platform_settings_performed_by_users"),
    ("record_trigger_actions", "fk_record_trigger_actions_performed_by_users"),
    ("record_trigger_conditions", "fk_record_trigger_conditions_performed_by_users"),
    ("record_trigger_events", "fk_record_trigger_events_performed_by_users"),
    ("record_trigger_events", "fk_record_trigger_events_root_event_id_record_trigger_events"),
    ("record_trigger_runs", "fk_record_trigger_runs_performed_by_users"),
    ("record_triggers", "fk_record_triggers_performed_by_users"),
    ("record_triggers", "fk_record_triggers_publisher_id_users"),
    ("records", "fk_records_performed_by_users"),
    ("relationship_edges", "fk_relationship_edges_performed_by_users"),
    ("report_run_rows", "fk_report_run_rows_performed_by_users"),
    ("report_runs", "fk_report_runs_performed_by_users"),
    ("report_schedules", "fk_report_schedules_performed_by_users"),
    ("reports", "fk_reports_performed_by_users"),
    ("sandbox_bindings", "fk_sandbox_bindings_performed_by_users"),
    ("sandbox_documents", "fk_sandbox_documents_performed_by_users"),
    ("sandbox_publications", "fk_sandbox_publications_actor_id_users"),
    ("sandbox_publications", "fk_sandbox_publications_performed_by_users"),
    ("sandbox_test_runs", "fk_sandbox_test_runs_performed_by_users"),
    ("sandbox_versions", "fk_sandbox_versions_performed_by_users"),
    ("sandbox_versions", "fk_sandbox_versions_source_version_id_sandbox_versions"),
    ("saved_views", "fk_saved_views_performed_by_users"),
    ("update_statuses", "fk_update_statuses_performed_by_users"),
    ("users", "fk_users_avatar_file_id_files"),
    ("users", "fk_users_performed_by_users"),
)

ROOT_FUNCTIONS = (
    "board_record_link_guard()",
    "board_revision_record_link_guard()",
    "guard_comms_message_revision()",
    "guard_comms_retention_erasure()",
    "guard_erased_comms_revision()",
    "reject_board_attachment_owner_change()",
    "reject_board_post_revision_update()",
    "reject_comms_message_attachment_owner_change()",
    "reject_comms_message_fingerprint_change()",
    "reject_file_board_move()",
    "reject_revision_attachment_update()",
    "retain_security_events()",
    "validate_board_attachment()",
    "validate_revision_attachment()",
)


def upgrade() -> None:
    op.execute("""
        DO $fresh$
        BEGIN
            IF current_user <> 'slateops_owner' THEN
                RAISE EXCEPTION 'baseline requires slateops_owner';
            END IF;
            IF EXISTS (
                SELECT 1 FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relowner = current_user::regrole::oid
                  AND c.relkind IN ('r','p','v','m','f') AND c.relname <> 'alembic_version'
            ) THEN
                RAISE EXCEPTION 'baseline requires a fresh application schema';
            END IF;
        END $fresh$;
    """)
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "backup_policies",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("installation_id", sa.String(length=63), nullable=False),
        sa.Column("schedule", sa.String(length=8), server_default="disabled", nullable=False),
        sa.Column("retention_days", sa.Integer(), server_default=sa.text("30"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("next_due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("runner_last_seen_at", sa.DateTime(timezone=True), nullable=True),
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
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_policies_identity"
        ),
        sa.CheckConstraint(
            "schedule <> 'disabled' OR next_due_at IS NULL", name="ck_backup_policies_disabled_due"
        ),
        sa.CheckConstraint(
            "schedule IN ('disabled','daily','weekly')", name="ck_backup_policies_schedule"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_backup_policies_deletion_state"),
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_policies_live"),
        sa.CheckConstraint("retention_days IN (7,30,90)", name="ck_backup_policies_retention"),
        sa.CheckConstraint("revision >= 1", name="ck_backup_policies_revision"),
        sa.CheckConstraint("singleton_key = true", name="ck_backup_policies_singleton"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_backup_policies_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("backup_policies_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_backup_policies_singleton"),
    )
    op.create_table(
        "identity_rate_limit_buckets",
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("blocked_until", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("fingerprint", name=op.f("identity_rate_limit_buckets_pkey")),
    )
    op.create_index(
        op.f("ix_identity_rate_limit_buckets_window_started_at"),
        "identity_rate_limit_buckets",
        ["window_started_at"],
        unique=False,
    )
    op.create_table(
        "platform_settings",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "session_timeout_minutes", sa.Integer(), server_default=sa.text("60"), nullable=False
        ),
        sa.Column(
            "session_retention_days", sa.Integer(), server_default=sa.text("365"), nullable=False
        ),
        sa.Column(
            "security_event_retention_days",
            sa.Integer(),
            server_default=sa.text("365"),
            nullable=False,
        ),
        sa.Column(
            "password_min_length", sa.Integer(), server_default=sa.text("12"), nullable=False
        ),
        sa.Column(
            "password_require_mixed_case",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column(
            "password_require_number", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("session_absolute_lifetime_minutes", sa.Integer(), nullable=True),
        sa.Column("session_concurrent_limit", sa.Integer(), nullable=True),
        sa.Column(
            "login_failed_attempt_threshold",
            sa.Integer(),
            server_default=sa.text("5"),
            nullable=False,
        ),
        sa.Column(
            "login_window_minutes", sa.Integer(), server_default=sa.text("15"), nullable=False
        ),
        sa.Column(
            "login_cooldown_minutes", sa.Integer(), server_default=sa.text("15"), nullable=False
        ),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_platform_settings_deletion_state"),
        ),
        sa.CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_platform_settings_not_deleted"
        ),
        sa.CheckConstraint(
            "login_cooldown_minutes BETWEEN 1 AND 1440",
            name="ck_platform_settings_login_cooldown_minutes_range",
        ),
        sa.CheckConstraint(
            "login_failed_attempt_threshold BETWEEN 1 AND 100",
            name="ck_platform_settings_login_failed_attempt_threshold_range",
        ),
        sa.CheckConstraint(
            "login_window_minutes BETWEEN 1 AND 1440",
            name="ck_platform_settings_login_window_minutes_range",
        ),
        sa.CheckConstraint(
            "password_min_length BETWEEN 12 AND 128",
            name="ck_platform_settings_password_min_length",
        ),
        sa.CheckConstraint(
            "security_event_retention_days BETWEEN 1 AND 3650",
            name="ck_platform_settings_security_event_retention_days_range",
        ),
        sa.CheckConstraint(
            "session_absolute_lifetime_minutes IS NULL OR "
            "session_absolute_lifetime_minutes BETWEEN 1 AND 43200",
            name="ck_platform_settings_session_absolute_lifetime_minutes_range",
        ),
        sa.CheckConstraint(
            "session_concurrent_limit IS NULL OR session_concurrent_limit BETWEEN 1 AND 100",
            name="ck_platform_settings_session_concurrent_limit_range",
        ),
        sa.CheckConstraint(
            "session_retention_days BETWEEN 1 AND 3650",
            name="ck_platform_settings_session_retention_days_range",
        ),
        sa.CheckConstraint(
            "session_timeout_minutes IN (15, 30, 60, 480)",
            name="ck_platform_settings_session_timeout_minutes",
        ),
        sa.CheckConstraint("singleton_key = true", name="ck_platform_settings_singleton_key"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_platform_settings_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("platform_settings_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_platform_settings_singleton_key"),
    )
    op.create_table(
        "update_statuses",
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("latest_version", sa.String(length=40), nullable=True),
        sa.Column("release_url", sa.String(length=160), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
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
            "failure_code IS NULL OR failure_code IN "
            "('release_unavailable','release_invalid','release_timeout')",
            name="ck_update_statuses_failure_code",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_update_statuses_deletion_state"),
        ),
        sa.CheckConstraint(
            "(latest_version IS NULL AND release_url IS NULL AND observed_at IS "
            "NULL) OR (latest_version IS NOT NULL AND release_url IS NOT NULL AND "
            "observed_at IS NOT NULL)",
            name="ck_update_statuses_observation",
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_update_statuses_live"),
        sa.CheckConstraint(
            "observed_at IS NULL OR (checked_at IS NOT NULL AND checked_at >= observed_at)",
            name="ck_update_statuses_times",
        ),
        sa.CheckConstraint("singleton_key = true", name="ck_update_statuses_singleton"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_update_statuses_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("update_statuses_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_update_statuses_singleton"),
    )
    op.create_table(
        "users",
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("supabase_user_id", sa.Uuid(), nullable=True),
        sa.Column("username", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column(
            "theme_preference", sa.Text(), server_default=sa.text("'system'"), nullable=False
        ),
        sa.Column(
            "appearance",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text('\'{"motion": "system", "keyboard_shortcuts": true}\'::jsonb'),
            nullable=False,
        ),
        sa.Column("job_title", sa.String(length=200), nullable=True),
        sa.Column("phone", sa.String(length=32), nullable=True),
        sa.Column("bio", sa.String(length=280), nullable=True),
        sa.Column("avatar_file_id", sa.UUID(), nullable=True),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("tokens_valid_after", sa.DateTime(timezone=True), nullable=True),
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
            "CASE WHEN jsonb_typeof(appearance) = 'object' THEN (appearance ?& "
            "ARRAY['motion','keyboard_shortcuts'] AND appearance - "
            "ARRAY['motion','keyboard_shortcuts','timezone','date_format',"
            "'time_format','week_start','start_page'] "
            "= '{}'::jsonb AND appearance ->> 'motion' IN ('system','reduce') AND "
            "jsonb_typeof(appearance -> 'keyboard_shortcuts') = 'boolean' AND (NOT "
            "(appearance ? 'timezone') OR jsonb_typeof(appearance -> 'timezone') IN "
            "('string','null')) AND (NOT (appearance ? 'date_format') OR appearance "
            "->> 'date_format' IN ('organization','dmy','mdy','ymd')) AND (NOT "
            "(appearance ? 'time_format') OR appearance ->> 'time_format' IN "
            "('organization','12h','24h')) AND (NOT (appearance ? 'week_start') OR "
            "appearance ->> 'week_start' IN ('organization','monday','sunday')) AND "
            "(NOT (appearance ? 'start_page') OR appearance ->> 'start_page' IN "
            "('automatic','sandbox','boards','comms','access','openview','manage','platform'))) "
            "IS TRUE ELSE false END",
            name="ck_users_appearance",
        ),
        sa.CheckConstraint("status IN ('pending', 'active', 'disabled')", name="ck_users_status"),
        sa.CheckConstraint(
            "theme_preference IN ('light', 'dark', 'system')", name="ck_users_theme_preference"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_users_deletion_state"),
        ),
        sa.CheckConstraint(
            "email = lower(btrim(email)) AND length(email) > 0", name="ck_users_email_normalized"
        ),
        sa.ForeignKeyConstraint(
            ["avatar_file_id"],
            ["files.id"],
            name="fk_users_avatar_file_id_files",
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_users_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("users_pkey")),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )
    op.create_index(op.f("ix_users_avatar_file_id"), "users", ["avatar_file_id"], unique=False)
    op.create_index(op.f("ix_users_supabase_user_id"), "users", ["supabase_user_id"], unique=True)
    op.create_table(
        "backup_runs",
        sa.Column("installation_id", sa.String(length=63), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("provenance", sa.String(length=9), nullable=False),
        sa.Column("requester_id", sa.UUID(), nullable=True),
        sa.Column("idempotency_hash", sa.String(length=64), nullable=True),
        sa.Column("schedule", sa.String(length=8), nullable=False),
        sa.Column("retention_days", sa.Integer(), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state", sa.String(length=11), server_default="queued", nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=True),
        sa.Column("claimed_schedule", sa.String(length=8), nullable=True),
        sa.Column("claimed_retention_days", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reconciled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("snapshot_id", sa.String(length=64), nullable=True),
        sa.Column("manifest_sha256", sa.String(length=64), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
        sa.Column("expired_at", sa.DateTime(timezone=True), nullable=True),
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
            "(provenance = 'manual' AND idempotency_hash IS NOT NULL AND "
            "scheduled_for IS NULL) OR (provenance = 'scheduled' AND "
            "idempotency_hash IS NULL AND requester_id IS NULL AND scheduled_for IS "
            "NOT NULL)",
            name="ck_backup_runs_request",
        ),
        sa.CheckConstraint(
            "(snapshot_id IS NULL AND manifest_sha256 IS NULL AND verified_at IS "
            "NULL) OR (snapshot_id IS NOT NULL AND manifest_sha256 IS NOT NULL AND "
            "snapshot_id ~ '^[0-9a-f]{64}$' AND manifest_sha256 ~ '^[0-9a-f]{64}$' "
            "AND verified_at IS NOT NULL AND started_at IS NOT NULL)",
            name="ck_backup_runs_verification",
        ),
        sa.CheckConstraint(
            "(started_at IS NULL AND claim_id IS NULL AND claimed_schedule IS NULL "
            "AND claimed_retention_days IS NULL AND state = 'queued' AND "
            "finished_at IS NULL AND reconciled_at IS NULL) OR (started_at IS NOT "
            "NULL AND claim_id IS NOT NULL AND claimed_schedule IS NOT NULL AND "
            "claimed_retention_days IS NOT NULL AND claimed_schedule IN "
            "('disabled','daily','weekly') AND claimed_retention_days IN (7,30,90) "
            "AND state <> 'queued')",
            name="ck_backup_runs_claim",
        ),
        sa.CheckConstraint(
            "(state IN ('queued','running') AND finished_at IS NULL AND "
            "failure_code IS NULL AND reconciled_at IS NULL) OR (state = "
            "'succeeded' AND finished_at IS NOT NULL AND reconciled_at IS NOT NULL "
            "AND verified_at IS NOT NULL AND failure_code IS NULL) OR (state IN "
            "('failed','interrupted') AND finished_at IS NOT NULL AND failure_code "
            "IS NOT NULL)",
            name="ck_backup_runs_outcome",
        ),
        sa.CheckConstraint(
            "failure_code IS NULL OR failure_code IN "
            "('backup_failed','backup_interrupted','verification_failed',"
            "'restart_failed','readiness_failed','result_unconfirmed',"
            "'retention_failed')",
            name="ck_backup_runs_failure_code",
        ),
        sa.CheckConstraint(
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_runs_identity"
        ),
        sa.CheckConstraint(
            "length(name) BETWEEN 1 AND 120 AND name = btrim(name) AND name !~ '[[:cntrl:]]'",
            name="ck_backup_runs_name",
        ),
        sa.CheckConstraint(
            "provenance IN ('manual','scheduled')", name="ck_backup_runs_provenance"
        ),
        sa.CheckConstraint(
            "schedule IN ('disabled','daily','weekly')", name="ck_backup_runs_schedule"
        ),
        sa.CheckConstraint(
            "state IN ('queued','running','succeeded','failed','interrupted')",
            name="ck_backup_runs_state",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_backup_runs_deletion_state"),
        ),
        sa.CheckConstraint(
            "(started_at IS NULL OR started_at >= requested_at) AND (finished_at IS "
            "NULL OR finished_at >= started_at) AND (verified_at IS NULL OR "
            "verified_at BETWEEN started_at AND finished_at) AND (reconciled_at IS "
            "NULL OR reconciled_at >= finished_at) AND (expired_at IS NULL OR "
            "(verified_at IS NOT NULL AND reconciled_at IS NOT NULL AND expired_at "
            ">= verified_at))",
            name="ck_backup_runs_times",
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_runs_live"),
        sa.CheckConstraint("retention_days IN (7,30,90)", name="ck_backup_runs_retention"),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_backup_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_backup_runs_requester_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("backup_runs_pkey")),
        sa.UniqueConstraint("claim_id", name="uq_backup_runs_claim_id"),
        sa.UniqueConstraint(
            "installation_id", "requester_id", "idempotency_hash", name="uq_backup_runs_idempotency"
        ),
        sa.UniqueConstraint(
            "installation_id", "scheduled_for", name="uq_backup_runs_scheduled_occurrence"
        ),
    )
    op.create_index(
        "ix_backup_runs_queue",
        "backup_runs",
        ["installation_id", "state", "requested_at"],
        unique=False,
    )
    op.create_index("ix_backup_runs_requester_id", "backup_runs", ["requester_id"], unique=False)
    op.create_index(
        "uq_backup_runs_unresolved",
        "backup_runs",
        ["installation_id"],
        unique=True,
        postgresql_where=sa.text("started_at IS NOT NULL AND reconciled_at IS NULL"),
    )
    op.create_table(
        "identity_mfa_observations",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("observed_provider_user_id", sa.UUID(), nullable=True),
        sa.Column("verified_totp", sa.Boolean(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_sign_in_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_active_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "((observed_provider_user_id IS NULL AND verified_totp IS NULL AND "
            "observed_at IS NULL) OR (observed_provider_user_id IS NOT NULL AND "
            "observed_at IS NOT NULL)) IS TRUE",
            name="ck_identity_mfa_observations_authority",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_identity_mfa_observations_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("identity_mfa_observations_pkey")),
    )
    op.create_table(
        "organizations",
        sa.Column("slug", sa.String(length=200), nullable=False),
        sa.Column("owner_user_id", sa.UUID(), nullable=True),
        sa.Column("display_name", sa.String(length=200), nullable=False),
        sa.Column("legal_name", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("contact_email", sa.String(length=254), nullable=True),
        sa.Column("contact_phone", sa.String(length=50), nullable=True),
        sa.Column("postal_address", sa.Text(), nullable=True),
        sa.Column("logo_file_id", sa.Uuid(), nullable=True),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.Column("locale", sa.String(length=35), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default=sa.text("'PHP'"), nullable=False),
        sa.Column(
            "week_start", sa.String(length=6), server_default=sa.text("'monday'"), nullable=False
        ),
        sa.Column(
            "business_hours",
            sa.String(length=200),
            server_default=sa.text("'09:00–18:00'"),
            nullable=False,
        ),
        sa.Column("mark", sa.String(length=32), server_default=sa.text("'RS'"), nullable=False),
        sa.Column("theme", sa.String(length=16), server_default=sa.text("'slate'"), nullable=False),
        sa.Column(
            "security_event_retention_days",
            sa.Integer(),
            server_default=sa.text("365"),
            nullable=False,
        ),
        sa.Column(
            "mfa_require_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "mfa_require_member", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column(
            "mfa_require_guest", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("mfa_grace_days", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "ip_allow_list",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "invitation_expiry_days", sa.Integer(), server_default=sa.text("7"), nullable=False
        ),
        sa.Column(
            "guest_duration_days", sa.Integer(), server_default=sa.text("30"), nullable=False
        ),
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
        sa.CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_workspace_profiles_currency"),
        sa.CheckConstraint(
            "jsonb_typeof(ip_allow_list) = 'array'", name="ck_workspace_profiles_ip_allow_list"
        ),
        sa.CheckConstraint("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'", name="ck_organizations_slug"),
        sa.CheckConstraint(
            "theme IN ('slate', 'whiteboard', 'triplicate', 'stockroom')",
            name="ck_workspace_profiles_theme",
        ),
        sa.CheckConstraint(
            "week_start IN ('monday', 'sunday')", name="ck_workspace_profiles_week_start"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_organizations_deletion_state"),
        ),
        sa.CheckConstraint(
            "business_hours = btrim(business_hours)",
            name="ck_workspace_profiles_business_hours_trimmed",
        ),
        sa.CheckConstraint(
            "guest_duration_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_guest_duration_days_range",
        ),
        sa.CheckConstraint(
            "invitation_expiry_days BETWEEN 1 AND 365",
            name="ck_workspace_profiles_invitation_expiry_days_range",
        ),
        sa.CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_workspace_profiles_not_deleted"
        ),
        sa.CheckConstraint("mark = btrim(mark)", name="ck_workspace_profiles_mark_trimmed"),
        sa.CheckConstraint(
            "mfa_grace_days BETWEEN 0 AND 30", name="ck_workspace_profiles_mfa_grace_days_range"
        ),
        sa.CheckConstraint(
            "security_event_retention_days BETWEEN 1 AND 3650",
            name="ck_workspace_profiles_security_event_retention_days_range",
        ),
        sa.ForeignKeyConstraint(
            ["id", "logo_file_id"],
            ["files.org_id", "files.id"],
            name="fk_organizations_logo_file_id_files",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["owner_user_id"],
            ["users.id"],
            name=op.f("fk_organizations_owner_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_organizations_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("organizations_pkey")),
        sa.UniqueConstraint("slug", name="uq_organizations_slug"),
    )
    op.create_table(
        "platform_operators",
        sa.Column("user_id", sa.UUID(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_platform_operators_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_platform_operators_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_platform_operators_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("platform_operators_pkey")),
        sa.UniqueConstraint("user_id", name="uq_platform_operators_user_id"),
    )
    op.create_table(
        "audit_logs",
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(length=50), nullable=False),
        sa.Column("entity_type", sa.String(length=50), nullable=False),
        sa.Column("entity_id", sa.UUID(), nullable=True),
        sa.Column("department_id", sa.UUID(), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("request_method", sa.String(length=10), nullable=True),
        sa.Column("request_path", sa.Text(), nullable=True),
        sa.Column("actor_label", sa.String(length=100), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint("action IN ('create', 'update', 'delete')", name="ck_audit_logs_action"),
        sa.CheckConstraint(
            "org_id IS NOT NULL OR entity_type IN "
            "('users','platform_settings','platform_operators','backup_policies',"
            "'backup_runs','backup_export_operations','update_statuses') "
            'OR COALESCE((COALESCE(NULLIF("after", \'null\'::jsonb), "before") -> '
            "'org_id' = 'null'::jsonb AND ((entity_type = 'files' AND "
            "COALESCE(NULLIF(\"after\", 'null'::jsonb), \"before\") ->> 'purpose' = "
            "'user_avatar') OR (entity_type = 'in_app_notifications' AND "
            "COALESCE(NULLIF(\"after\", 'null'::jsonb), \"before\") ->> 'kind' = "
            "'backup-failed'))), false)",
            name="ck_audit_logs_organization",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_audit_logs_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_audit_logs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("audit_logs_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_audit_logs_org_id_id"),
    )
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"], unique=False)
    op.create_index(
        "ix_audit_logs_actor", "audit_logs", ["performed_by", "created_at"], unique=False
    )
    op.create_index("ix_audit_logs_created_at_id", "audit_logs", ["created_at", "id"], unique=False)
    op.create_index(
        "ix_audit_logs_department_created_at_id",
        "audit_logs",
        ["department_id", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_audit_logs_entity",
        "audit_logs",
        ["entity_type", "entity_id", "created_at"],
        unique=False,
    )
    op.create_index("ix_audit_logs_request", "audit_logs", ["request_id"], unique=False)
    op.create_table(
        "backup_export_operations",
        sa.Column("installation_id", sa.String(length=63), nullable=False),
        sa.Column("backup_run_id", sa.UUID(), nullable=False),
        sa.Column("requester_id", sa.UUID(), nullable=True),
        sa.Column("idempotency_hash", sa.String(length=64), nullable=False),
        sa.Column("payload_hmac", sa.String(length=64), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(length=11), server_default="queued", nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("encrypted_passphrase", sa.String(length=2048), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("failure_code", sa.String(length=32), nullable=True),
        sa.Column("artifact_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("admission_digest", sa.String(length=64), nullable=True),
        sa.Column("admission_actor_id", sa.Uuid(), nullable=True),
        sa.Column("admission_session_id", sa.Uuid(), nullable=True),
        sa.Column("admission_expires_at", sa.DateTime(timezone=True), nullable=True),
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
            "(admission_digest IS NULL AND admission_actor_id IS NULL AND "
            "admission_session_id IS NULL AND admission_expires_at IS NULL) OR "
            "(state = 'ready' AND artifact_deleted_at IS NULL AND admission_digest "
            "IS NOT NULL AND admission_digest ~ '^[0-9a-f]{64}$' AND "
            "admission_actor_id IS NOT NULL AND admission_session_id IS NOT NULL "
            "AND admission_expires_at IS NOT NULL AND admission_expires_at <= "
            "expires_at)",
            name="ck_backup_exports_admission",
        ),
        sa.CheckConstraint(
            "(state = 'queued' AND claim_id IS NULL AND claimed_at IS NULL AND "
            "encrypted_passphrase IS NOT NULL) OR (state <> 'queued' AND claim_id "
            "IS NOT NULL AND claimed_at IS NOT NULL AND encrypted_passphrase IS "
            "NULL)",
            name="ck_backup_exports_claim",
        ),
        sa.CheckConstraint(
            "(state = 'ready' AND ready_at IS NOT NULL AND expires_at IS NOT NULL "
            "AND size_bytes IS NOT NULL AND size_bytes > 0 AND sha256 IS NOT NULL "
            "AND sha256 ~ '^[0-9a-f]{64}$' AND expires_at = ready_at + interval '24 "
            "hours') OR (state <> 'ready' AND ready_at IS NULL AND expires_at IS "
            "NULL AND size_bytes IS NULL AND sha256 IS NULL)",
            name="ck_backup_exports_artifact",
        ),
        sa.CheckConstraint(
            "(state IN ('queued','preparing') AND finished_at IS NULL AND "
            "failure_code IS NULL) OR (state = 'ready' AND finished_at IS NOT NULL "
            "AND failure_code IS NULL) OR (state IN ('failed','interrupted') AND "
            "finished_at IS NOT NULL AND failure_code IS NOT NULL)",
            name="ck_backup_exports_outcome",
        ),
        sa.CheckConstraint(
            "artifact_deleted_at IS NULL OR (state = 'ready' AND "
            "artifact_deleted_at >= expires_at)",
            name="ck_backup_exports_deletion",
        ),
        sa.CheckConstraint(
            "failure_code IS NULL OR failure_code IN "
            "('source_unavailable','source_unproven','copy_failed',"
            "'verification_failed','export_interrupted','result_unconfirmed')",
            name="ck_backup_exports_failure_code",
        ),
        sa.CheckConstraint(
            "idempotency_hash ~ '^[0-9a-f]{64}$' AND payload_hmac ~ '^[0-9a-f]{64}$'",
            name="ck_backup_exports_request",
        ),
        sa.CheckConstraint(
            "installation_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'", name="ck_backup_exports_identity"
        ),
        sa.CheckConstraint(
            "state IN ('queued','preparing','ready','failed','interrupted')",
            name="ck_backup_exports_state",
        ),
        sa.CheckConstraint(
            "(claimed_at IS NULL OR claimed_at >= requested_at) AND (finished_at IS "
            "NULL OR finished_at >= claimed_at) AND (ready_at IS NULL OR ready_at "
            ">= claimed_at)",
            name="ck_backup_exports_times",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_backup_export_operations_deletion_state"),
        ),
        sa.CheckConstraint("NOT is_deleted AND deleted_at IS NULL", name="ck_backup_exports_live"),
        sa.ForeignKeyConstraint(
            ["backup_run_id"],
            ["backup_runs.id"],
            name=op.f("fk_backup_export_operations_backup_run_id_backup_runs"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_backup_export_operations_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["requester_id"],
            ["users.id"],
            name=op.f("fk_backup_export_operations_requester_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("backup_export_operations_pkey")),
        sa.UniqueConstraint("claim_id", name="uq_backup_exports_claim_id"),
        sa.UniqueConstraint(
            "installation_id",
            "requester_id",
            "idempotency_hash",
            name="uq_backup_exports_idempotency",
        ),
    )
    op.create_index(
        "ix_backup_exports_backup_run_id",
        "backup_export_operations",
        ["backup_run_id"],
        unique=False,
    )
    op.create_index(
        "ix_backup_exports_cleanup",
        "backup_export_operations",
        ["installation_id", "expires_at"],
        unique=False,
        postgresql_where=sa.text("state = 'ready' AND artifact_deleted_at IS NULL"),
    )
    op.create_index(
        "ix_backup_exports_queue",
        "backup_export_operations",
        ["installation_id", "state", "requested_at"],
        unique=False,
    )
    op.create_index(
        "ix_backup_exports_requester_id", "backup_export_operations", ["requester_id"], unique=False
    )
    op.create_index(
        "uq_backup_exports_unresolved",
        "backup_export_operations",
        ["installation_id"],
        unique=True,
        postgresql_where=sa.text("state = 'preparing'"),
    )
    op.create_table(
        "comms_direct_blocks",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("blocked_user_id", sa.UUID(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_direct_blocks_deletion_state"),
        ),
        sa.CheckConstraint("user_id <> blocked_user_id", name="ck_comms_direct_blocks_not_self"),
        sa.ForeignKeyConstraint(
            ["blocked_user_id"],
            ["users.id"],
            name=op.f("fk_comms_direct_blocks_blocked_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_direct_blocks_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_direct_blocks_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_direct_blocks_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_direct_blocks_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_direct_blocks_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "user_id", "blocked_user_id", name="uq_comms_direct_blocks_pair"
        ),
    )
    op.create_index(
        "ix_comms_direct_blocks_blocked_user",
        "comms_direct_blocks",
        ["blocked_user_id", "org_id"],
        unique=False,
    )
    op.create_index("ix_comms_direct_blocks_user", "comms_direct_blocks", ["user_id"], unique=False)
    op.create_table(
        "comms_exports",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("requested_by", sa.UUID(), nullable=False),
        sa.Column("request", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "private_verified", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("authorization_digest", sa.String(length=64), nullable=False),
        sa.Column("artifact_key", sa.Text(), nullable=True),
        sa.Column("artifact_sha256", sa.String(length=64), nullable=True),
        sa.Column("artifact_size", sa.BigInteger(), nullable=True),
        sa.Column(
            "artifact_upload_confirmed",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("cleanup_pending", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("cleanup_after", sa.DateTime(timezone=True), nullable=True),
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
            "artifact_key IS NULL OR artifact_key = 'org/' || org_id::text || '/' "
            "|| replace(id::text, '-', '')",
            name="ck_comms_exports_artifact_key",
        ),
        sa.CheckConstraint("jsonb_typeof(request) = 'object'", name="ck_comms_exports_request"),
        sa.CheckConstraint(
            "(artifact_key IS NULL AND artifact_size IS NULL AND artifact_sha256 IS "
            "NULL) OR (artifact_key IS NOT NULL AND artifact_size IS NOT NULL AND "
            "artifact_sha256 IS NOT NULL)",
            name="ck_comms_exports_artifact_complete",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_exports_deletion_state"),
        ),
        sa.CheckConstraint(
            "artifact_size IS NULL OR artifact_size BETWEEN 0 AND 8388608",
            name="ck_comms_exports_artifact_size",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_exports_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_exports_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
            name=op.f("fk_comms_exports_requested_by_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_exports_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_exports_org_id_id"),
    )
    op.create_index(
        "ix_comms_exports_cleanup", "comms_exports", ["org_id", "cleanup_pending"], unique=False
    )
    op.create_index(
        "ix_comms_exports_requester", "comms_exports", ["org_id", "requested_by"], unique=False
    )
    op.create_table(
        "comms_personal_preferences",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column(
            "values",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_personal_preferences_deletion_state"),
        ),
        sa.CheckConstraint(
            "jsonb_typeof(\"values\") = 'object'", name="ck_comms_personal_preferences_values"
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_personal_preferences_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_personal_preferences_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_personal_preferences_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_personal_preferences_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_personal_preferences_org_id_id"),
        sa.UniqueConstraint("org_id", "user_id", name="uq_comms_personal_preferences_user"),
    )
    op.create_index(
        "ix_comms_personal_preferences_user",
        "comms_personal_preferences",
        ["user_id"],
        unique=False,
    )
    op.create_table(
        "comms_presence",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("state IN ('online','away','offline')", name="ck_comms_presence_state"),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_presence_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_presence_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_presence_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_presence_org_id_id"),
        sa.UniqueConstraint("org_id", "user_id", name="uq_comms_presence_user"),
    )
    op.create_index(
        "ix_comms_presence_seen", "comms_presence", ["org_id", "last_seen_at"], unique=False
    )
    op.create_index("ix_comms_presence_user", "comms_presence", ["user_id"], unique=False)
    op.create_table(
        "comms_realtime_admissions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("issued_at", postgresql.ARRAY(sa.DateTime(timezone=True)), nullable=False),
        sa.CheckConstraint(
            "cardinality(issued_at) BETWEEN 1 AND 6 AND array_position(issued_at, NULL) IS NULL",
            name="ck_comms_realtime_admissions_bound",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_realtime_admissions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_realtime_admissions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_realtime_admissions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_realtime_admissions_org_id_id"),
        sa.UniqueConstraint("org_id", "user_id", name="uq_comms_realtime_admissions_subject"),
    )
    op.create_index(
        "ix_comms_realtime_admissions_user", "comms_realtime_admissions", ["user_id"], unique=False
    )
    op.create_table(
        "comms_retention_sweeps",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("policy_digest", sa.String(length=64), nullable=False),
        sa.Column("message_count", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("anchor_count", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("file_count", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
        sa.Column("cursor_id", sa.Uuid(), nullable=True),
        sa.Column("erasure_done", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("file_cursor_id", sa.Uuid(), nullable=True),
        sa.Column("export_cursor_id", sa.Uuid(), nullable=True),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_retention_sweeps_deletion_state"),
        ),
        sa.CheckConstraint(
            "message_count >= 0 AND anchor_count >= 0 AND file_count >= 0",
            name="ck_comms_retention_sweeps_counts",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_retention_sweeps_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_retention_sweeps_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_retention_sweeps_pkey")),
        sa.UniqueConstraint("org_id", "day", "policy_digest", name="uq_comms_retention_sweeps_run"),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_retention_sweeps_org_id_id"),
    )
    op.create_table(
        "comms_setting_locks",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
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
            "(namespace = 'setting' AND key IN "
            "('mode','edit_window_minutes','delete_window_minutes',"
            "'slow_mode_seconds','formatting','link_previews','allowed_reactions',"
            "'mention_limit','auto_archive_days','default_thread_subscription',"
            "'thread_branches','notification_mode','keywords',"
            "'notify_followed_threads','quiet_hours_start','quiet_hours_end',"
            "'notification_sound','notification_badges','notification_preview',"
            "'desktop_notifications','allowed_file_types','max_file_size_mb',"
            "'file_previews','file_downloads','allowed_record_modules',"
            "'require_record_link','record_card_fields','locked',"
            "'restricted_person_ids','restriction_until','allow_export',"
            "'pinned_record_id')) "
            "OR (namespace = 'capability' AND key IN "
            "('react','reply','createThread','attachFiles','linkRecords',"
            "'mentionChannel','pin','manageThreads','deleteOthersMessages',"
            "'moderate','manageChannel','createChannel'))",
            name="ck_comms_setting_locks_key",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_setting_locks_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_setting_locks_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_setting_locks_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_setting_locks_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_setting_locks_org_id_id"),
    )
    op.create_index(
        "uq_comms_setting_locks_active",
        "comms_setting_locks",
        ["org_id", "namespace", "key"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "comms_templates",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("document", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
        sa.CheckConstraint("jsonb_typeof(document) = 'object'", name="ck_comms_templates_document"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_templates_deletion_state"),
        ),
        sa.CheckConstraint("revision BETWEEN 1 AND 2147483647", name="ck_comms_templates_revision"),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_templates_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_templates_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_templates_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_templates_org_id_id"),
    )
    op.create_table(
        "departments",
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("department_name", sa.String(length=150), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_departments_deletion_state"),
        ),
        sa.CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_departments_lifecycle_close_provenance",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_departments_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_departments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("departments_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_departments_org_id_id"),
    )
    op.create_index(
        "uq_departments_name_active",
        "departments",
        ["org_id", "department_name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "groups",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), server_default=sa.text("''"), nullable=False),
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
        sa.CheckConstraint("btrim(name) <> ''", name="ck_groups_name_not_blank"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_groups_deletion_state"),
        ),
        sa.CheckConstraint("revision > 0", name="ck_groups_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_groups_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_groups_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("groups_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_groups_org_id_id"),
    )
    op.create_index(
        "uq_groups_name_active_ci",
        "groups",
        ["org_id", sa.literal_column("lower(name)")],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "identity_sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("active_org_id", sa.UUID(), nullable=True),
        sa.Column("provider_user_id", sa.UUID(), nullable=True),
        sa.Column("provider_session_id", sa.UUID(), nullable=True),
        sa.Column("provider_access_token_encrypted", sa.Text(), nullable=True),
        sa.Column("provider_refresh_token_encrypted", sa.Text(), nullable=True),
        sa.Column("provider_signout_pending_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "provider_signout_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("provider_signout_next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("provider_signout_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refresh_token_digest", sa.String(length=64), nullable=False),
        sa.Column("csrf_token_digest", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("refreshed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_agent", sa.String(length=500), nullable=True),
        sa.Column("ip_address", postgresql.INET(), nullable=True),
        sa.ForeignKeyConstraint(
            ["active_org_id"],
            ["organizations.id"],
            name=op.f("fk_identity_sessions_active_org_id_organizations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_identity_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("identity_sessions_pkey")),
        sa.UniqueConstraint(
            "provider_session_id", name=op.f("uq_identity_sessions_provider_session_id")
        ),
        sa.UniqueConstraint(
            "refresh_token_digest", name="uq_identity_sessions_refresh_token_digest"
        ),
    )
    op.create_index(
        "ix_identity_sessions_user_active",
        "identity_sessions",
        ["user_id", "revoked_at", "expires_at"],
        unique=False,
    )
    op.create_table(
        "lifecycle_confirmation_challenges",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("operation", sa.String(length=20), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=False),
        sa.Column("target_id", sa.UUID(), nullable=False),
        sa.Column("impact_digest", sa.String(length=128), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("failed_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("verification_lease_id", sa.UUID(), nullable=True),
        sa.Column("verification_lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "expires_at > created_at AND expires_at <= created_at + interval '5 minutes'",
            name="ck_lifecycle_challenges_five_minute_expiry",
        ),
        sa.CheckConstraint(
            "length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'",
            name="ck_lifecycle_challenges_token_hash_sha256",
        ),
        sa.CheckConstraint(
            "operation IN ('close', 'purge')", name="ck_lifecycle_challenges_operation"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'verifying', 'consumed', 'expired', 'invalidated', 'exhausted')",
            name="ck_lifecycle_challenges_status",
        ),
        sa.CheckConstraint(
            "failed_attempts >= 0 AND failed_attempts <= 5",
            name="ck_lifecycle_challenges_failed_attempts_nonnegative",
        ),
        sa.CheckConstraint(
            "length(btrim(impact_digest)) > 0",
            name="ck_lifecycle_challenges_impact_digest_nonempty",
        ),
        sa.CheckConstraint(
            "length(btrim(target_type)) > 0", name="ck_lifecycle_challenges_target_type_nonempty"
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_lifecycle_confirmation_challenges_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_lifecycle_confirmation_challenges_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_confirmation_challenges_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_lifecycle_confirmation_challenges_org_id_id"),
        sa.UniqueConstraint(
            "token_hash", name=op.f("uq_lifecycle_confirmation_challenges_token_hash")
        ),
        sa.UniqueConstraint(
            "verification_lease_id",
            name=op.f("uq_lifecycle_confirmation_challenges_verification_lease_id"),
        ),
    )
    op.create_table(
        "lifecycle_rate_limit_buckets",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("blocked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "window_expires_at > window_started_at AND window_expires_at <= "
            "window_started_at + interval '15 minutes'",
            name="ck_lifecycle_buckets_fifteen_minute_window",
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5",
            name="ck_lifecycle_buckets_attempt_count_nonnegative",
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_lifecycle_rate_limit_buckets_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_lifecycle_rate_limit_buckets_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_rate_limit_buckets_pkey")),
        sa.UniqueConstraint("org_id", "actor_id", name="uq_lifecycle_rate_limit_buckets_actor_id"),
        sa.UniqueConstraint("org_id", "id", name="uq_lifecycle_rate_limit_buckets_org_id_id"),
    )
    op.create_table(
        "lifecycle_rate_limit_failures",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_lifecycle_rate_limit_failures_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_lifecycle_rate_limit_failures_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("lifecycle_rate_limit_failures_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_lifecycle_rate_limit_failures_org_id_id"),
    )
    op.create_index(
        "ix_lifecycle_rate_limit_failures_actor_occurred",
        "lifecycle_rate_limit_failures",
        ["actor_id", "occurred_at"],
        unique=False,
    )
    op.create_table(
        "memberships",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("sponsor_user_id", sa.UUID(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invitation_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invitation_accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("provider_invitation_operation_id", sa.Uuid(), nullable=True),
        sa.Column("mfa_required_since", sa.DateTime(timezone=True), nullable=True),
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
            "(role = 'guest') = (sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL)",
            name="ck_memberships_guest",
        ),
        sa.CheckConstraint("role IN ('admin', 'member', 'guest')", name="ck_memberships_role"),
        sa.CheckConstraint(
            "status IN ('pending', 'active', 'disabled')", name="ck_memberships_status"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_memberships_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_memberships_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_memberships_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["sponsor_user_id"],
            ["users.id"],
            name=op.f("fk_memberships_sponsor_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_memberships_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("memberships_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_memberships_org_id_id"),
        sa.UniqueConstraint("org_id", "user_id", name="uq_memberships_org_user"),
    )
    op.create_index(
        op.f("ix_memberships_sponsor_user_id"), "memberships", ["sponsor_user_id"], unique=False
    )
    op.create_index(op.f("ix_memberships_user_id"), "memberships", ["user_id"], unique=False)
    op.create_index(
        "uq_memberships_user_pending",
        "memberships",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending' AND is_deleted = false"),
    )
    op.create_table(
        "sandbox_documents",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("singleton_key", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("schema_version", sa.Integer(), server_default=sa.text("4"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("document", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("byte_count", sa.Integer(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_sandbox_documents_deletion_state"),
        ),
        sa.CheckConstraint("byte_count >= 0", name="ck_sandbox_documents_byte_count_nonnegative"),
        sa.CheckConstraint(
            "is_deleted = false AND deleted_at IS NULL", name="ck_sandbox_documents_not_deleted"
        ),
        sa.CheckConstraint("revision > 0", name="ck_sandbox_documents_revision_positive"),
        sa.CheckConstraint("schema_version = 4", name="ck_sandbox_documents_schema_version"),
        sa.CheckConstraint("singleton_key = true", name="ck_sandbox_documents_singleton_key"),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_documents_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_documents_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_documents_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_documents_org_id_id"),
        sa.UniqueConstraint("org_id", "singleton_key", name="uq_sandbox_documents_singleton_key"),
    )
    op.create_table(
        "security_events",
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_type", sa.String(length=100), nullable=False),
        sa.Column("outcome", sa.String(length=20), nullable=False),
        sa.Column("source", sa.String(length=100), nullable=False),
        sa.Column("operation_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=True),
        sa.Column("subject_id", sa.UUID(), nullable=True),
        sa.Column(
            "labels",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("fingerprint", sa.String(length=128), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("request_method", sa.String(length=10), nullable=True),
        sa.Column("request_path", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "outcome IN ('attempt', 'success', 'denied', 'failure', 'partial')",
            name="ck_security_events_outcome",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_security_events_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("security_events_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_security_events_org_id_id"),
    )
    op.create_index(
        "ix_security_events_occurred_at_id", "security_events", ["occurred_at", "id"], unique=False
    )
    op.create_index(
        "ix_security_events_operation_id", "security_events", ["operation_id"], unique=False
    )
    op.create_table(
        "boards",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("scope", sa.String(length=20), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'active'"), nullable=False
        ),
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
            "(scope = 'department') = (department_id IS NOT NULL)",
            name="ck_boards_department_scope",
        ),
        sa.CheckConstraint("scope IN ('company', 'department', 'project')", name="ck_boards_scope"),
        sa.CheckConstraint("status IN ('active', 'archived')", name="ck_boards_status"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_boards_deletion_state"),
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_boards_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_boards_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_boards_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_boards_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_boards_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("boards_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_boards_org_id_id"),
    )
    op.create_index(op.f("ix_boards_department_id"), "boards", ["department_id"], unique=False)
    op.create_index(
        "uq_boards_company",
        "boards",
        ["org_id", "scope"],
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
        "comms_categories",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("position", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
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
        sa.CheckConstraint("btrim(name) <> ''", name="ck_comms_categories_name"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_categories_deletion_state"),
        ),
        sa.CheckConstraint("position >= 0", name="ck_comms_categories_position"),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_comms_categories_department",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_categories_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_categories_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_categories_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_categories_org_id_id"),
    )
    op.create_index(
        "ix_comms_categories_department",
        "comms_categories",
        ["org_id", "department_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_categories_order", "comms_categories", ["org_id", "position", "id"], unique=False
    )
    op.create_table(
        "dashboards",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "refresh_cadence",
            sa.String(length=20),
            server_default=sa.text("'manual'"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("is_home", sa.Boolean(), server_default=sa.text("false"), nullable=False),
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
            "refresh_cadence IN ('manual', 'one-minute', 'five-minutes')",
            name="ck_dashboards_refresh_cadence",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_dashboards_deletion_state"),
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_dashboards_name_nonempty"),
        sa.CheckConstraint("position >= 0", name="ck_dashboards_position_nonnegative"),
        sa.CheckConstraint("revision > 0", name="ck_dashboards_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_dashboards_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_dashboards_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_dashboards_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("dashboards_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_dashboards_org_id_id"),
    )
    op.create_index(
        "ix_dashboards_department_position",
        "dashboards",
        ["department_id", "position"],
        unique=False,
    )
    op.create_index(
        "uq_dashboards_department_home",
        "dashboards",
        ["org_id", "department_id"],
        unique=True,
        postgresql_where=sa.text("is_home AND NOT is_deleted"),
    )
    op.create_table(
        "group_members",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_group_members_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_group_members_group_id_groups",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_group_members_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_group_members_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_group_members_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("group_members_pkey")),
        sa.UniqueConstraint("group_id", "user_id", name="uq_group_members_group_user"),
        sa.UniqueConstraint("org_id", "id", name="uq_group_members_org_id_id"),
    )
    op.create_index(op.f("ix_group_members_user_id"), "group_members", ["user_id"], unique=False)
    op.create_table(
        "modules",
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("module_name", sa.String(length=150), nullable=False),
        sa.Column("title_field_id", sa.Uuid(), nullable=True),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_modules_deletion_state"),
        ),
        sa.CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_modules_lifecycle_close_provenance",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_modules_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "title_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_modules_title_field_id_fields",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_modules_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_modules_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("modules_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_modules_org_id_id"),
    )
    op.create_index(op.f("ix_modules_department_id"), "modules", ["department_id"], unique=False)
    op.create_index(op.f("ix_modules_title_field_id"), "modules", ["title_field_id"], unique=False)
    op.create_index(
        "uq_modules_department_name_active",
        "modules",
        ["department_id", "module_name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "sandbox_test_runs",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("document_revision", sa.Integer(), nullable=False),
        sa.Column("document_hash", sa.String(length=64), nullable=False),
        sa.Column("module_id", sa.String(length=1000), nullable=False),
        sa.Column("input_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("event", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("trigger_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("result_byte_count", sa.Integer(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_sandbox_test_runs_deletion_state"),
        ),
        sa.CheckConstraint(
            "document_revision > 0", name="ck_sandbox_test_runs_document_revision_positive"
        ),
        sa.CheckConstraint(
            "result_byte_count >= 0", name="ck_sandbox_test_runs_result_byte_count_nonnegative"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "document_id"],
            ["sandbox_documents.org_id", "sandbox_documents.id"],
            name="fk_sandbox_test_runs_document_id_sandbox_documents",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_test_runs_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_test_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_test_runs_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_test_runs_org_id_id"),
    )
    op.create_index(
        "ix_sandbox_test_runs_document_created",
        "sandbox_test_runs",
        ["document_id", "created_at", "id"],
        unique=False,
    )
    op.create_table(
        "sandbox_versions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("source_document_revision", sa.Integer(), nullable=False),
        sa.Column("source_version_id", sa.Uuid(), nullable=True),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("byte_count", sa.Integer(), nullable=False),
        sa.Column("metadata_revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
            "kind IN ('checkpoint', 'published', 'imported')", name="ck_sandbox_versions_kind"
        ),
        sa.CheckConstraint(
            "snapshot ->> 'schemaVersion' = '4'", name="ck_sandbox_versions_schema_version"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_sandbox_versions_deletion_state"),
        ),
        sa.CheckConstraint("byte_count >= 0", name="ck_sandbox_versions_byte_count_nonnegative"),
        sa.CheckConstraint(
            "metadata_revision > 0", name="ck_sandbox_versions_metadata_revision_positive"
        ),
        sa.CheckConstraint("sequence > 0", name="ck_sandbox_versions_sequence_positive"),
        sa.CheckConstraint(
            "source_document_revision > 0", name="ck_sandbox_versions_source_revision_positive"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "document_id"],
            ["sandbox_documents.org_id", "sandbox_documents.id"],
            name="fk_sandbox_versions_document_id_sandbox_documents",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "source_version_id"],
            ["sandbox_versions.org_id", "sandbox_versions.id"],
            name="fk_sandbox_versions_source_version_id_sandbox_versions",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_versions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_versions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_versions_pkey")),
        sa.UniqueConstraint(
            "document_id", "sequence", name="uq_sandbox_versions_document_sequence"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_versions_org_id_id"),
    )
    op.create_index(
        "ix_sandbox_versions_source_version",
        "sandbox_versions",
        ["source_version_id"],
        unique=False,
    )
    op.create_table(
        "board_events",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("details", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("location", sa.String(length=240), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "links",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("all_day", sa.Boolean(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("start_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("timezone_name", sa.String(length=80), nullable=False),
        sa.Column(
            "recurrence", sa.String(length=10), server_default=sa.text("'none'"), nullable=False
        ),
        sa.Column("repeat_until", sa.Date(), nullable=True),
        sa.Column("archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
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
            "(recurrence = 'none' AND repeat_until IS NULL) OR (recurrence IN "
            "('daily', 'weekly', 'monthly') AND repeat_until IS NOT NULL)",
            name="ck_board_events_recurrence",
        ),
        sa.CheckConstraint(
            "CASE WHEN jsonb_typeof(links) = 'array' THEN jsonb_array_length(links) "
            "<= 20 ELSE false END",
            name="ck_board_events_links_array_limit",
        ),
        sa.CheckConstraint(
            "(all_day = true AND start_date IS NOT NULL AND end_date IS NOT NULL "
            "AND start_at IS NULL AND end_at IS NULL AND end_date >= start_date) OR "
            "(all_day = false AND start_date IS NULL AND end_date IS NULL AND "
            "start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at)",
            name="ck_board_events_temporal_mode",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_events_deletion_state"),
        ),
        sa.CheckConstraint(
            "length(btrim(timezone_name)) > 0", name="ck_board_events_timezone_nonempty"
        ),
        sa.CheckConstraint("length(btrim(title)) > 0", name="ck_board_events_title_nonempty"),
        sa.CheckConstraint("length(details) <= 4000", name="ck_board_events_details_length"),
        sa.CheckConstraint(
            "repeat_until IS NULL OR NOT all_day OR repeat_until >= start_date",
            name="ck_board_events_all_day_repeat_until",
        ),
        sa.CheckConstraint("revision > 0", name="ck_board_events_revision_positive"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_board_events_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_events_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_events_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_events_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_events_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_events_org_id_id"),
    )
    op.create_index("ix_board_events_author_id", "board_events", ["author_id"], unique=False)
    op.create_index("ix_board_events_board_id", "board_events", ["board_id"], unique=False)
    op.create_table(
        "board_groups",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("level", sa.String(length=10), nullable=False),
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
        sa.CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_board_groups_level"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_groups_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_groups_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_board_groups_group_id_groups",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_groups_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_groups_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_groups_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_groups_org_id_id"),
    )
    op.create_index("ix_board_groups_group_id", "board_groups", ["group_id"], unique=False)
    op.create_index(
        "uq_board_groups_board_group_active",
        "board_groups",
        ["board_id", "group_id"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
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
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_labels_deletion_state"),
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
        "board_posts",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "links",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'draft'"), nullable=False
        ),
        sa.Column("publish_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("displayed_publication_number", sa.Integer(), nullable=True),
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
            "CASE WHEN jsonb_typeof(links) = 'array' THEN jsonb_array_length(links) "
            "<= 20 ELSE false END",
            name="ck_board_posts_links_array_limit",
        ),
        sa.CheckConstraint(
            "status <> 'scheduled' OR publish_at IS NOT NULL", name="ck_board_posts_scheduled_time"
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'scheduled', 'published', 'archived')",
            name="ck_board_posts_status",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_posts_deletion_state"),
        ),
        sa.CheckConstraint(
            "displayed_publication_number IS NULL OR displayed_publication_number > 0",
            name="ck_board_posts_displayed_publication_positive",
        ),
        sa.CheckConstraint("length(body) <= 2000", name="ck_board_posts_body_length"),
        sa.CheckConstraint("length(btrim(body)) > 0", name="ck_board_posts_body_nonempty"),
        sa.CheckConstraint("length(btrim(title)) > 0", name="ck_board_posts_title_nonempty"),
        sa.CheckConstraint(
            "publish_at IS NULL OR expires_at IS NULL OR expires_at > publish_at",
            name="ck_board_posts_expiry",
        ),
        sa.CheckConstraint("revision > 0", name="ck_board_posts_revision_positive"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_board_posts_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_posts_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_posts_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_posts_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_posts_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_posts_org_id_id"),
    )
    op.create_index("ix_board_posts_author_id", "board_posts", ["author_id"], unique=False)
    op.create_index("ix_board_posts_board_id", "board_posts", ["board_id"], unique=False)
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
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_stages_deletion_state"),
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
        "charts",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("chart_type", sa.String(length=20), nullable=False),
        sa.Column("query", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "chart_type IN ('bar', 'line', 'pie', 'summary', 'workload', 'records')",
            name="ck_charts_type",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_charts_deletion_state"),
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_charts_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_charts_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_charts_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_charts_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_charts_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_charts_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("charts_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_charts_org_id_id"),
    )
    op.create_index("ix_charts_department_id", "charts", ["department_id"], unique=False)
    op.create_index("ix_charts_module_id", "charts", ["module_id"], unique=False)
    op.create_table(
        "comms_conversations",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("direct_key", sa.Text(), nullable=True),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("topic", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("position", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
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
            "(kind = 'channel' AND btrim(name) <> '' AND (scope IN "
            "('organization','department') OR is_deleted)) OR (kind IN "
            "('direct','group') AND scope = 'members' AND category_id IS NULL)",
            name="ck_comms_conversations_kind_shape",
        ),
        sa.CheckConstraint(
            "(scope = 'department' AND department_id IS NOT NULL) OR (scope <> "
            "'department' AND department_id IS NULL)",
            name="ck_comms_conversations_department_shape",
        ),
        sa.CheckConstraint(
            "kind IN ('channel','direct','group')", name="ck_comms_conversations_kind"
        ),
        sa.CheckConstraint(
            "scope IN ('organization','department','groups','members')",
            name="ck_comms_conversations_scope",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_conversations_deletion_state"),
        ),
        sa.CheckConstraint("position >= 0", name="ck_comms_conversations_position"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_comms_conversations_created_by_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "category_id"],
            ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_conversations_category",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_comms_conversations_department",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_conversations_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_conversations_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_conversations_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_conversations_org_id_id"),
    )
    op.create_index(
        "ix_comms_conversations_category_order",
        "comms_conversations",
        ["org_id", "category_id", "position", "id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_conversations_creator", "comms_conversations", ["created_by"], unique=False
    )
    op.create_index(
        "ix_comms_conversations_department",
        "comms_conversations",
        ["org_id", "department_id"],
        unique=False,
    )
    op.create_index(
        "uq_comms_conversations_direct_key",
        "comms_conversations",
        ["org_id", "direct_key"],
        unique=True,
        postgresql_where=sa.text("kind = 'direct'"),
    )
    op.create_table(
        "fields",
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("required", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("audit_redacted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("relationship_target_module_id", sa.Uuid(), nullable=True),
        sa.Column("relationship_multiple_targets", sa.Boolean(), nullable=True),
        sa.Column("relationship_multiple_sources", sa.Boolean(), nullable=True),
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
            "(type = 'relationship' AND relationship_target_module_id IS NOT NULL "
            "AND relationship_multiple_targets IS NOT NULL AND "
            "relationship_multiple_sources IS NOT NULL AND required = false AND "
            "config = '{}'::jsonb) OR (type <> 'relationship' AND "
            "relationship_target_module_id IS NULL AND "
            "relationship_multiple_targets IS NULL AND "
            "relationship_multiple_sources IS NULL)",
            name="ck_fields_relationship_metadata",
        ),
        sa.CheckConstraint(
            "type IN ('text', 'long_text', 'email', 'url', 'number', 'decimal', "
            "'int', 'boolean', 'date', 'datetime', 'select', 'user', "
            "'relationship')",
            name="ck_fields_type",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_fields_deletion_state"),
        ),
        sa.CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_fields_lifecycle_close_provenance",
        ),
        sa.CheckConstraint("position >= 0", name="ck_fields_position_nonnegative"),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_fields_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "relationship_target_module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_fields_relationship_target_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_fields_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_fields_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("fields_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_fields_org_id_id"),
    )
    op.create_index(op.f("ix_fields_module_id"), "fields", ["module_id"], unique=False)
    op.create_index(
        "ix_fields_relationship_target_module_id",
        "fields",
        ["relationship_target_module_id"],
        unique=False,
    )
    op.create_index(
        "uq_fields_module_name_active",
        "fields",
        ["module_id", "name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "uq_fields_module_position_active",
        "fields",
        ["module_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "group_access",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=True),
        sa.Column("level", sa.Text(), nullable=False),
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
        sa.CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_group_access_level"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_group_access_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_group_access_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_group_access_group_id_groups",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_group_access_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_group_access_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_group_access_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("group_access_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_group_access_org_id_id"),
    )
    op.create_index(
        "ix_group_access_department_module_active",
        "group_access",
        ["department_id", "module_id"],
        unique=False,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index("ix_group_access_module_id", "group_access", ["module_id"], unique=False)
    op.create_index(
        "uq_group_access_target_active",
        "group_access",
        ["group_id", "department_id", "module_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "records",
        sa.Column("lifecycle_close_operation_id", sa.Uuid(), nullable=True),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column(
            "data",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_records_deletion_state"),
        ),
        sa.CheckConstraint(
            "lifecycle_close_operation_id IS NULL OR is_deleted",
            name="ck_records_lifecycle_close_provenance",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_records_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_records_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_records_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("records_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_records_org_id_id"),
    )
    op.create_index(op.f("ix_records_module_id"), "records", ["module_id"], unique=False)
    op.create_table(
        "reports",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("subtitle", sa.String(length=160), nullable=True),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("recipe", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_reports_deletion_state"),
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_reports_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_reports_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_reports_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_reports_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_reports_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("reports_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_reports_org_id_id"),
    )
    op.create_index("ix_reports_module", "reports", ["module_id"], unique=False)
    op.create_table(
        "sandbox_publications",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("document_revision", sa.Integer(), nullable=False),
        sa.Column("document_hash", sa.String(length=64), nullable=False),
        sa.Column("impact_digest", sa.String(length=64), nullable=False),
        sa.Column("live_state_digest", sa.String(length=64), nullable=False),
        sa.Column("preview_token_digest", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("response_body", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_sandbox_publications_deletion_state"),
        ),
        sa.CheckConstraint(
            "document_revision > 0", name="ck_sandbox_publications_document_revision"
        ),
        sa.CheckConstraint(
            "length(document_hash) = 64", name="ck_sandbox_publications_document_hash"
        ),
        sa.CheckConstraint(
            "length(impact_digest) = 64", name="ck_sandbox_publications_impact_digest"
        ),
        sa.CheckConstraint(
            "length(live_state_digest) = 64", name="ck_sandbox_publications_live_digest"
        ),
        sa.CheckConstraint(
            "length(preview_token_digest) = 64", name="ck_sandbox_publications_preview_token_digest"
        ),
        sa.CheckConstraint(
            "length(request_fingerprint) = 64", name="ck_sandbox_publications_request_fingerprint"
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_sandbox_publications_actor_id_users"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "document_id"],
            ["sandbox_documents.org_id", "sandbox_documents.id"],
            name="fk_sandbox_publications_document_id_sandbox_documents",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "version_id"],
            ["sandbox_versions.org_id", "sandbox_versions.id"],
            name="fk_sandbox_publications_version_id_sandbox_versions",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_publications_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_publications_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_publications_pkey")),
        sa.UniqueConstraint(
            "org_id", "actor_id", "idempotency_key", name="uq_sandbox_publications_actor_key"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_publications_org_id_id"),
        sa.UniqueConstraint(
            "preview_token_digest", name="uq_sandbox_publications_preview_token_digest"
        ),
        sa.UniqueConstraint("version_id", name="uq_sandbox_publications_version"),
    )
    op.create_index(
        op.f("ix_sandbox_publications_actor_id"), "sandbox_publications", ["actor_id"], unique=False
    )
    op.create_index(
        "ix_sandbox_publications_document_created",
        "sandbox_publications",
        ["document_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "saved_views",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("definition", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "presentation",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{\"version\": 1}'::jsonb"),
            nullable=False,
        ),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_saved_views_deletion_state"),
        ),
        sa.CheckConstraint("revision > 0", name="ck_saved_views_revision"),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_saved_views_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_saved_views_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_saved_views_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("saved_views_pkey")),
        sa.UniqueConstraint("id", "module_id", name="uq_saved_views_id_module"),
        sa.UniqueConstraint("org_id", "id", name="uq_saved_views_org_id_id"),
    )
    op.create_index(op.f("ix_saved_views_module_id"), "saved_views", ["module_id"], unique=False)
    op.create_index(
        "uq_saved_views_module_default",
        "saved_views",
        ["module_id"],
        unique=True,
        postgresql_where=sa.text("is_default AND NOT is_deleted"),
    )
    op.create_table(
        "board_calendar_sources",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("date_field_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_calendar_sources_deletion_state"),
        ),
        sa.CheckConstraint(
            "num_nonnulls(board_id, user_id) = 1", name="ck_board_calendar_sources_one_owner"
        ),
        sa.CheckConstraint("position >= 0", name="ck_board_calendar_sources_position"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_board_calendar_sources_created_by_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_calendar_sources_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "date_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_board_calendar_sources_date_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_calendar_sources_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_calendar_sources_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_calendar_sources_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_board_calendar_sources_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_calendar_sources_pkey")),
        sa.UniqueConstraint(
            "org_id", "board_id", "date_field_id", name="uq_board_calendar_sources_board_field"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_board_calendar_sources_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "user_id", "date_field_id", name="uq_board_calendar_sources_user_field"
        ),
    )
    op.create_index(
        "ix_board_calendar_sources_board_id", "board_calendar_sources", ["board_id"], unique=False
    )
    op.create_index(
        "ix_board_calendar_sources_date_field_id",
        "board_calendar_sources",
        ["date_field_id"],
        unique=False,
    )
    op.create_index(
        "ix_board_calendar_sources_module_id", "board_calendar_sources", ["module_id"], unique=False
    )
    op.create_index(
        "ix_board_calendar_sources_user_id", "board_calendar_sources", ["user_id"], unique=False
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
            "AND module_id IS NULL AND record_id IS NULL) OR (kind = 'record' AND "
            "title IS NULL AND description IS NULL AND module_id IS NOT NULL AND "
            "record_id IS NOT NULL)",
            name="ck_board_cards_kind_columns",
        ),
        sa.CheckConstraint("kind IN ('objective', 'record')", name="ck_board_cards_kind"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_cards_deletion_state"),
        ),
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
        "board_event_reminders",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("timing", sa.String(length=8), nullable=False),
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
            "timing IN ('start', '15m', '1d')", name="ck_board_event_reminders_timing"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_event_reminders_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_event_reminders_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "event_id"],
            ["board_events.org_id", "board_events.id"],
            name="fk_board_event_reminders_event_id_board_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_event_reminders_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_event_reminders_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_event_reminders_pkey")),
        sa.UniqueConstraint("event_id", "timing", name="uq_board_event_reminders_event_timing"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_event_reminders_org_id_id"),
    )
    op.create_index(
        "ix_board_event_reminders_board_id", "board_event_reminders", ["board_id"], unique=False
    )
    op.create_table(
        "board_post_revisions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("post_id", sa.Uuid(), nullable=False),
        sa.Column("publication_number", sa.Integer(), nullable=False),
        sa.Column("publication_key", sa.Uuid(), nullable=False),
        sa.Column("content_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=100), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "links",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
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
            "CASE WHEN jsonb_typeof(links) = 'array' THEN jsonb_array_length(links) "
            "<= 20 ELSE false END",
            name="ck_board_post_revisions_links_array_limit",
        ),
        sa.CheckConstraint(
            "content_fingerprint ~ '^[0-9a-f]{64}$'", name="ck_board_post_revisions_fingerprint_hex"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_post_revisions_deletion_state"),
        ),
        sa.CheckConstraint(
            "expires_at IS NULL OR expires_at > published_at", name="ck_board_post_revisions_expiry"
        ),
        sa.CheckConstraint("length(body) <= 2000", name="ck_board_post_revisions_body_length"),
        sa.CheckConstraint("length(btrim(body)) > 0", name="ck_board_post_revisions_body_nonempty"),
        sa.CheckConstraint(
            "length(btrim(title)) > 0", name="ck_board_post_revisions_title_nonempty"
        ),
        sa.CheckConstraint(
            "publication_number > 0", name="ck_board_post_revisions_number_positive"
        ),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_board_post_revisions_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_board_post_revisions_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_post_revisions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revisions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revisions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_post_revisions_org_id_id"),
        sa.UniqueConstraint(
            "post_id", "publication_key", name="uq_board_post_revisions_publication_key"
        ),
        sa.UniqueConstraint(
            "post_id", "publication_number", name="uq_board_post_revisions_publication"
        ),
    )
    op.create_index(
        "ix_board_post_revisions_author_id", "board_post_revisions", ["author_id"], unique=False
    )
    op.create_table(
        "comms_capability_grants",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("capability", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=True),
        sa.Column("granted", sa.Boolean(), nullable=False),
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
            "(scope = 'workspace' AND category_id IS NULL AND conversation_id IS "
            "NULL) OR (scope = 'category' AND category_id IS NOT NULL AND "
            "conversation_id IS NULL) OR (scope = 'channel' AND category_id IS NULL "
            "AND conversation_id IS NOT NULL)",
            name="ck_comms_capability_grants_scope",
        ),
        sa.CheckConstraint(
            "(subject = 'everyone' AND group_id IS NULL AND capability IN "
            "('react','reply','createThread','attachFiles','linkRecords')) OR "
            "(subject = 'group' AND group_id IS NOT NULL AND granted = true AND "
            "(capability IN "
            "('reply','mentionChannel','pin','manageThreads','deleteOthersMessages','moderate') "
            "OR (capability = 'manageChannel' AND scope IN ('category','channel')) "
            "OR (capability = 'createChannel' AND scope IN "
            "('workspace','category'))))",
            name="ck_comms_capability_grants_subject_capability",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_capability_grants_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "category_id"],
            ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_capability_grants_category",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_capability_grants_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_comms_capability_grants_group",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_capability_grants_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_capability_grants_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_capability_grants_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_capability_grants_org_id_id"),
    )
    op.create_index(
        "ix_comms_capability_grants_category",
        "comms_capability_grants",
        ["org_id", "category_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_capability_grants_conversation",
        "comms_capability_grants",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_capability_grants_group",
        "comms_capability_grants",
        ["org_id", "group_id"],
        unique=False,
    )
    op.create_index(
        "uq_comms_capability_grants_active",
        "comms_capability_grants",
        ["org_id", "scope", "category_id", "conversation_id", "capability", "subject", "group_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "comms_channel_access",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("level", sa.Text(), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
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
            "(subject = 'group' AND group_id IS NOT NULL AND user_id IS NULL) OR "
            "(subject = 'user' AND user_id IS NOT NULL AND group_id IS NULL)",
            name="ck_comms_channel_access_subject",
        ),
        sa.CheckConstraint("level IN ('read','post')", name="ck_comms_channel_access_level"),
        sa.CheckConstraint(
            "(conversation_id IS NULL) <> (category_id IS NULL)",
            name="ck_comms_channel_access_target",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_channel_access_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_comms_channel_access_created_by_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "category_id"],
            ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_channel_access_category",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_channel_access_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_comms_channel_access_group",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_channel_access_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_channel_access_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_channel_access_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_channel_access_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_channel_access_org_id_id"),
    )
    op.create_index(
        "ix_comms_channel_access_category",
        "comms_channel_access",
        ["org_id", "category_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_channel_access_conversation",
        "comms_channel_access",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_channel_access_group",
        "comms_channel_access",
        ["org_id", "group_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_channel_access_user", "comms_channel_access", ["org_id", "user_id"], unique=False
    )
    op.create_index(
        "uq_comms_channel_access_active",
        "comms_channel_access",
        ["org_id", "conversation_id", "category_id", "subject", "group_id", "user_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "comms_conversation_counters",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("last_seq", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_conversation_counters_deletion_state"),
        ),
        sa.CheckConstraint(
            "last_seq BETWEEN 0 AND 9007199254740991",
            name="ck_comms_conversation_counters_sequence",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_conversation_counters_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_conversation_counters_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_conversation_counters_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_conversation_counters_pkey")),
        sa.UniqueConstraint(
            "org_id", "conversation_id", name="uq_comms_conversation_counters_conversation"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_conversation_counters_org_id_id"),
    )
    op.create_table(
        "comms_expired_sends",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("client_key", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_expired_sends_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_comms_expired_sends_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_expired_sends_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_expired_sends_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_expired_sends_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_expired_sends_pkey")),
        sa.UniqueConstraint("org_id", "author_id", "client_key", name="uq_comms_expired_sends_key"),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_expired_sends_org_id_id"),
    )
    op.create_index(
        "ix_comms_expired_sends_conversation",
        "comms_expired_sends",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_table(
        "comms_export_sources",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("export_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("private_at_capture", sa.Boolean(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_export_sources_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_export_sources_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "export_id"],
            ["comms_exports.org_id", "comms_exports.id"],
            name="fk_comms_export_sources_export",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_export_sources_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_export_sources_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_export_sources_pkey")),
        sa.UniqueConstraint(
            "org_id", "export_id", "conversation_id", name="uq_comms_export_sources_binding"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_export_sources_org_id_id"),
    )
    op.create_index(
        "ix_comms_export_sources_conversation",
        "comms_export_sources",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_table(
        "comms_member_preferences",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("collapsed", sa.Boolean(), nullable=True),
        sa.Column("notify", sa.Text(), nullable=True),
        sa.Column("mute", sa.Text(), server_default=sa.text("'off'"), nullable=False),
        sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("starred", sa.Boolean(), nullable=True),
        sa.Column("hidden", sa.Boolean(), nullable=True),
        sa.Column("manual_unread", sa.Boolean(), nullable=True),
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
            "(mute IN ('off','indefinite') AND muted_until IS NULL) OR (mute = "
            "'until' AND muted_until IS NOT NULL)",
            name="ck_comms_member_preferences_mute",
        ),
        sa.CheckConstraint(
            "notify IS NULL OR notify IN ('all','mentions','mute')",
            name="ck_comms_member_preferences_notify",
        ),
        sa.CheckConstraint(
            "(category_id IS NOT NULL AND collapsed IS NOT NULL AND notify IS NULL "
            "AND starred IS NULL AND hidden IS NULL AND manual_unread IS NULL) OR "
            "(conversation_id IS NOT NULL AND collapsed IS NULL AND notify IS NOT "
            "NULL AND starred IS NOT NULL AND hidden IS NOT NULL AND manual_unread "
            "IS NOT NULL)",
            name="ck_comms_member_preferences_fields",
        ),
        sa.CheckConstraint(
            "(category_id IS NOT NULL AND conversation_id IS NULL) OR (category_id "
            "IS NULL AND conversation_id IS NOT NULL)",
            name="ck_comms_member_preferences_owner",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_member_preferences_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "category_id"],
            ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_member_preferences_category",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_member_preferences_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_member_preferences_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_member_preferences_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_member_preferences_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_member_preferences_pkey")),
        sa.UniqueConstraint(
            "org_id",
            "category_id",
            "conversation_id",
            "user_id",
            name="uq_comms_member_preferences_owner_user",
            postgresql_nulls_not_distinct=True,
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_member_preferences_org_id_id"),
    )
    op.create_index(
        "ix_comms_member_preferences_conversation",
        "comms_member_preferences",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_member_preferences_user",
        "comms_member_preferences",
        ["user_id", "org_id"],
        unique=False,
    )
    op.create_table(
        "comms_members",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.Text(), server_default=sa.text("'member'"), nullable=False),
        sa.Column(
            "joined_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
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
        sa.CheckConstraint("role IN ('member','manager')", name="ck_comms_members_role"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_members_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_members_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_members_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_members_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_members_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_members_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_members_org_id_id"),
    )
    op.create_index(
        "ix_comms_members_conversation",
        "comms_members",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_members_user",
        "comms_members",
        ["user_id", "org_id", "conversation_id"],
        unique=False,
    )
    op.create_index(
        "uq_comms_members_active",
        "comms_members",
        ["org_id", "conversation_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "comms_messages",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "mutation_generation", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("retention_erased_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("client_key", sa.Uuid(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "link_previews",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("link_preview_generation", sa.BigInteger(), nullable=True),
        sa.Column(
            "body_tsv",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple'::regconfig, body)", persisted=True),
            nullable=False,
        ),
        sa.Column("send_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("reply_to_id", sa.Uuid(), nullable=True),
        sa.Column(
            "also_send_to_channel", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("reply_count", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("last_reply_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "mentions_channel", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("mentions_here", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by", sa.UUID(), nullable=True),
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("pinned_by", sa.UUID(), nullable=True),
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
            "(link_preview_generation IS NULL AND link_previews = '[]'::jsonb) OR "
            "(link_preview_generation IS NOT NULL AND link_preview_generation = "
            "mutation_generation AND jsonb_array_length(link_previews) = 1 AND "
            "is_deleted = false AND deleted_at IS NULL AND retention_erased_at IS "
            "NULL)",
            name="ck_comms_messages_link_previews_source",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(link_previews) = 'array' AND jsonb_array_length(link_previews) <= 1",
            name="ck_comms_messages_link_previews_shape",
        ),
        sa.CheckConstraint(
            "retention_erased_at IS NULL OR (is_deleted = true AND deleted_at IS "
            "NOT NULL AND body = '' AND mentions_channel = false AND mentions_here "
            "= false AND pinned_at IS NULL AND pinned_by IS NULL)",
            name="ck_comms_messages_retention_erased",
        ),
        sa.CheckConstraint(
            "send_fingerprint ~ '^[0-9a-f]{64}$'", name="ck_comms_messages_send_fingerprint"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_messages_deletion_state"),
        ),
        sa.CheckConstraint("char_length(body) <= 4000", name="ck_comms_messages_body_length"),
        sa.CheckConstraint(
            "mutation_generation BETWEEN 0 AND 9007199254740991",
            name="ck_comms_messages_mutation_generation",
        ),
        sa.CheckConstraint(
            "parent_id IS NOT NULL OR also_send_to_channel = false",
            name="ck_comms_messages_channel_reply",
        ),
        sa.CheckConstraint(
            "parent_id IS NULL OR parent_id <> id", name="ck_comms_messages_parent_self"
        ),
        sa.CheckConstraint(
            "reply_count BETWEEN 0 AND 9007199254740991", name="ck_comms_messages_reply_count"
        ),
        sa.CheckConstraint(
            "reply_to_id IS NULL OR reply_to_id <> id", name="ck_comms_messages_reply_to_self"
        ),
        sa.CheckConstraint("seq BETWEEN 1 AND 9007199254740991", name="ck_comms_messages_sequence"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_comms_messages_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["deleted_by"],
            ["users.id"],
            name=op.f("fk_comms_messages_deleted_by_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id", "parent_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_messages_parent",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id", "reply_to_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_messages_reply_to",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_messages_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_messages_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_messages_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["pinned_by"],
            ["users.id"],
            name=op.f("fk_comms_messages_pinned_by_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_messages_pkey")),
        sa.UniqueConstraint(
            "org_id", "author_id", "client_key", name="uq_comms_messages_client_key"
        ),
        sa.UniqueConstraint(
            "org_id", "conversation_id", "id", name="uq_comms_messages_conversation_id"
        ),
        sa.UniqueConstraint("org_id", "conversation_id", "seq", name="uq_comms_messages_sequence"),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_messages_org_id_id"),
    )
    op.create_index(
        "ix_comms_messages_author", "comms_messages", ["author_id", "created_at"], unique=False
    )
    op.create_index(
        "ix_comms_messages_body_search",
        "comms_messages",
        ["body_tsv"],
        unique=False,
        postgresql_using="gin",
    )
    op.create_index("ix_comms_messages_deleted_by", "comms_messages", ["deleted_by"], unique=False)
    op.create_index(
        "ix_comms_messages_live_roots",
        "comms_messages",
        ["org_id", "conversation_id", "seq"],
        unique=False,
        postgresql_where=sa.text("parent_id IS NULL AND is_deleted = false"),
    )
    op.create_index("ix_comms_messages_pinned_by", "comms_messages", ["pinned_by"], unique=False)
    op.create_index(
        "ix_comms_messages_quote", "comms_messages", ["org_id", "reply_to_id"], unique=False
    )
    op.create_index(
        "ix_comms_messages_replies", "comms_messages", ["org_id", "parent_id", "seq"], unique=False
    )
    op.create_table(
        "comms_read_states",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("last_read_seq", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_read_states_deletion_state"),
        ),
        sa.CheckConstraint(
            "last_read_seq BETWEEN 0 AND 9007199254740991", name="ck_comms_read_states_sequence"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_read_states_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_read_states_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_read_states_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_read_states_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_read_states_pkey")),
        sa.UniqueConstraint(
            "org_id", "conversation_id", "user_id", name="uq_comms_read_states_conversation_user"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_read_states_org_id_id"),
    )
    op.create_index(
        "ix_comms_read_states_user", "comms_read_states", ["user_id", "org_id"], unique=False
    )
    op.create_table(
        "comms_realtime_grants",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_realtime_grants_conversation",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_realtime_grants_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_realtime_grants_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_realtime_grants_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_realtime_grants_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "user_id", "conversation_id", name="uq_comms_realtime_grants_subject"
        ),
    )
    op.create_index(
        "ix_comms_realtime_grants_conversation",
        "comms_realtime_grants",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_realtime_grants_expiry",
        "comms_realtime_grants",
        ["org_id", "expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_comms_realtime_grants_user", "comms_realtime_grants", ["user_id"], unique=False
    )
    op.create_table(
        "comms_retention_policies",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("message_days", sa.BigInteger(), nullable=True),
        sa.Column("file_days", sa.BigInteger(), nullable=True),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_retention_policies_deletion_state"),
        ),
        sa.CheckConstraint(
            "conversation_id IS NOT NULL OR (message_days IS NOT NULL AND file_days IS NOT NULL)",
            name="ck_comms_retention_policies_workspace",
        ),
        sa.CheckConstraint(
            "file_days IS NULL OR file_days BETWEEN 0 AND 9007199254740991",
            name="ck_comms_retention_policies_files",
        ),
        sa.CheckConstraint(
            "message_days IS NULL OR message_days BETWEEN 0 AND 9007199254740991",
            name="ck_comms_retention_policies_messages",
        ),
        sa.CheckConstraint(
            "revision BETWEEN 1 AND 2147483647", name="ck_comms_retention_policies_revision"
        ),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_comms_retention_policies_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_retention_policies_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_retention_policies_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_retention_policies_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_retention_policies_pkey")),
        sa.UniqueConstraint(
            "org_id",
            "conversation_id",
            name="uq_comms_retention_policies_scope",
            postgresql_nulls_not_distinct=True,
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_retention_policies_org_id_id"),
    )
    op.create_table(
        "comms_schedules",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("client_key", sa.Uuid(), nullable=False),
        sa.Column("request", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
        sa.CheckConstraint("jsonb_typeof(request) = 'object'", name="ck_comms_schedules_request"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_schedules_deletion_state"),
        ),
        sa.CheckConstraint("revision BETWEEN 1 AND 2147483647", name="ck_comms_schedules_revision"),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_comms_schedules_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_schedules_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_schedules_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_schedules_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_schedules_pkey")),
        sa.UniqueConstraint(
            "org_id", "author_id", "client_key", name="uq_comms_schedules_client_key"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_schedules_org_id_id"),
    )
    op.create_index(
        "ix_comms_schedules_conversation",
        "comms_schedules",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_table(
        "comms_settings",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column(
            "values",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
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
            "(scope = 'workspace' AND category_id IS NULL AND conversation_id IS "
            "NULL) OR (scope = 'category' AND category_id IS NOT NULL AND "
            "conversation_id IS NULL) OR (scope = 'channel' AND category_id IS NULL "
            "AND conversation_id IS NOT NULL)",
            name="ck_comms_settings_scope",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_settings_deletion_state"),
        ),
        sa.CheckConstraint("jsonb_typeof(\"values\") = 'object'", name="ck_comms_settings_values"),
        sa.ForeignKeyConstraint(
            ["org_id", "category_id"],
            ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_settings_category",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_settings_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_settings_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_settings_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_settings_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_settings_org_id_id"),
    )
    op.create_index(
        "ix_comms_settings_category", "comms_settings", ["org_id", "category_id"], unique=False
    )
    op.create_index(
        "ix_comms_settings_conversation",
        "comms_settings",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_index(
        "uq_comms_settings_active",
        "comms_settings",
        ["org_id", "scope", "category_id", "conversation_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "comms_typing",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_typing_conversation",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_typing_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_typing_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_typing_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_typing_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "user_id", "conversation_id", name="uq_comms_typing_user_conversation"
        ),
    )
    op.create_index(
        "ix_comms_typing_conversation", "comms_typing", ["org_id", "conversation_id"], unique=False
    )
    op.create_index("ix_comms_typing_user", "comms_typing", ["user_id"], unique=False)
    op.create_table(
        "dashboard_widgets",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("dashboard_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "widget_type", sa.String(length=20), server_default=sa.text("'chart'"), nullable=False
        ),
        sa.Column("grid_column", sa.Integer(), nullable=True),
        sa.Column("grid_row", sa.Integer(), nullable=True),
        sa.Column("column_span", sa.Integer(), nullable=True),
        sa.Column("row_span", sa.Integer(), nullable=True),
        sa.Column("chart_id", sa.Uuid(), nullable=True),
        sa.Column(
            "config", postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True
        ),
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
            "widget_type IN ('summary', 'workload', 'records', 'chart')",
            name="ck_dashboard_widgets_type",
        ),
        sa.CheckConstraint(
            "(config IS NOT NULL) <> (chart_id IS NOT NULL)",
            name="ck_dashboard_widgets_query_source",
        ),
        sa.CheckConstraint(
            "(grid_column IS NULL AND grid_row IS NULL AND column_span IS NULL AND "
            "row_span IS NULL) OR (grid_column IS NOT NULL AND grid_row IS NOT NULL "
            "AND column_span IS NOT NULL AND row_span IS NOT NULL AND grid_column "
            ">= 0 AND grid_row >= 0 AND column_span >= 1 AND row_span >= 1 AND "
            "grid_column + column_span <= 4 AND grid_row + row_span <= 5)",
            name="ck_dashboard_widgets_placement",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_dashboard_widgets_deletion_state"),
        ),
        sa.CheckConstraint("position >= 0 AND position < 20", name="ck_dashboard_widgets_position"),
        sa.ForeignKeyConstraint(
            ["org_id", "chart_id"],
            ["charts.org_id", "charts.id"],
            name="fk_dashboard_widgets_chart_id_charts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "dashboard_id"],
            ["dashboards.org_id", "dashboards.id"],
            name="fk_dashboard_widgets_dashboard_id_dashboards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_dashboard_widgets_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_dashboard_widgets_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("dashboard_widgets_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_dashboard_widgets_org_id_id"),
    )
    op.create_index(
        "ix_dashboard_widgets_chart_id", "dashboard_widgets", ["chart_id"], unique=False
    )
    op.create_index(
        "ix_dashboard_widgets_dashboard_id", "dashboard_widgets", ["dashboard_id"], unique=False
    )
    op.create_index(
        "uq_dashboard_widgets_active_position",
        "dashboard_widgets",
        ["dashboard_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "files",
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("purpose", sa.String(length=30), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=True),
        sa.Column("board_id", sa.Uuid(), nullable=True),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("creator_id", sa.UUID(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("media_type", sa.String(length=120), nullable=True),
        sa.Column("expected_size", sa.Integer(), nullable=False),
        sa.Column("actual_size", sa.Integer(), nullable=True),
        sa.Column("digest", sa.String(length=64), nullable=True),
        sa.Column("enc_version", sa.SmallInteger(), nullable=True),
        sa.Column("object_key", sa.String(length=100), nullable=False),
        sa.Column("state", sa.String(length=30), nullable=False),
        sa.Column("operation_id", sa.Uuid(), nullable=True),
        sa.Column("operation_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=60), nullable=True),
        sa.Column("deletion_origin", sa.String(length=30), nullable=True),
        sa.Column("retention_erased_at", sa.DateTime(timezone=True), nullable=True),
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
            "(purpose = 'record_attachment' AND record_id IS NOT NULL AND board_id "
            "IS NULL AND department_id IS NULL AND conversation_id IS NULL) OR "
            "(purpose = 'board_attachment' AND board_id IS NOT NULL AND record_id "
            "IS NULL AND department_id IS NULL AND conversation_id IS NULL) OR "
            "(purpose = 'library_document' AND department_id IS NOT NULL AND "
            "record_id IS NULL AND board_id IS NULL AND conversation_id IS NULL) OR "
            "(purpose = 'comms_attachment' AND conversation_id IS NOT NULL AND "
            "record_id IS NULL AND board_id IS NULL AND department_id IS NULL) OR "
            "(purpose IN ('workspace_logo','user_avatar') AND record_id IS NULL AND "
            "board_id IS NULL AND department_id IS NULL AND conversation_id IS "
            "NULL)",
            name="ck_files_purpose_parent",
        ),
        sa.CheckConstraint(
            "(purpose = 'user_avatar') = (org_id IS NULL)", name="ck_files_organization"
        ),
        sa.CheckConstraint(
            "deletion_origin IS NULL OR (((deletion_origin = 'logo_replacement' AND "
            "purpose = 'workspace_logo') OR (deletion_origin = 'avatar_replacement' "
            "AND purpose = 'user_avatar') OR (deletion_origin = 'comms_retention' "
            "AND purpose = 'comms_attachment')) AND is_deleted = true AND state = "
            "'deleting' AND operation_id IS NOT NULL)",
            name="ck_files_deletion_origin",
        ),
        sa.CheckConstraint(
            "purpose != 'user_avatar' OR (expected_size <= 2097152 AND (actual_size "
            "IS NULL OR actual_size <= 2097152))",
            name="ck_files_avatar_size",
        ),
        sa.CheckConstraint(
            "purpose != 'workspace_logo' OR expected_size <= 2097152", name="ck_files_logo_size"
        ),
        sa.CheckConstraint(
            "retention_erased_at IS NULL OR (purpose = 'comms_attachment' AND is_deleted = true)",
            name="ck_files_retention_erased",
        ),
        sa.CheckConstraint(
            "state != 'ready' OR (digest IS NOT NULL AND actual_size IS NOT NULL)",
            name="ck_files_ready_verdict",
        ),
        sa.CheckConstraint(
            "state IN ('awaiting_upload','uploading','ready','rejected','deleting','purged')",
            name="ck_files_state",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_files_deletion_state"),
        ),
        sa.CheckConstraint(
            "actual_size IS NULL OR (actual_size > 0 AND actual_size <= 10485760)",
            name="ck_files_actual_size",
        ),
        sa.CheckConstraint("enc_version IS NULL OR enc_version > 0", name="ck_files_enc_version"),
        sa.CheckConstraint(
            "expected_size > 0 AND expected_size <= 10485760", name="ck_files_expected_size"
        ),
        sa.ForeignKeyConstraint(
            ["creator_id"],
            ["users.id"],
            name=op.f("fk_files_creator_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_files_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_files_conversation_id_comms_conversations",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_files_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_files_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_files_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_files_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("files_pkey")),
        sa.UniqueConstraint("object_key", name=op.f("uq_files_object_key")),
        sa.UniqueConstraint("org_id", "id", name="uq_files_org_id_id"),
    )
    op.create_index(op.f("ix_files_board_id"), "files", ["board_id"], unique=False)
    op.create_index(op.f("ix_files_conversation_id"), "files", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_files_creator_id"), "files", ["creator_id"], unique=False)
    op.create_index(op.f("ix_files_department_id"), "files", ["department_id"], unique=False)
    op.create_index(op.f("ix_files_purpose"), "files", ["purpose"], unique=False)
    op.create_index(op.f("ix_files_record_id"), "files", ["record_id"], unique=False)
    op.create_table(
        "record_triggers",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("publication_id", sa.Uuid(), nullable=False),
        sa.Column("published_version_id", sa.Uuid(), nullable=False),
        sa.Column("publisher_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("priority", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("execution_position", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("event_kind", sa.String(length=24), nullable=False),
        sa.Column("trigger_field_id", sa.Uuid(), nullable=True),
        sa.Column("trigger_operator", sa.String(length=2), nullable=True),
        sa.Column("trigger_value_kind", sa.String(length=16), nullable=True),
        sa.Column("trigger_literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("trigger_value_field_id", sa.Uuid(), nullable=True),
        sa.Column("schedule_frequency", sa.String(length=8), nullable=True),
        sa.Column("schedule_time", sa.String(length=5), nullable=True),
        sa.Column("schedule_weekday", sa.Integer(), nullable=True),
        sa.Column("workspace_timezone", sa.String(length=64), nullable=False),
        sa.Column("condition_operator", sa.String(length=3), nullable=False),
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("suspension_reason", sa.String(length=240), nullable=True),
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
            "condition_operator IN ('all', 'any')", name="ck_record_triggers_condition_operator"
        ),
        sa.CheckConstraint(
            "event_kind IN ('record-created', 'field-changed', 'threshold-crossed', 'schedule')",
            name="ck_record_triggers_event_kind",
        ),
        sa.CheckConstraint(
            "trigger_value_kind IS NULL OR trigger_value_kind IN ('literal', 'field-reference')",
            name="ck_record_triggers_trigger_value_kind",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_record_triggers_deletion_state"),
        ),
        sa.CheckConstraint("execution_position >= 0", name="ck_record_triggers_execution_position"),
        sa.CheckConstraint(
            "priority >= -10000 AND priority <= 10000", name="ck_record_triggers_priority"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_record_triggers_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "publication_id"],
            ["sandbox_publications.org_id", "sandbox_publications.id"],
            name="fk_record_triggers_publication_id_sandbox_publications",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "published_version_id"],
            ["sandbox_versions.org_id", "sandbox_versions.id"],
            name="fk_record_triggers_published_version_id_sandbox_versions",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_triggers_trigger_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_value_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_triggers_trigger_value_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_triggers_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_triggers_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["publisher_id"],
            ["users.id"],
            name=op.f("fk_record_triggers_publisher_id_users"),
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_triggers_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_triggers_org_id_id"),
    )
    op.create_index(
        "ix_record_triggers_module", "record_triggers", ["module_id", "is_deleted"], unique=False
    )
    op.create_index(
        op.f("ix_record_triggers_publication_id"),
        "record_triggers",
        ["publication_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_triggers_published_version_id"),
        "record_triggers",
        ["published_version_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_triggers_publisher_id"), "record_triggers", ["publisher_id"], unique=False
    )
    op.create_index(
        op.f("ix_record_triggers_trigger_field_id"),
        "record_triggers",
        ["trigger_field_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_triggers_trigger_value_field_id"),
        "record_triggers",
        ["trigger_value_field_id"],
        unique=False,
    )
    op.create_table(
        "relationship_edges",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("field_id", sa.Uuid(), nullable=False),
        sa.Column("source_record_id", sa.Uuid(), nullable=False),
        sa.Column("target_record_id", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_relationship_edges_deletion_state"),
        ),
        sa.CheckConstraint(
            "source_record_id <> target_record_id", name="ck_relationship_edges_distinct_records"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_relationship_edges_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "source_record_id"],
            ["records.org_id", "records.id"],
            name="fk_relationship_edges_source_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "target_record_id"],
            ["records.org_id", "records.id"],
            name="fk_relationship_edges_target_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_relationship_edges_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_relationship_edges_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("relationship_edges_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_relationship_edges_org_id_id"),
    )
    op.create_index(
        "ix_relationship_edges_active_target",
        "relationship_edges",
        ["field_id", "target_record_id"],
        unique=False,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "ix_relationship_edges_source_record",
        "relationship_edges",
        ["org_id", "source_record_id"],
        unique=False,
    )
    op.create_index(
        "ix_relationship_edges_target_record",
        "relationship_edges",
        ["org_id", "target_record_id"],
        unique=False,
    )
    op.create_index(
        "uq_relationship_edges_active",
        "relationship_edges",
        ["field_id", "source_record_id", "target_record_id"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "report_runs",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(), nullable=False),
        sa.Column("recipe_revision", sa.Integer(), nullable=False),
        sa.Column("recipe", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("headings", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=False),
        sa.Column("csv_bytes", sa.LargeBinary(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_report_runs_deletion_state"),
        ),
        sa.CheckConstraint("recipe_revision > 0", name="ck_report_runs_recipe_revision_positive"),
        sa.CheckConstraint("row_count >= 0", name="ck_report_runs_row_count_nonnegative"),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_report_runs_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "report_id"],
            ["reports.org_id", "reports.id"],
            name="fk_report_runs_report_id_reports",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_runs_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_runs_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_report_runs_org_id_id"),
        sa.UniqueConstraint("report_id", "idempotency_key", name="uq_report_runs_idempotency"),
    )
    op.create_index("ix_report_runs_module", "report_runs", ["module_id"], unique=False)
    op.create_index(
        "ix_report_runs_report_created", "report_runs", ["report_id", "created_at"], unique=False
    )
    op.create_table(
        "report_schedules",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("report_id", sa.Uuid(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("cadence", sa.String(length=8), nullable=False),
        sa.Column("timezone_name", sa.String(length=64), nullable=False),
        sa.Column("local_time", sa.Time(), nullable=False),
        sa.Column("weekday", sa.Integer(), nullable=True),
        sa.Column("month_day", sa.Integer(), nullable=True),
        sa.Column("next_due_at", sa.DateTime(timezone=True), nullable=False),
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
            "(cadence = 'daily' AND weekday IS NULL AND month_day IS NULL) OR "
            "(cadence = 'weekly' AND weekday BETWEEN 0 AND 6 AND month_day IS NULL) "
            "OR (cadence = 'monthly' AND weekday IS NULL AND month_day BETWEEN 1 "
            "AND 31)",
            name="ck_report_schedules_anchor",
        ),
        sa.CheckConstraint(
            "cadence IN ('daily', 'weekly', 'monthly')", name="ck_report_schedules_cadence"
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_report_schedules_deletion_state"),
        ),
        sa.CheckConstraint(
            "EXTRACT(SECOND FROM local_time) = 0", name="ck_report_schedules_minute_time"
        ),
        sa.CheckConstraint(
            "length(btrim(timezone_name)) > 0", name="ck_report_schedules_timezone_nonempty"
        ),
        sa.CheckConstraint("revision > 0", name="ck_report_schedules_revision_positive"),
        sa.ForeignKeyConstraint(
            ["org_id", "report_id"],
            ["reports.org_id", "reports.id"],
            name="fk_report_schedules_report_id_reports",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_schedules_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_schedules_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_schedules_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_report_schedules_org_id_id"),
        sa.UniqueConstraint("report_id", name="uq_report_schedules_report"),
    )
    op.create_index(
        "ix_report_schedules_due",
        "report_schedules",
        ["enabled", "next_due_at", "id"],
        unique=False,
    )
    op.create_table(
        "board_attachments",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("post_id", sa.Uuid(), nullable=True),
        sa.Column("card_id", sa.Uuid(), nullable=True),
        sa.Column("is_linked", sa.Boolean(), server_default=sa.text("true"), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_attachments_deletion_state"),
        ),
        sa.CheckConstraint(
            "num_nonnulls(event_id, post_id, card_id) = 1", name="ck_board_attachments_one_owner"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_attachments_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "card_id"],
            ["board_cards.org_id", "board_cards.id"],
            name="fk_board_attachments_card_id_board_cards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "event_id"],
            ["board_events.org_id", "board_events.id"],
            name="fk_board_attachments_event_id_board_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "file_id"],
            ["files.org_id", "files.id"],
            name="fk_board_attachments_file_id_files",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_board_attachments_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_attachments_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_attachments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_attachments_pkey")),
        sa.UniqueConstraint("file_id", name="uq_board_attachments_file"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_attachments_org_id_id"),
    )
    op.create_index(
        "ix_board_attachments_board_id", "board_attachments", ["board_id"], unique=False
    )
    op.create_index("ix_board_attachments_card_id", "board_attachments", ["card_id"], unique=False)
    op.create_index(
        "ix_board_attachments_event_id", "board_attachments", ["event_id"], unique=False
    )
    op.create_index("ix_board_attachments_post_id", "board_attachments", ["post_id"], unique=False)
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
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_card_checklist_items_deletion_state"),
        ),
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
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_card_labels_deletion_state"),
        ),
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
        "board_post_revision_attachments",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_post_revision_attachments_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "file_id"],
            ["files.org_id", "files.id"],
            name="fk_board_post_revision_attachments_file_id_files",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "revision_id"],
            ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_board_revision_attachments_revision",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_post_revision_attachments_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revision_attachments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revision_attachments_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_post_revision_attachments_org_id_id"),
        sa.UniqueConstraint("revision_id", "file_id", name="uq_board_post_revision_attachments"),
    )
    op.create_index(
        "ix_board_post_revision_attachments_file_id",
        "board_post_revision_attachments",
        ["file_id"],
        unique=False,
    )
    op.create_table(
        "board_post_revision_record_links",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_post_revision_record_links_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_post_revision_record_links_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_board_post_revision_record_links_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "revision_id"],
            ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_board_revision_record_links_revision",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_post_revision_record_links_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_post_revision_record_links_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_post_revision_record_links_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_board_post_revision_record_links_org_id_id"),
        sa.UniqueConstraint("revision_id", "record_id", name="uq_board_revision_record_link"),
    )
    op.create_index(
        "ix_board_revision_record_links_module_id",
        "board_post_revision_record_links",
        ["module_id"],
        unique=False,
    )
    op.create_index(
        "ix_board_revision_record_links_record_id",
        "board_post_revision_record_links",
        ["record_id"],
        unique=False,
    )
    op.create_table(
        "board_record_links",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("board_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("post_id", sa.Uuid(), nullable=True),
        sa.Column("card_id", sa.Uuid(), nullable=True),
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_board_record_links_deletion_state"),
        ),
        sa.CheckConstraint(
            "num_nonnulls(event_id, post_id, card_id) = 1", name="ck_board_record_links_one_owner"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "board_id"],
            ["boards.org_id", "boards.id"],
            name="fk_board_record_links_board_id_boards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "card_id"],
            ["board_cards.org_id", "board_cards.id"],
            name="fk_board_record_links_card_id_board_cards",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "event_id"],
            ["board_events.org_id", "board_events.id"],
            name="fk_board_record_links_event_id_board_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_board_record_links_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_board_record_links_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_board_record_links_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_board_record_links_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_board_record_links_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("board_record_links_pkey")),
        sa.UniqueConstraint("card_id", "record_id", name="uq_board_card_record_link"),
        sa.UniqueConstraint("event_id", "record_id", name="uq_board_event_record_link"),
        sa.UniqueConstraint("org_id", "id", name="uq_board_record_links_org_id_id"),
        sa.UniqueConstraint("post_id", "record_id", name="uq_board_post_record_link"),
    )
    op.create_index(
        "ix_board_record_links_board_id", "board_record_links", ["board_id"], unique=False
    )
    op.create_index(
        "ix_board_record_links_module_id", "board_record_links", ["module_id"], unique=False
    )
    op.create_index(
        "ix_board_record_links_record_id", "board_record_links", ["record_id"], unique=False
    )
    op.create_table(
        "comms_export_entries",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("export_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_export_entries_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_export_entries_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "export_id", "conversation_id"],
            [
                "comms_export_sources.org_id",
                "comms_export_sources.export_id",
                "comms_export_sources.conversation_id",
            ],
            name="fk_comms_export_entries_source",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_export_entries_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_export_entries_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_export_entries_pkey")),
        sa.UniqueConstraint(
            "org_id", "export_id", "message_id", name="uq_comms_export_entries_message"
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_export_entries_org_id_id"),
    )
    op.create_index(
        "ix_comms_export_entries_expiry",
        "comms_export_entries",
        ["org_id", "message_id"],
        unique=False,
    )
    op.create_table(
        "comms_mentions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_mentions_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_mentions_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_mentions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_mentions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_mentions_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_mentions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_mentions_org_id_id"),
        sa.UniqueConstraint("org_id", "message_id", "user_id", name="uq_comms_mentions_user"),
    )
    op.create_index("ix_comms_mentions_user", "comms_mentions", ["user_id", "org_id"], unique=False)
    op.create_table(
        "comms_message_attachments",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_message_attachments_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "file_id"],
            ["files.org_id", "files.id"],
            name="fk_comms_message_attachments_file",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_message_attachments_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_message_attachments_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_message_attachments_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_message_attachments_pkey")),
        sa.UniqueConstraint("org_id", "file_id", name="uq_comms_message_attachments_file"),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_message_attachments_org_id_id"),
    )
    op.create_index(
        "ix_comms_message_attachments_message",
        "comms_message_attachments",
        ["org_id", "message_id"],
        unique=False,
    )
    op.create_table(
        "comms_message_record_links",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_message_record_links_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_message_record_links_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_comms_message_record_links_module",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_comms_message_record_links_record",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_message_record_links_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_message_record_links_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_message_record_links_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_message_record_links_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "message_id", "record_id", name="uq_comms_message_record_links_record"
        ),
    )
    op.create_index(
        "ix_comms_message_record_links_module",
        "comms_message_record_links",
        ["org_id", "module_id"],
        unique=False,
    )
    op.create_index(
        "ix_comms_message_record_links_record",
        "comms_message_record_links",
        ["org_id", "record_id"],
        unique=False,
    )
    op.create_table(
        "comms_message_revisions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_message_revisions_deletion_state"),
        ),
        sa.CheckConstraint(
            "char_length(body) <= 4000", name="ck_comms_message_revisions_body_length"
        ),
        sa.ForeignKeyConstraint(
            ["author_id"],
            ["users.id"],
            name=op.f("fk_comms_message_revisions_author_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_message_revisions_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_message_revisions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_message_revisions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_message_revisions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_message_revisions_org_id_id"),
    )
    op.create_index(
        "ix_comms_message_revisions_author", "comms_message_revisions", ["author_id"], unique=False
    )
    op.create_index(
        "ix_comms_message_revisions_history",
        "comms_message_revisions",
        ["org_id", "message_id", "created_at", "id"],
        unique=False,
    )
    op.create_table(
        "comms_reactions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("emoji", sa.Text(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_reactions_deletion_state"),
        ),
        sa.CheckConstraint("char_length(emoji) > 0", name="ck_comms_reactions_emoji"),
        sa.ForeignKeyConstraint(
            ["org_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_reactions_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_reactions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_reactions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_reactions_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_reactions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_reactions_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "message_id", "user_id", "emoji", name="uq_comms_reactions_user"
        ),
    )
    op.create_index("ix_comms_reactions_user", "comms_reactions", ["user_id"], unique=False)
    op.create_table(
        "comms_reports",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("reporter_id", sa.UUID(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
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
        sa.CheckConstraint("status IN ('open','resolved')", name="ck_comms_reports_status"),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_reports_deletion_state"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(reason)) BETWEEN 1 AND 2000", name="ck_comms_reports_reason"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_reports_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_reports_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_reports_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["reporter_id"],
            ["users.id"],
            name=op.f("fk_comms_reports_reporter_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_reports_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_reports_org_id_id"),
    )
    op.create_index(
        "ix_comms_reports_queue", "comms_reports", ["org_id", "created_at", "id"], unique=False
    )
    op.create_index("ix_comms_reports_reporter", "comms_reports", ["reporter_id"], unique=False)
    op.create_index(
        "ix_comms_reports_source",
        "comms_reports",
        ["org_id", "conversation_id", "message_id"],
        unique=False,
    )
    op.create_table(
        "comms_thread_follows",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("root_message_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_thread_follows_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "root_message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_thread_follows_root",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_thread_follows_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_thread_follows_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_comms_thread_follows_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_thread_follows_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_thread_follows_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "root_message_id", "user_id", name="uq_comms_thread_follows_user"
        ),
    )
    op.create_index(
        "ix_comms_thread_follows_user", "comms_thread_follows", ["user_id", "org_id"], unique=False
    )
    op.create_table(
        "comms_threads",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("root_message_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("resolved", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("locked", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_comms_threads_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id", "root_message_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_threads_root",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_threads_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_comms_threads_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_comms_threads_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("comms_threads_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_comms_threads_org_id_id"),
        sa.UniqueConstraint("org_id", "root_message_id", name="uq_comms_threads_root"),
    )
    op.create_index(
        "ix_comms_threads_conversation",
        "comms_threads",
        ["org_id", "conversation_id"],
        unique=False,
    )
    op.create_table(
        "record_trigger_actions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("trigger_id", sa.Uuid(), nullable=False),
        sa.Column("target_field_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("value_kind", sa.String(length=16), nullable=False),
        sa.Column("literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("value_field_id", sa.Uuid(), nullable=True),
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
        sa.CheckConstraint("kind = 'set-field'", name="ck_record_trigger_actions_supported_kind"),
        sa.CheckConstraint(
            "value_kind IN ('literal', 'field-reference')",
            name="ck_record_trigger_actions_value_kind",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_record_trigger_actions_deletion_state"),
        ),
        sa.CheckConstraint("position >= 0", name="ck_record_trigger_actions_position"),
        sa.ForeignKeyConstraint(
            ["org_id", "target_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_actions_target_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_actions_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "value_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_actions_value_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_actions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_actions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_actions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_actions_org_id_id"),
    )
    op.create_index(
        op.f("ix_record_trigger_actions_target_field_id"),
        "record_trigger_actions",
        ["target_field_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_actions_trigger_id"),
        "record_trigger_actions",
        ["trigger_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_actions_value_field_id"),
        "record_trigger_actions",
        ["value_field_id"],
        unique=False,
    )
    op.create_index(
        "uq_record_trigger_actions_position_active",
        "record_trigger_actions",
        ["trigger_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "record_trigger_conditions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("trigger_id", sa.Uuid(), nullable=False),
        sa.Column("field_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("operator", sa.String(length=2), nullable=False),
        sa.Column("value_kind", sa.String(length=16), nullable=False),
        sa.Column("literal_value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("value_field_id", sa.Uuid(), nullable=True),
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
            "operator IN ('>', '>=', '<', '<=', '=', '!=')",
            name="ck_record_trigger_conditions_operator",
        ),
        sa.CheckConstraint(
            "value_kind IN ('literal', 'field-reference')",
            name="ck_record_trigger_conditions_value_kind",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_record_trigger_conditions_deletion_state"),
        ),
        sa.CheckConstraint("position >= 0", name="ck_record_trigger_conditions_position"),
        sa.ForeignKeyConstraint(
            ["org_id", "field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_conditions_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_conditions_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "value_field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_record_trigger_conditions_value_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_conditions_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_conditions_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_conditions_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_conditions_org_id_id"),
    )
    op.create_index(
        op.f("ix_record_trigger_conditions_field_id"),
        "record_trigger_conditions",
        ["field_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_conditions_trigger_id"),
        "record_trigger_conditions",
        ["trigger_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_conditions_value_field_id"),
        "record_trigger_conditions",
        ["value_field_id"],
        unique=False,
    )
    op.create_index(
        "uq_record_trigger_conditions_position_active",
        "record_trigger_conditions",
        ["trigger_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "record_trigger_events",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=True),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("scheduled_trigger_id", sa.Uuid(), nullable=True),
        sa.Column("event_kind", sa.String(length=24), nullable=False),
        sa.Column("changed_field_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("previous_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("root_event_id", sa.Uuid(), nullable=True),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("action_budget", sa.Integer(), nullable=False),
        sa.Column("schedule_upper_record_id", sa.UUID(), nullable=True),
        sa.Column("schedule_cursor_record_id", sa.UUID(), nullable=True),
        sa.Column(
            "schedule_matched_count", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "schedule_action_count", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("schedule_key", sa.String(length=120), nullable=True),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
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
            "(event_kind = 'schedule' AND scheduled_trigger_id IS NOT NULL) OR "
            "(event_kind IN ('record-created', 'field-changed') AND "
            "scheduled_trigger_id IS NULL AND record_id IS NOT NULL)",
            name="ck_record_trigger_events_subject",
        ),
        sa.CheckConstraint(
            "(event_kind = 'schedule') OR (schedule_upper_record_id IS NULL AND "
            "schedule_cursor_record_id IS NULL AND schedule_matched_count = 0 AND "
            "schedule_action_count = 0)",
            name="ck_record_trigger_events_schedule_progress",
        ),
        sa.CheckConstraint(
            "(state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS "
            "NOT NULL) OR (state <> 'running' AND lease_token IS NULL AND "
            "lease_expires_at IS NULL)",
            name="ck_record_trigger_events_lease",
        ),
        sa.CheckConstraint(
            "event_kind IN ('record-created', 'field-changed', 'schedule')",
            name="ck_record_trigger_events_kind",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'failed')",
            name="ck_record_trigger_events_state",
        ),
        sa.CheckConstraint(
            "(depth = 0 AND root_event_id IS NULL) OR (depth > 0 AND root_event_id IS NOT NULL)",
            name="ck_record_trigger_events_root_depth",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_record_trigger_events_deletion_state"),
        ),
        sa.CheckConstraint(
            "action_budget >= 0 AND action_budget <= 100", name="ck_record_trigger_events_budget"
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5",
            name="ck_record_trigger_events_attempt_count",
        ),
        sa.CheckConstraint("depth >= 0 AND depth <= 10", name="ck_record_trigger_events_depth"),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_record_trigger_events_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_record_trigger_events_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "root_event_id"],
            ["record_trigger_events.org_id", "record_trigger_events.id"],
            name="fk_record_trigger_events_root_event_id_record_trigger_events",
            ondelete="RESTRICT",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "scheduled_trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_events_scheduled_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_events_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_events_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_events_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_events_org_id_id"),
        sa.UniqueConstraint("schedule_key", name=op.f("uq_record_trigger_events_schedule_key")),
    )
    op.create_index(
        "ix_record_trigger_events_due",
        "record_trigger_events",
        ["state", "next_attempt_at", "id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_module_id"),
        "record_trigger_events",
        ["module_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_record_id"),
        "record_trigger_events",
        ["record_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_root_event_id"),
        "record_trigger_events",
        ["root_event_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_record_trigger_events_scheduled_trigger_id"),
        "record_trigger_events",
        ["scheduled_trigger_id"],
        unique=False,
    )
    op.create_table(
        "report_run_eligible_users",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["org_id", "run_id"],
            ["report_runs.org_id", "report_runs.id"],
            name="fk_report_run_eligible_users_run_id_report_runs",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_run_eligible_users_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_report_run_eligible_users_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("run_id", "user_id", name=op.f("report_run_eligible_users_pkey")),
    )
    op.create_index(
        op.f("ix_report_run_eligible_users_org_id"),
        "report_run_eligible_users",
        ["org_id"],
        unique=False,
    )
    op.create_index(
        "ix_report_run_eligible_users_user_run",
        "report_run_eligible_users",
        ["user_id", "run_id"],
        unique=False,
    )
    op.create_table(
        "report_run_rows",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("cells", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_report_run_rows_deletion_state"),
        ),
        sa.CheckConstraint("position >= 0", name="ck_report_run_rows_position_nonnegative"),
        sa.ForeignKeyConstraint(
            ["org_id", "record_id"],
            ["records.org_id", "records.id"],
            name="fk_report_run_rows_record_id_records",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "run_id"],
            ["report_runs.org_id", "report_runs.id"],
            name="fk_report_run_rows_run_id_report_runs",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_report_run_rows_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_report_run_rows_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("report_run_rows_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_report_run_rows_org_id_id"),
        sa.UniqueConstraint("run_id", "position", name="uq_report_run_rows_position"),
        sa.UniqueConstraint("run_id", "record_id", name="uq_report_run_rows_record"),
    )
    op.create_index("ix_report_run_rows_record", "report_run_rows", ["record_id"], unique=False)
    op.create_table(
        "sandbox_bindings",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("sandbox_id", sa.String(length=1000), nullable=False),
        sa.Column("department_id", sa.Uuid(), nullable=True),
        sa.Column("module_id", sa.Uuid(), nullable=True),
        sa.Column("field_id", sa.Uuid(), nullable=True),
        sa.Column("trigger_id", sa.Uuid(), nullable=True),
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
            "(kind = 'department' AND department_id IS NOT NULL AND module_id IS "
            "NULL AND field_id IS NULL AND trigger_id IS NULL) OR (kind = 'module' "
            "AND department_id IS NULL AND module_id IS NOT NULL AND field_id IS "
            "NULL AND trigger_id IS NULL) OR (kind IN ('field', 'relationship') AND "
            "department_id IS NULL AND module_id IS NULL AND field_id IS NOT NULL "
            "AND trigger_id IS NULL) OR (kind = 'trigger' AND department_id IS NULL "
            "AND module_id IS NULL AND field_id IS NULL AND trigger_id IS NOT NULL)",
            name="ck_sandbox_bindings_exactly_one_live_target",
        ),
        sa.CheckConstraint(
            "kind IN ('department', 'module', 'field', 'relationship', 'trigger')",
            name="ck_sandbox_bindings_kind",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_sandbox_bindings_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "department_id"],
            ["departments.org_id", "departments.id"],
            name="fk_sandbox_bindings_department_id_departments",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "field_id"],
            ["fields.org_id", "fields.id"],
            name="fk_sandbox_bindings_field_id_fields",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "module_id"],
            ["modules.org_id", "modules.id"],
            name="fk_sandbox_bindings_module_id_modules",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_sandbox_bindings_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_sandbox_bindings_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_sandbox_bindings_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_bindings_pkey")),
        sa.UniqueConstraint("org_id", "department_id", name="uq_sandbox_bindings_department_id"),
        sa.UniqueConstraint("org_id", "field_id", name="uq_sandbox_bindings_field_id"),
        sa.UniqueConstraint("org_id", "id", name="uq_sandbox_bindings_org_id_id"),
        sa.UniqueConstraint(
            "org_id", "kind", "sandbox_id", name="uq_sandbox_bindings_kind_sandbox_id"
        ),
        sa.UniqueConstraint("org_id", "module_id", name="uq_sandbox_bindings_module_id"),
        sa.UniqueConstraint("org_id", "trigger_id", name="uq_sandbox_bindings_trigger_id"),
    )
    op.create_table(
        "scheduled_work",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "kind", sa.String(length=24), server_default=sa.text("'report-run'"), nullable=False
        ),
        sa.Column("report_id", sa.Uuid(), nullable=True),
        sa.Column("comms_schedule_id", sa.Uuid(), nullable=True),
        sa.Column("comms_export_id", sa.Uuid(), nullable=True),
        sa.Column("comms_message_id", sa.Uuid(), nullable=True),
        sa.Column("comms_preview_message_id", sa.Uuid(), nullable=True),
        sa.Column("comms_preview_generation", sa.BigInteger(), nullable=True),
        sa.Column("post_id", sa.Uuid(), nullable=True),
        sa.Column("reminder_id", sa.Uuid(), nullable=True),
        sa.Column("occurrence_start_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source_revision", sa.Integer(), nullable=True),
        sa.Column("scheduling_actor_id", sa.UUID(), nullable=True),
        sa.Column("publication_result_id", sa.Uuid(), nullable=True),
        sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("last_attempt_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("failure_code", sa.String(length=48), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "(((((kind = 'report-run' AND report_id IS NOT NULL AND post_id IS NULL "
            "AND reminder_id IS NULL AND occurrence_start_at IS NULL AND "
            "source_revision IS NULL AND scheduling_actor_id IS NULL AND "
            "publication_result_id IS NULL) OR (kind = 'post-publish' AND report_id "
            "IS NULL AND reminder_id IS NULL AND occurrence_start_at IS NULL AND "
            "post_id IS NOT NULL AND source_revision IS NOT NULL AND "
            "source_revision > 0 AND scheduling_actor_id IS NOT NULL AND run_id IS "
            "NULL) OR (kind = 'event-reminder' AND report_id IS NULL AND post_id IS "
            "NULL AND reminder_id IS NOT NULL AND occurrence_start_at IS NOT NULL "
            "AND source_revision IS NULL AND scheduling_actor_id IS NULL AND "
            "publication_result_id IS NULL AND run_id IS NULL)) AND "
            "comms_schedule_id IS NULL AND comms_export_id IS NULL AND "
            "comms_message_id IS NULL) OR (kind = 'comms-scheduled-message' AND "
            "comms_schedule_id IS NOT NULL AND comms_export_id IS NULL AND "
            "report_id IS NULL AND post_id IS NULL AND reminder_id IS NULL AND "
            "occurrence_start_at IS NULL AND run_id IS NULL AND "
            "publication_result_id IS NULL AND scheduling_actor_id IS NOT NULL AND "
            "source_revision IS NOT NULL AND source_revision > 0) OR (kind = "
            "'comms-export' AND comms_export_id IS NOT NULL AND comms_schedule_id "
            "IS NULL AND comms_message_id IS NULL AND report_id IS NULL AND post_id "
            "IS NULL AND reminder_id IS NULL AND occurrence_start_at IS NULL AND "
            "run_id IS NULL AND publication_result_id IS NULL AND "
            "scheduling_actor_id IS NOT NULL AND source_revision IS NULL)) AND "
            "comms_preview_message_id IS NULL AND comms_preview_generation IS NULL) "
            "OR (kind = 'comms-link-preview' AND comms_preview_message_id IS NOT "
            "NULL AND comms_preview_generation IS NOT NULL AND "
            "comms_preview_generation BETWEEN 0 AND 9007199254740991 AND "
            "scheduling_actor_id IS NOT NULL AND report_id IS NULL AND post_id IS "
            "NULL AND reminder_id IS NULL AND occurrence_start_at IS NULL AND "
            "source_revision IS NULL AND publication_result_id IS NULL AND run_id "
            "IS NULL AND comms_schedule_id IS NULL AND comms_export_id IS NULL AND "
            "comms_message_id IS NULL)",
            name="ck_scheduled_work_source",
        ),
        sa.CheckConstraint(
            "(kind = 'report-run' AND ((state = 'succeeded' AND run_id IS NOT NULL) "
            "OR (state <> 'succeeded' AND run_id IS NULL))) OR (kind = "
            "'post-publish' AND ((state = 'succeeded' AND publication_result_id IS "
            "NOT NULL) OR (state <> 'succeeded' AND publication_result_id IS "
            "NULL))) OR (kind IN "
            "('event-reminder','comms-export','comms-link-preview') AND run_id IS "
            "NULL AND publication_result_id IS NULL) OR (kind = "
            "'comms-scheduled-message' AND ((state = 'succeeded' AND "
            "comms_message_id IS NOT NULL) OR (state <> 'succeeded' AND "
            "comms_message_id IS NULL)))",
            name="ck_scheduled_work_run",
        ),
        sa.CheckConstraint(
            "(state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS "
            "NOT NULL) OR (state <> 'running' AND lease_token IS NULL AND "
            "lease_expires_at IS NULL)",
            name="ck_scheduled_work_lease",
        ),
        sa.CheckConstraint(
            "kind IN ('report-run', 'post-publish', 'event-reminder', "
            "'comms-scheduled-message', 'comms-export', 'comms-link-preview')",
            name="ck_scheduled_work_kind",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'running', 'succeeded', 'failed', 'canceled')",
            name="ck_scheduled_work_state",
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5", name="ck_scheduled_work_attempt_count"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "comms_export_id"],
            ["comms_exports.org_id", "comms_exports.id"],
            name="fk_scheduled_work_comms_export",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "comms_message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_scheduled_work_comms_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "comms_preview_message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_scheduled_work_comms_preview_message",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "comms_schedule_id"],
            ["comms_schedules.org_id", "comms_schedules.id"],
            name="fk_scheduled_work_comms_schedule",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "post_id"],
            ["board_posts.org_id", "board_posts.id"],
            name="fk_scheduled_work_post_id_board_posts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "publication_result_id"],
            ["board_post_revisions.org_id", "board_post_revisions.id"],
            name="fk_scheduled_work_publication_result_id_board_post_revisions",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "reminder_id"],
            ["board_event_reminders.org_id", "board_event_reminders.id"],
            name="fk_scheduled_work_reminder_id_board_event_reminders",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "report_id"],
            ["reports.org_id", "reports.id"],
            name="fk_scheduled_work_report_id_reports",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "run_id"],
            ["report_runs.org_id", "report_runs.id"],
            name="fk_scheduled_work_run_id_report_runs",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_scheduled_work_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["scheduling_actor_id"],
            ["users.id"],
            name=op.f("fk_scheduled_work_scheduling_actor_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("scheduled_work_pkey")),
        sa.UniqueConstraint("comms_export_id", name="uq_scheduled_work_comms_export"),
        sa.UniqueConstraint("comms_schedule_id", name="uq_scheduled_work_comms_schedule"),
        sa.UniqueConstraint(
            "org_id",
            "comms_preview_message_id",
            "comms_preview_generation",
            name="uq_scheduled_work_comms_preview_generation",
        ),
        sa.UniqueConstraint("org_id", "id", name="uq_scheduled_work_org_id_id"),
        sa.UniqueConstraint("post_id", "source_revision", name="uq_scheduled_work_post_occurrence"),
        sa.UniqueConstraint(
            "reminder_id", "occurrence_start_at", name="uq_scheduled_work_reminder"
        ),
        sa.UniqueConstraint(
            "report_id", "scheduled_for", name="uq_scheduled_work_report_occurrence"
        ),
        sa.UniqueConstraint("run_id", name="uq_scheduled_work_run"),
    )
    op.create_index(
        "ix_scheduled_work_comms_message",
        "scheduled_work",
        ["org_id", "comms_message_id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_due",
        "scheduled_work",
        ["kind", "state", "next_attempt_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_expired",
        "scheduled_work",
        ["kind", "state", "lease_expires_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_publication_result_id",
        "scheduled_work",
        ["publication_result_id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_scheduling_actor_id",
        "scheduled_work",
        ["scheduling_actor_id"],
        unique=False,
    )
    op.create_index(
        "uq_scheduled_work_active_comms_preview",
        "scheduled_work",
        ["org_id", "comms_preview_message_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'comms-link-preview' AND state IN ('pending','running')"),
    )
    op.create_table(
        "in_app_notifications",
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("subject_type", sa.String(length=24), nullable=False),
        sa.Column("subject_id", sa.UUID(), nullable=False),
        sa.Column("work_id", sa.Uuid(), nullable=True),
        sa.Column("comms_conversation_id", sa.Uuid(), nullable=True),
        sa.Column("recipient_id", sa.UUID(), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
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
            "(kind = 'backup-failed') = (org_id IS NULL)",
            name="ck_in_app_notifications_organization",
        ),
        sa.CheckConstraint(
            "(kind = 'report-run' AND subject_type = 'report_run' AND work_id IS "
            "NOT NULL) OR (kind = 'post-publish' AND subject_type = 'board_post' "
            "AND work_id IS NOT NULL) OR (kind = 'event-reminder' AND subject_type "
            "= 'board_event' AND work_id IS NOT NULL) OR (kind = "
            "'report-run-failed' AND subject_type = 'scheduled_work' AND work_id IS "
            "NOT NULL AND subject_id = work_id) OR (kind = 'backup-failed' AND "
            "subject_type = 'backup_run' AND work_id IS NULL) OR (kind = "
            "'record-assigned' AND subject_type = 'record' AND work_id IS NULL) OR "
            "(kind = 'invitation-accepted' AND subject_type = 'user' AND work_id IS "
            "NULL) OR (kind = 'sandbox-published' AND subject_type = "
            "'sandbox_version' AND work_id IS NULL) OR (kind = 'access-changed' AND "
            "subject_type = 'user' AND work_id IS NULL AND subject_id = "
            "recipient_id) OR (kind IN "
            "('comms-mention','comms-direct','comms-thread-reply','comms-keyword') "
            "AND subject_type = 'comms_message' AND work_id IS NULL AND org_id IS "
            "NOT NULL)",
            name="ck_in_app_notifications_reference",
        ),
        sa.CheckConstraint(
            "(subject_type = 'comms_message') = (comms_conversation_id IS NOT NULL)",
            name="ck_in_app_notifications_comms_reference",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_in_app_notifications_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "comms_conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_in_app_notifications_comms_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "work_id"],
            ["scheduled_work.org_id", "scheduled_work.id"],
            name="fk_in_app_notifications_work_id_scheduled_work",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_in_app_notifications_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_in_app_notifications_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.ForeignKeyConstraint(
            ["recipient_id"],
            ["users.id"],
            name=op.f("fk_in_app_notifications_recipient_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("in_app_notifications_pkey")),
        sa.UniqueConstraint("org_id", "id", name="uq_in_app_notifications_org_id_id"),
        sa.UniqueConstraint(
            "work_id", "recipient_id", name="uq_in_app_notifications_work_recipient"
        ),
    )
    op.create_index(
        "ix_in_app_notifications_recipient_created",
        "in_app_notifications",
        ["recipient_id", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_in_app_notifications_recipient_unread",
        "in_app_notifications",
        ["recipient_id", "created_at", "id"],
        unique=False,
        postgresql_where=sa.text("read_at IS NULL AND is_deleted = false"),
    )
    op.create_index(
        "uq_in_app_notifications_comms_recipient",
        "in_app_notifications",
        ["org_id", "recipient_id", "subject_id"],
        unique=True,
        postgresql_where=sa.text("subject_type = 'comms_message'"),
    )
    op.create_table(
        "record_trigger_runs",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("trigger_id", sa.Uuid(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            "state IN ('succeeded', 'skipped', 'suspended', 'failed')",
            name="ck_record_trigger_runs_state",
        ),
        sa.CheckConstraint(
            "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)",
            name=op.f("ck_record_trigger_runs_deletion_state"),
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "event_id"],
            ["record_trigger_events.org_id", "record_trigger_events.id"],
            name="fk_record_trigger_runs_event_id_record_trigger_events",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "trigger_id"],
            ["record_triggers.org_id", "record_triggers.id"],
            name="fk_record_trigger_runs_trigger_id_record_triggers",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_record_trigger_runs_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_record_trigger_runs_performed_by_users"),
            ondelete="SET NULL",
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("record_trigger_runs_pkey")),
        sa.UniqueConstraint("event_id", "trigger_id", name="uq_record_trigger_runs_event_trigger"),
        sa.UniqueConstraint("org_id", "id", name="uq_record_trigger_runs_org_id_id"),
    )
    op.create_index(
        "ix_record_trigger_runs_created", "record_trigger_runs", ["created_at", "id"], unique=False
    )
    op.create_index(
        op.f("ix_record_trigger_runs_trigger_id"),
        "record_trigger_runs",
        ["trigger_id"],
        unique=False,
    )
    # ### end Alembic commands ###
    for statement in (
        *FUNCTIONS,
        *DEFERRED_FOREIGN_KEYS,
        *TRIGGERS,
        *ROW_SECURITY,
        *POLICIES,
        *PRIVILEGES,
    ):
        op.execute(statement)
    # New functions are not executable by default. A schema-only dump of public does
    # not show this installation-wide default, so it is stated here.
    op.execute(
        "ALTER DEFAULT PRIVILEGES FOR ROLE slateops_owner "
        "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role"
    )
    # Audit and security events are append-only for the application role. The default
    # privileges above grant every table full DML, so remove the rest explicitly.
    op.execute(
        "REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.audit_logs, "
        "public.security_events "
        "FROM slateops_app"
    )
    # Only installation policy is seeded; no organization, Sandbox document or Board.
    op.execute(
        "INSERT INTO public.platform_settings (id) VALUES ('00000000-0000-7000-8000-000000000003')"
    )


def downgrade() -> None:
    # Destructive fresh-root removal, never a data-preserving rollback.
    for table, name in DEFERRED_FOREIGN_KEY_NAMES:
        op.drop_constraint(name, table, type_="foreignkey")
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index(op.f("ix_record_trigger_runs_trigger_id"), table_name="record_trigger_runs")
    op.drop_index("ix_record_trigger_runs_created", table_name="record_trigger_runs")
    op.drop_table("record_trigger_runs")
    op.drop_index(
        "uq_in_app_notifications_comms_recipient",
        table_name="in_app_notifications",
        postgresql_where=sa.text("subject_type = 'comms_message'"),
    )
    op.drop_index(
        "ix_in_app_notifications_recipient_unread",
        table_name="in_app_notifications",
        postgresql_where=sa.text("read_at IS NULL AND is_deleted = false"),
    )
    op.drop_index("ix_in_app_notifications_recipient_created", table_name="in_app_notifications")
    op.drop_table("in_app_notifications")
    op.drop_index(
        "uq_scheduled_work_active_comms_preview",
        table_name="scheduled_work",
        postgresql_where=sa.text("kind = 'comms-link-preview' AND state IN ('pending','running')"),
    )
    op.drop_index("ix_scheduled_work_scheduling_actor_id", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_publication_result_id", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_expired", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_due", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_comms_message", table_name="scheduled_work")
    op.drop_table("scheduled_work")
    op.drop_table("sandbox_bindings")
    op.drop_index("ix_report_run_rows_record", table_name="report_run_rows")
    op.drop_table("report_run_rows")
    op.drop_index("ix_report_run_eligible_users_user_run", table_name="report_run_eligible_users")
    op.drop_index(
        op.f("ix_report_run_eligible_users_org_id"), table_name="report_run_eligible_users"
    )
    op.drop_table("report_run_eligible_users")
    op.drop_index(
        op.f("ix_record_trigger_events_scheduled_trigger_id"), table_name="record_trigger_events"
    )
    op.drop_index(
        op.f("ix_record_trigger_events_root_event_id"), table_name="record_trigger_events"
    )
    op.drop_index(op.f("ix_record_trigger_events_record_id"), table_name="record_trigger_events")
    op.drop_index(op.f("ix_record_trigger_events_module_id"), table_name="record_trigger_events")
    op.drop_index("ix_record_trigger_events_due", table_name="record_trigger_events")
    op.drop_table("record_trigger_events")
    op.drop_index(
        "uq_record_trigger_conditions_position_active",
        table_name="record_trigger_conditions",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        op.f("ix_record_trigger_conditions_value_field_id"), table_name="record_trigger_conditions"
    )
    op.drop_index(
        op.f("ix_record_trigger_conditions_trigger_id"), table_name="record_trigger_conditions"
    )
    op.drop_index(
        op.f("ix_record_trigger_conditions_field_id"), table_name="record_trigger_conditions"
    )
    op.drop_table("record_trigger_conditions")
    op.drop_index(
        "uq_record_trigger_actions_position_active",
        table_name="record_trigger_actions",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        op.f("ix_record_trigger_actions_value_field_id"), table_name="record_trigger_actions"
    )
    op.drop_index(op.f("ix_record_trigger_actions_trigger_id"), table_name="record_trigger_actions")
    op.drop_index(
        op.f("ix_record_trigger_actions_target_field_id"), table_name="record_trigger_actions"
    )
    op.drop_table("record_trigger_actions")
    op.drop_index("ix_comms_threads_conversation", table_name="comms_threads")
    op.drop_table("comms_threads")
    op.drop_index("ix_comms_thread_follows_user", table_name="comms_thread_follows")
    op.drop_table("comms_thread_follows")
    op.drop_index("ix_comms_reports_source", table_name="comms_reports")
    op.drop_index("ix_comms_reports_reporter", table_name="comms_reports")
    op.drop_index("ix_comms_reports_queue", table_name="comms_reports")
    op.drop_table("comms_reports")
    op.drop_index("ix_comms_reactions_user", table_name="comms_reactions")
    op.drop_table("comms_reactions")
    op.drop_index("ix_comms_message_revisions_history", table_name="comms_message_revisions")
    op.drop_index("ix_comms_message_revisions_author", table_name="comms_message_revisions")
    op.drop_table("comms_message_revisions")
    op.drop_index("ix_comms_message_record_links_record", table_name="comms_message_record_links")
    op.drop_index("ix_comms_message_record_links_module", table_name="comms_message_record_links")
    op.drop_table("comms_message_record_links")
    op.drop_index("ix_comms_message_attachments_message", table_name="comms_message_attachments")
    op.drop_table("comms_message_attachments")
    op.drop_index("ix_comms_mentions_user", table_name="comms_mentions")
    op.drop_table("comms_mentions")
    op.drop_index("ix_comms_export_entries_expiry", table_name="comms_export_entries")
    op.drop_table("comms_export_entries")
    op.drop_index("ix_board_record_links_record_id", table_name="board_record_links")
    op.drop_index("ix_board_record_links_module_id", table_name="board_record_links")
    op.drop_index("ix_board_record_links_board_id", table_name="board_record_links")
    op.drop_table("board_record_links")
    op.drop_index(
        "ix_board_revision_record_links_record_id", table_name="board_post_revision_record_links"
    )
    op.drop_index(
        "ix_board_revision_record_links_module_id", table_name="board_post_revision_record_links"
    )
    op.drop_table("board_post_revision_record_links")
    op.drop_index(
        "ix_board_post_revision_attachments_file_id", table_name="board_post_revision_attachments"
    )
    op.drop_table("board_post_revision_attachments")
    op.drop_index("ix_board_card_labels_label_id", table_name="board_card_labels")
    op.drop_index("ix_board_card_labels_board_id", table_name="board_card_labels")
    op.drop_table("board_card_labels")
    op.drop_index(
        "uq_board_card_checklist_items_card_position", table_name="board_card_checklist_items"
    )
    op.drop_index("ix_board_card_checklist_items_board_id", table_name="board_card_checklist_items")
    op.drop_table("board_card_checklist_items")
    op.drop_index("ix_board_attachments_post_id", table_name="board_attachments")
    op.drop_index("ix_board_attachments_event_id", table_name="board_attachments")
    op.drop_index("ix_board_attachments_card_id", table_name="board_attachments")
    op.drop_index("ix_board_attachments_board_id", table_name="board_attachments")
    op.drop_table("board_attachments")
    op.drop_index("ix_report_schedules_due", table_name="report_schedules")
    op.drop_table("report_schedules")
    op.drop_index("ix_report_runs_report_created", table_name="report_runs")
    op.drop_index("ix_report_runs_module", table_name="report_runs")
    op.drop_table("report_runs")
    op.drop_index(
        "uq_relationship_edges_active",
        table_name="relationship_edges",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_relationship_edges_target_record", table_name="relationship_edges")
    op.drop_index("ix_relationship_edges_source_record", table_name="relationship_edges")
    op.drop_index(
        "ix_relationship_edges_active_target",
        table_name="relationship_edges",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("relationship_edges")
    op.drop_index(op.f("ix_record_triggers_trigger_value_field_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_trigger_field_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_publisher_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_published_version_id"), table_name="record_triggers")
    op.drop_index(op.f("ix_record_triggers_publication_id"), table_name="record_triggers")
    op.drop_index("ix_record_triggers_module", table_name="record_triggers")
    op.drop_table("record_triggers")
    op.drop_index(op.f("ix_files_record_id"), table_name="files")
    op.drop_index(op.f("ix_files_purpose"), table_name="files")
    op.drop_index(op.f("ix_files_department_id"), table_name="files")
    op.drop_index(op.f("ix_files_creator_id"), table_name="files")
    op.drop_index(op.f("ix_files_conversation_id"), table_name="files")
    op.drop_index(op.f("ix_files_board_id"), table_name="files")
    op.drop_table("files")
    op.drop_index(
        "uq_dashboard_widgets_active_position",
        table_name="dashboard_widgets",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_dashboard_widgets_dashboard_id", table_name="dashboard_widgets")
    op.drop_index("ix_dashboard_widgets_chart_id", table_name="dashboard_widgets")
    op.drop_table("dashboard_widgets")
    op.drop_index("ix_comms_typing_user", table_name="comms_typing")
    op.drop_index("ix_comms_typing_conversation", table_name="comms_typing")
    op.drop_table("comms_typing")
    op.drop_index(
        "uq_comms_settings_active",
        table_name="comms_settings",
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_comms_settings_conversation", table_name="comms_settings")
    op.drop_index("ix_comms_settings_category", table_name="comms_settings")
    op.drop_table("comms_settings")
    op.drop_index("ix_comms_schedules_conversation", table_name="comms_schedules")
    op.drop_table("comms_schedules")
    op.drop_table("comms_retention_policies")
    op.drop_index("ix_comms_realtime_grants_user", table_name="comms_realtime_grants")
    op.drop_index("ix_comms_realtime_grants_expiry", table_name="comms_realtime_grants")
    op.drop_index("ix_comms_realtime_grants_conversation", table_name="comms_realtime_grants")
    op.drop_table("comms_realtime_grants")
    op.drop_index("ix_comms_read_states_user", table_name="comms_read_states")
    op.drop_table("comms_read_states")
    op.drop_index("ix_comms_messages_replies", table_name="comms_messages")
    op.drop_index("ix_comms_messages_quote", table_name="comms_messages")
    op.drop_index("ix_comms_messages_pinned_by", table_name="comms_messages")
    op.drop_index(
        "ix_comms_messages_live_roots",
        table_name="comms_messages",
        postgresql_where=sa.text("parent_id IS NULL AND is_deleted = false"),
    )
    op.drop_index("ix_comms_messages_deleted_by", table_name="comms_messages")
    op.drop_index(
        "ix_comms_messages_body_search", table_name="comms_messages", postgresql_using="gin"
    )
    op.drop_index("ix_comms_messages_author", table_name="comms_messages")
    op.drop_table("comms_messages")
    op.drop_index(
        "uq_comms_members_active",
        table_name="comms_members",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_comms_members_user", table_name="comms_members")
    op.drop_index("ix_comms_members_conversation", table_name="comms_members")
    op.drop_table("comms_members")
    op.drop_index("ix_comms_member_preferences_user", table_name="comms_member_preferences")
    op.drop_index("ix_comms_member_preferences_conversation", table_name="comms_member_preferences")
    op.drop_table("comms_member_preferences")
    op.drop_index("ix_comms_export_sources_conversation", table_name="comms_export_sources")
    op.drop_table("comms_export_sources")
    op.drop_index("ix_comms_expired_sends_conversation", table_name="comms_expired_sends")
    op.drop_table("comms_expired_sends")
    op.drop_table("comms_conversation_counters")
    op.drop_index(
        "uq_comms_channel_access_active",
        table_name="comms_channel_access",
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_comms_channel_access_user", table_name="comms_channel_access")
    op.drop_index("ix_comms_channel_access_group", table_name="comms_channel_access")
    op.drop_index("ix_comms_channel_access_conversation", table_name="comms_channel_access")
    op.drop_index("ix_comms_channel_access_category", table_name="comms_channel_access")
    op.drop_table("comms_channel_access")
    op.drop_index(
        "uq_comms_capability_grants_active",
        table_name="comms_capability_grants",
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_comms_capability_grants_group", table_name="comms_capability_grants")
    op.drop_index("ix_comms_capability_grants_conversation", table_name="comms_capability_grants")
    op.drop_index("ix_comms_capability_grants_category", table_name="comms_capability_grants")
    op.drop_table("comms_capability_grants")
    op.drop_index("ix_board_post_revisions_author_id", table_name="board_post_revisions")
    op.drop_table("board_post_revisions")
    op.drop_index("ix_board_event_reminders_board_id", table_name="board_event_reminders")
    op.drop_table("board_event_reminders")
    op.drop_index(
        "uq_board_cards_stage_rank_active",
        table_name="board_cards",
        postgresql_where=sa.text("archived_at IS NULL AND NOT is_deleted"),
    )
    op.drop_index(
        "uq_board_cards_board_record_active",
        table_name="board_cards",
        postgresql_where=sa.text(
            "record_id IS NOT NULL AND archived_at IS NULL AND NOT is_deleted"
        ),
    )
    op.drop_index("ix_board_cards_record_id", table_name="board_cards")
    op.drop_index("ix_board_cards_module_id", table_name="board_cards")
    op.drop_index("ix_board_cards_board_id", table_name="board_cards")
    op.drop_index("ix_board_cards_assignee_id", table_name="board_cards")
    op.drop_table("board_cards")
    op.drop_index("ix_board_calendar_sources_user_id", table_name="board_calendar_sources")
    op.drop_index("ix_board_calendar_sources_module_id", table_name="board_calendar_sources")
    op.drop_index("ix_board_calendar_sources_date_field_id", table_name="board_calendar_sources")
    op.drop_index("ix_board_calendar_sources_board_id", table_name="board_calendar_sources")
    op.drop_table("board_calendar_sources")
    op.drop_index(
        "uq_saved_views_module_default",
        table_name="saved_views",
        postgresql_where=sa.text("is_default AND NOT is_deleted"),
    )
    op.drop_index(op.f("ix_saved_views_module_id"), table_name="saved_views")
    op.drop_table("saved_views")
    op.drop_index("ix_sandbox_publications_document_created", table_name="sandbox_publications")
    op.drop_index(op.f("ix_sandbox_publications_actor_id"), table_name="sandbox_publications")
    op.drop_table("sandbox_publications")
    op.drop_index("ix_reports_module", table_name="reports")
    op.drop_table("reports")
    op.drop_index(op.f("ix_records_module_id"), table_name="records")
    op.drop_table("records")
    op.drop_index(
        "uq_group_access_target_active",
        table_name="group_access",
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_group_access_module_id", table_name="group_access")
    op.drop_index(
        "ix_group_access_department_module_active",
        table_name="group_access",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("group_access")
    op.drop_index(
        "uq_fields_module_position_active",
        table_name="fields",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(
        "uq_fields_module_name_active",
        table_name="fields",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_fields_relationship_target_module_id", table_name="fields")
    op.drop_index(op.f("ix_fields_module_id"), table_name="fields")
    op.drop_table("fields")
    op.drop_index(
        "uq_comms_conversations_direct_key",
        table_name="comms_conversations",
        postgresql_where=sa.text("kind = 'direct'"),
    )
    op.drop_index("ix_comms_conversations_department", table_name="comms_conversations")
    op.drop_index("ix_comms_conversations_creator", table_name="comms_conversations")
    op.drop_index("ix_comms_conversations_category_order", table_name="comms_conversations")
    op.drop_table("comms_conversations")
    op.drop_index("ix_charts_module_id", table_name="charts")
    op.drop_index("ix_charts_department_id", table_name="charts")
    op.drop_table("charts")
    op.drop_index(
        "uq_board_stages_board_position_active",
        table_name="board_stages",
        postgresql_where=sa.text("archived_at IS NULL AND NOT is_deleted"),
    )
    op.drop_index("ix_board_stages_board_id", table_name="board_stages")
    op.drop_table("board_stages")
    op.drop_index("ix_board_posts_board_id", table_name="board_posts")
    op.drop_index("ix_board_posts_author_id", table_name="board_posts")
    op.drop_table("board_posts")
    op.drop_index("uq_board_labels_board_name", table_name="board_labels")
    op.drop_table("board_labels")
    op.drop_index(
        "uq_board_groups_board_group_active",
        table_name="board_groups",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index("ix_board_groups_group_id", table_name="board_groups")
    op.drop_table("board_groups")
    op.drop_index("ix_board_events_board_id", table_name="board_events")
    op.drop_index("ix_board_events_author_id", table_name="board_events")
    op.drop_table("board_events")
    op.drop_index("ix_sandbox_versions_source_version", table_name="sandbox_versions")
    op.drop_table("sandbox_versions")
    op.drop_index("ix_sandbox_test_runs_document_created", table_name="sandbox_test_runs")
    op.drop_table("sandbox_test_runs")
    op.drop_index(
        "uq_modules_department_name_active",
        table_name="modules",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_index(op.f("ix_modules_title_field_id"), table_name="modules")
    op.drop_index(op.f("ix_modules_department_id"), table_name="modules")
    op.drop_table("modules")
    op.drop_index(op.f("ix_group_members_user_id"), table_name="group_members")
    op.drop_table("group_members")
    op.drop_index(
        "uq_dashboards_department_home",
        table_name="dashboards",
        postgresql_where=sa.text("is_home AND NOT is_deleted"),
    )
    op.drop_index("ix_dashboards_department_position", table_name="dashboards")
    op.drop_table("dashboards")
    op.drop_index("ix_comms_categories_order", table_name="comms_categories")
    op.drop_index("ix_comms_categories_department", table_name="comms_categories")
    op.drop_table("comms_categories")
    op.drop_index(
        "uq_boards_department",
        table_name="boards",
        postgresql_where=sa.text("scope = 'department' AND NOT is_deleted"),
    )
    op.drop_index(
        "uq_boards_company",
        table_name="boards",
        postgresql_where=sa.text("scope = 'company' AND NOT is_deleted"),
    )
    op.drop_index(op.f("ix_boards_department_id"), table_name="boards")
    op.drop_table("boards")
    op.drop_index("ix_security_events_operation_id", table_name="security_events")
    op.drop_index("ix_security_events_occurred_at_id", table_name="security_events")
    op.drop_table("security_events")
    op.drop_table("sandbox_documents")
    op.drop_index(
        "uq_memberships_user_pending",
        table_name="memberships",
        postgresql_where=sa.text("status = 'pending' AND is_deleted = false"),
    )
    op.drop_index(op.f("ix_memberships_user_id"), table_name="memberships")
    op.drop_index(op.f("ix_memberships_sponsor_user_id"), table_name="memberships")
    op.drop_table("memberships")
    op.drop_index(
        "ix_lifecycle_rate_limit_failures_actor_occurred",
        table_name="lifecycle_rate_limit_failures",
    )
    op.drop_table("lifecycle_rate_limit_failures")
    op.drop_table("lifecycle_rate_limit_buckets")
    op.drop_table("lifecycle_confirmation_challenges")
    op.drop_index("ix_identity_sessions_user_active", table_name="identity_sessions")
    op.drop_table("identity_sessions")
    op.drop_index(
        "uq_groups_name_active_ci",
        table_name="groups",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("groups")
    op.drop_index(
        "uq_departments_name_active",
        table_name="departments",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("departments")
    op.drop_table("comms_templates")
    op.drop_index(
        "uq_comms_setting_locks_active",
        table_name="comms_setting_locks",
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.drop_table("comms_setting_locks")
    op.drop_table("comms_retention_sweeps")
    op.drop_index("ix_comms_realtime_admissions_user", table_name="comms_realtime_admissions")
    op.drop_table("comms_realtime_admissions")
    op.drop_index("ix_comms_presence_user", table_name="comms_presence")
    op.drop_index("ix_comms_presence_seen", table_name="comms_presence")
    op.drop_table("comms_presence")
    op.drop_index("ix_comms_personal_preferences_user", table_name="comms_personal_preferences")
    op.drop_table("comms_personal_preferences")
    op.drop_index("ix_comms_exports_requester", table_name="comms_exports")
    op.drop_index("ix_comms_exports_cleanup", table_name="comms_exports")
    op.drop_table("comms_exports")
    op.drop_index("ix_comms_direct_blocks_user", table_name="comms_direct_blocks")
    op.drop_index("ix_comms_direct_blocks_blocked_user", table_name="comms_direct_blocks")
    op.drop_table("comms_direct_blocks")
    op.drop_index(
        "uq_backup_exports_unresolved",
        table_name="backup_export_operations",
        postgresql_where=sa.text("state = 'preparing'"),
    )
    op.drop_index("ix_backup_exports_requester_id", table_name="backup_export_operations")
    op.drop_index("ix_backup_exports_queue", table_name="backup_export_operations")
    op.drop_index(
        "ix_backup_exports_cleanup",
        table_name="backup_export_operations",
        postgresql_where=sa.text("state = 'ready' AND artifact_deleted_at IS NULL"),
    )
    op.drop_index("ix_backup_exports_backup_run_id", table_name="backup_export_operations")
    op.drop_table("backup_export_operations")
    op.drop_index("ix_audit_logs_request", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity", table_name="audit_logs")
    op.drop_index("ix_audit_logs_department_created_at_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_created_at_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_table("audit_logs")
    op.drop_table("platform_operators")
    op.drop_table("organizations")
    op.drop_table("identity_mfa_observations")
    op.drop_index(
        "uq_backup_runs_unresolved",
        table_name="backup_runs",
        postgresql_where=sa.text("started_at IS NOT NULL AND reconciled_at IS NULL"),
    )
    op.drop_index("ix_backup_runs_requester_id", table_name="backup_runs")
    op.drop_index("ix_backup_runs_queue", table_name="backup_runs")
    op.drop_table("backup_runs")
    op.drop_index(op.f("ix_users_supabase_user_id"), table_name="users")
    op.drop_index(op.f("ix_users_avatar_file_id"), table_name="users")
    op.drop_table("users")
    op.drop_table("update_statuses")
    op.drop_table("platform_settings")
    op.drop_index(
        op.f("ix_identity_rate_limit_buckets_window_started_at"),
        table_name="identity_rate_limit_buckets",
    )
    op.drop_table("identity_rate_limit_buckets")
    op.drop_table("backup_policies")
    # ### end Alembic commands ###
    for function in ROOT_FUNCTIONS:
        op.execute(f"DROP FUNCTION public.{function}")
    # Restore the deny-all join function that provision_database_role.py installs.
    op.execute(
        "CREATE OR REPLACE FUNCTION public.can_join_realtime_topic(topic text) "
        "RETURNS boolean "
        "LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'pg_temp' AS $$ "
        "SELECT false $$"
    )
