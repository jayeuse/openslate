"""organization_security_event_retention

Revision ID: 226847298ae4
Revises: ed8c9f6d4526
Create Date: 2026-10-17 14:14:06.262173
"""

from collections.abc import Sequence

from alembic import op

revision: str = "226847298ae4"
down_revision: str | None = "ed8c9f6d4526"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE OR REPLACE FUNCTION public.retain_security_events() RETURNS integer
        LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        SET TimeZone = 'UTC'
        AS $retention$
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
                cutoff := as_of - pg_catalog.make_interval(days => deleted_scope.retention_days);
                proof_id := pg_catalog.gen_random_uuid();
                operation_id := pg_catalog.gen_random_uuid();
                IF proof_id = operation_id THEN
                    RAISE EXCEPTION 'Unable to generate independent retention proof identifiers';
                END IF;
                INSERT INTO public.security_events (
                    id, org_id, occurred_at, event_type, outcome, source, operation_id,
                    actor_id, subject_id, labels, fingerprint, reason,
                    request_id, request_method, request_path, metadata
                ) VALUES (
                    proof_id, deleted_scope.org_id, as_of, 'security.retention', 'success',
                    'security.event_retention', operation_id,
                    NULL, NULL, '{}'::jsonb, NULL, NULL, NULL, NULL, NULL,
                    pg_catalog.jsonb_build_object(
                        'scope', 'security_events', 'retention_days', deleted_scope.retention_days,
                        'batch_limit', 1000, 'as_of', as_of, 'cutoff', cutoff,
                        'deleted_events', deleted_scope.deleted_events
                    )
                );
                total_deleted := total_deleted + deleted_scope.deleted_events;
            END LOOP;
            RETURN total_deleted;
        END;
        $retention$;
    """)


def downgrade() -> None:
    # Restore the prior routine, not events already deleted under either policy.
    op.execute("""
        CREATE OR REPLACE FUNCTION public.retain_security_events() RETURNS integer
        LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
        SET TimeZone = 'UTC'
        AS $retention$
        DECLARE
            retention_days integer;
            as_of timestamptz;
            cutoff timestamptz;
            deleted_events integer;
            proof_id uuid;
            operation_id uuid;
        BEGIN
            IF NOT pg_catalog.pg_try_advisory_xact_lock(22328052256015694::bigint) THEN
                RETURN 0;
            END IF;
            SELECT p.security_event_retention_days INTO STRICT retention_days
            FROM public.platform_settings AS p WHERE p.singleton_key IS TRUE FOR SHARE;
            as_of := pg_catalog.transaction_timestamp();
            cutoff := as_of - pg_catalog.make_interval(days => retention_days);
            WITH candidates AS (
                SELECT e.id FROM public.security_events AS e
                WHERE e.occurred_at < cutoff
                ORDER BY e.occurred_at, e.id LIMIT 1000 FOR UPDATE OF e SKIP LOCKED
            ), deleted AS (
                DELETE FROM public.security_events AS e USING candidates AS c
                WHERE e.id = c.id RETURNING e.id
            )
            SELECT pg_catalog.count(*) INTO deleted_events FROM deleted;
            IF deleted_events = 0 THEN
                RETURN 0;
            END IF;
            proof_id := pg_catalog.gen_random_uuid();
            operation_id := pg_catalog.gen_random_uuid();
            IF proof_id = operation_id THEN
                RAISE EXCEPTION 'Unable to generate independent retention proof identifiers';
            END IF;
            INSERT INTO public.security_events (
                id, occurred_at, event_type, outcome, source, operation_id,
                actor_id, subject_id, labels, fingerprint, reason,
                request_id, request_method, request_path, metadata
            ) VALUES (
                proof_id, as_of, 'security.retention', 'success', 'security.event_retention',
                operation_id, NULL, NULL, '{}'::jsonb, NULL, NULL, NULL, NULL, NULL,
                pg_catalog.jsonb_build_object(
                    'scope', 'security_events', 'retention_days', retention_days,
                    'batch_limit', 1000, 'as_of', as_of, 'cutoff', cutoff,
                    'deleted_events', deleted_events
                )
            );
            RETURN deleted_events;
        END;
        $retention$;
    """)
