"""realtime topic access

Revision ID: 071607de0f40
Revises: 7f5265d768ef
Create Date: 2026-10-17 00:35:12.772976

Supabase Realtime evaluates private channels through RLS on the provider-owned
``realtime.messages`` table as the ``authenticated`` role. The policies there are the
operator's (``operations/provision_database_role.py``, as ``supabase_admin``); they call
this function, which reads application memberships as their owner. No model owns a
function, so this revision is written by hand (``migrations/AGENTS.md``).

Provisioning creates the function first with a deny-all body, because it runs before
Alembic. This revision replaces the body in place: the same signature keeps the policy
dependency. The downgrade returns to the deny-all body while a policy depends on it.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "071607de0f40"
down_revision: str | None = "7f5265d768ef"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SIGNATURE = "public.can_join_realtime_topic(text)"

# A malformed claim or topic yields false instead of an error: realtime.authorize only
# treats insufficient_privilege as a refused write and fails the whole join otherwise.
# The membership predicate mirrors is_active_account, is_active_membership and
# established_user_clause, plus a live organization (resolve_membership).
JOIN_FUNCTION = """
CREATE OR REPLACE FUNCTION public.can_join_realtime_topic(topic text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $realtime$
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
$realtime$
"""

DENY_FUNCTION = """
CREATE OR REPLACE FUNCTION public.can_join_realtime_topic(topic text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $realtime$ SELECT false $realtime$
"""

# Supabase default privileges grant public functions to its API roles by name.
GRANTS = (
    f"REVOKE ALL ON FUNCTION {SIGNATURE} FROM PUBLIC, anon, service_role, postgres",
    f"GRANT EXECUTE ON FUNCTION {SIGNATURE} TO authenticated",
)


def upgrade() -> None:
    op.execute(JOIN_FUNCTION)
    for statement in GRANTS:
        op.execute(statement)


def downgrade() -> None:
    op.execute(DENY_FUNCTION)
    op.execute(f"""
        DO $downgrade$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_depend AS d
                 WHERE d.classid = 'pg_catalog.pg_policy'::regclass
                   AND d.refobjid = '{SIGNATURE}'::regprocedure
            ) THEN
                DROP FUNCTION {SIGNATURE};
            END IF;
        END
        $downgrade$
    """)
