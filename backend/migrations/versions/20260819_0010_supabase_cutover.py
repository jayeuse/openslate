"""Cut the application schema over to Supabase Auth and private Realtime.

This migration intentionally does not migrate local identities.  A database with
profiles already present must be restored from a backup and cut over explicitly.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from psycopg import connect, sql
from sqlalchemy.dialects import postgresql

revision = "20260819_0010"
down_revision = "20260819_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


APPLICATION_TABLES = (
    "users",
    "roles",
    "departments",
    "modules",
    "fields",
    "records",
    "audit_logs",
)


def _configure_private_realtime(connection: sa.Connection) -> None:
    """Apply Realtime owner-only DDL without retaining managed-role membership."""
    current_user, owner, owner_identifier, can_set_role = connection.execute(
        sa.text(
            """
            SELECT current_user,
                   pg_get_userbyid(messages.relowner),
                   quote_ident(pg_get_userbyid(messages.relowner)),
                   current_user = pg_get_userbyid(messages.relowner)
                       OR pg_has_role(
                           current_user, pg_get_userbyid(messages.relowner), 'SET'
                       )
              FROM pg_catalog.pg_class AS messages
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.oid = messages.relnamespace
             WHERE namespace.nspname = 'realtime'
               AND messages.relname = 'messages'
            """
        )
    ).one()

    temporary_membership = False
    if not can_set_role:
        if connection.engine.url.host not in {"127.0.0.1", "localhost"}:
            raise RuntimeError(
                "Cannot configure the Supabase-owned realtime.messages table: "
                f"{current_user} cannot assume its owner {owner}. Run this migration "
                "with an owner-capable migration role or apply the Realtime policy "
                "as a separate owner-capable migration step."
            )

        admin_url = connection.engine.url.set(
            drivername="postgresql", username="supabase_admin"
        ).render_as_string(hide_password=False)
        try:
            with connect(admin_url) as admin_connection:
                with admin_connection.cursor() as cursor:
                    cursor.execute(
                        sql.SQL("GRANT {} TO {}").format(
                            sql.Identifier(owner), sql.Identifier(current_user)
                        )
                    )
            temporary_membership = True
        except Exception as error:
            raise RuntimeError(
                "Cannot temporarily assume the local Supabase Realtime owner. "
                "Local Supabase requires supabase_admin to accept the migration "
                "connection password."
            ) from error

    try:
        connection.execute(sa.text(f"SET LOCAL ROLE {owner_identifier}"))
        connection.execute(
            sa.text(
                """
                ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
                DROP POLICY IF EXISTS openslate_private_broadcast_receive ON realtime.messages;
                CREATE POLICY openslate_private_broadcast_receive
                ON realtime.messages
                AS PERMISSIVE
                FOR SELECT
                TO authenticated
                USING (
                    realtime.messages.extension = 'broadcast'
                    AND realtime.topic() = 'openslate:invalidation'
                    AND public.openslate_can_receive_invalidation()
                );

                REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE realtime.messages
                    FROM anon, authenticated;
                GRANT SELECT ON TABLE realtime.messages TO authenticated;
                """
            )
        )
        connection.execute(sa.text("RESET ROLE"))
    finally:
        if temporary_membership:
            with connect(admin_url) as admin_connection:
                with admin_connection.cursor() as cursor:
                    cursor.execute(
                        sql.SQL("REVOKE {} FROM {}").format(
                            sql.Identifier(owner), sql.Identifier(current_user)
                        )
                    )


def upgrade() -> None:
    connection = op.get_bind()

    # There is deliberately no supported mapping from the old local identities
    # to auth.users identities.  Check before making any destructive change.
    has_legacy_profiles = connection.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM public.users)")
    ).scalar()
    if has_legacy_profiles:
        raise RuntimeError(
            "Cannot cut over users with existing rows; identity data migration is "
            "unsupported. Restore a backup and start the Supabase Auth cutover "
            "with an empty public.users table."
        )

    op.add_column(
        "users",
        sa.Column(
            "email",
            sa.String(length=320),
            nullable=False,
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "status",
            sa.String(length=20),
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
    )
    op.drop_column(
        "users",
        "password_hash",
    )
    op.alter_column(
        "users",
        "id",
        existing_type=postgresql.UUID(as_uuid=True),
        existing_nullable=False,
        server_default=None,
    )
    op.create_unique_constraint("uq_users_email", "users", ["email"])
    op.create_index("ix_users_email", "users", ["email"], unique=False)
    op.create_check_constraint(
        "ck_users_email_normalized",
        "users",
        "email = lower(btrim(email)) AND length(email) > 0",
    )
    op.create_check_constraint(
        "ck_users_status",
        "users",
        "status IN ('pending', 'active', 'disabled')",
    )
    op.execute(
        sa.text(
            """
            ALTER TABLE public.users
            ADD CONSTRAINT fk_users_id_auth_users
            FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE
            """
        )
    )

    # The trigger owner is the only role that needs write access to profiles
    # while Auth is creating an identity.  The fixed search_path prevents an
    # untrusted session setting from changing the objects reached by the body.
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION public.openslate_handle_auth_user_created()
            RETURNS trigger
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                member_role_id uuid;
                normalized_email text;
            BEGIN
                IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
                    RAISE EXCEPTION 'An email address is required for an OpenSlate profile';
                END IF;

                normalized_email := lower(btrim(NEW.email));

                SELECT id
                  INTO member_role_id
                  FROM public.roles
                 WHERE role = 'member'
                   AND is_deleted = false
                 ORDER BY id
                 LIMIT 1;

                IF member_role_id IS NULL THEN
                    RAISE EXCEPTION 'The active member role is required for Auth signup';
                END IF;

                INSERT INTO public.users (id, email, username, status, role_id)
                VALUES (
                    NEW.id,
                    normalized_email,
                    'auth_' || replace(NEW.id::text, '-', ''),
                    'pending',
                    member_role_id
                );

                RETURN NEW;
            END;
            $function$;
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION public.openslate_sync_auth_user_email()
            RETURNS trigger
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
                    RAISE EXCEPTION 'An email address is required for an OpenSlate profile';
                END IF;

                UPDATE public.users
                   SET email = lower(btrim(NEW.email)),
                       updated_at = CURRENT_TIMESTAMP
                 WHERE id = NEW.id;

                RETURN NEW;
            END;
            $function$;
            """
        )
    )
    op.execute(
        sa.text(
            """
            DROP TRIGGER IF EXISTS openslate_auth_user_created ON auth.users;
            CREATE TRIGGER openslate_auth_user_created
            AFTER INSERT ON auth.users
            FOR EACH ROW
            EXECUTE FUNCTION public.openslate_handle_auth_user_created();

            DROP TRIGGER IF EXISTS openslate_auth_user_email_updated ON auth.users;
            CREATE TRIGGER openslate_auth_user_email_updated
            AFTER UPDATE OF email ON auth.users
            FOR EACH ROW
            WHEN (OLD.email IS DISTINCT FROM NEW.email)
            EXECUTE FUNCTION public.openslate_sync_auth_user_email();
            """
        )
    )
    op.execute(
        sa.text(
            """
            REVOKE ALL PRIVILEGES ON FUNCTION public.openslate_handle_auth_user_created()
                FROM PUBLIC, anon, authenticated, service_role;
            REVOKE ALL PRIVILEGES ON FUNCTION public.openslate_sync_auth_user_email()
                FROM PUBLIC, anon, authenticated, service_role;
            GRANT EXECUTE ON FUNCTION public.openslate_handle_auth_user_created()
                TO supabase_auth_admin;
            GRANT EXECUTE ON FUNCTION public.openslate_sync_auth_user_email()
                TO supabase_auth_admin;
            """
        )
    )

    # The application role is intentionally separate from Supabase's client
    # roles.  UUID primary keys do not require sequence privileges.
    op.execute(
        sa.text(
            """
            DO $role$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                      FROM pg_catalog.pg_roles
                     WHERE rolname = 'openslate_app'
                ) THEN
                    CREATE ROLE openslate_app NOLOGIN;
                END IF;
            END
            $role$;

            REVOKE CREATE ON SCHEMA public FROM PUBLIC;
            REVOKE ALL ON TABLE
                public.users, public.roles, public.departments, public.modules,
                public.fields, public.records, public.audit_logs
                FROM anon, authenticated, service_role;
            REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
                FROM anon, authenticated, service_role;
            REVOKE ALL PRIVILEGES ON FUNCTION
                public.openslate_handle_auth_user_created() FROM anon, authenticated, service_role;
            REVOKE ALL PRIVILEGES ON FUNCTION
                public.openslate_sync_auth_user_email() FROM anon, authenticated, service_role;

            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated, service_role;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated, service_role;
            ALTER DEFAULT PRIVILEGES IN SCHEMA public
                REVOKE ALL PRIVILEGES ON FUNCTIONS FROM anon, authenticated, service_role;

            GRANT USAGE ON SCHEMA public TO openslate_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
                public.users, public.roles, public.departments, public.modules,
                public.fields, public.records TO openslate_app;
            GRANT SELECT, INSERT ON TABLE public.audit_logs TO openslate_app;
            GRANT SELECT ON TABLE public.alembic_version TO openslate_app;
            """
        )
    )

    for table_name in APPLICATION_TABLES:
        op.execute(sa.text(f"ALTER TABLE public.{table_name} ENABLE ROW LEVEL SECURITY"))

    for table_name in APPLICATION_TABLES[:-1]:
        for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            policy_name = f"openslate_app_{table_name}_{action.lower()}"
            policy_check = {
                "INSERT": "WITH CHECK (true)",
                "SELECT": "USING (true)",
                "UPDATE": "USING (true) WITH CHECK (true)",
                "DELETE": "USING (true)",
            }[action]
            op.execute(
                sa.text(
                    f"""
                    DROP POLICY IF EXISTS {policy_name} ON public.{table_name};
                    CREATE POLICY {policy_name}
                    ON public.{table_name}
                    AS PERMISSIVE
                    FOR {action}
                    TO openslate_app
                    """
                    + policy_check
                )
            )

    for action in ("SELECT", "INSERT"):
        policy_name = f"openslate_app_audit_logs_{action.lower()}"
        policy_check = "WITH CHECK (true)" if action == "INSERT" else "USING (true)"
        op.execute(
            sa.text(
                f"""
                DROP POLICY IF EXISTS {policy_name} ON public.audit_logs;
                CREATE POLICY {policy_name}
                ON public.audit_logs
                AS PERMISSIVE
                FOR {action}
                TO openslate_app
                """
                + policy_check
            )
        )

    # Storage is private and deliberately has no application object policies.
    op.execute(
        sa.text(
            """
            INSERT INTO storage.buckets (id, name, public)
            VALUES ('openslate-files', 'openslate-files', false)
            ON CONFLICT (id) DO UPDATE
                SET name = EXCLUDED.name,
                    public = false;
            """
        )
    )

    # Realtime authorization must be able to inspect a profile without granting
    # authenticated direct access to the application tables.  The policy is
    # owner-only DDL on a Supabase-managed table.
    op.execute(
        sa.text(
            """
            CREATE OR REPLACE FUNCTION public.openslate_can_receive_invalidation()
            RETURNS boolean
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
                SELECT EXISTS (
                    SELECT 1
                      FROM public.users AS profile
                     WHERE profile.id = auth.uid()
                       AND profile.status = 'active'
                       AND profile.is_deleted = false
                )
            $function$;

            REVOKE ALL PRIVILEGES ON FUNCTION public.openslate_can_receive_invalidation()
                FROM PUBLIC, anon, service_role;
            GRANT EXECUTE ON FUNCTION public.openslate_can_receive_invalidation()
                TO authenticated;
            """
        )
    )
    _configure_private_realtime(connection)


def downgrade() -> None:
    raise NotImplementedError(
        "The Supabase Auth cutover is intentionally forward-only; restore a database "
        "backup to downgrade."
    )
