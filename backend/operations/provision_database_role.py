"""Create and validate OpenSlate's cluster roles from a bootstrap connection."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from psycopg import connect, sql
from sqlalchemy.engine import URL, make_url

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_provision_settings
from app.core.config.instance import (
    InstanceTarget,
    assert_database_url,
    assert_psycopg_target,
    instance_target_for_process,
    test_manifest_authorizes_process,
)

OWNER_ROLE = "openslate_owner"
PRIVILEGE_ROLE = "openslate_app"
RUNTIME_ROLE = "openslate_runtime"
LOCAL_ENVIRONMENTS = frozenset({"development", "dev", "local", "test"})
MEMBERSHIP_OPTION_COLUMNS = frozenset({"inherit_option", "set_option"})


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="required outside development, local, and test environments",
    )
    return parser


def _postgres_url(value: str, *, name: str) -> URL:
    try:
        url = make_url(value)
        if url.drivername not in {"postgresql", "postgresql+psycopg"} or not url.username:
            raise ValueError
    except Exception:
        raise SystemExit(f"{name} must use a PostgreSQL URL with a login") from None
    return url


def _password(url: URL, *, name: str, role: str) -> str:
    if url.username != role or not url.password:
        raise SystemExit(f"{name} must use {role} with a password")
    return url.password


def _psycopg_url(url: URL) -> str:
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def _assert_same_database(bootstrap: URL, owner: URL, *connections: URL) -> str:
    values = (bootstrap, owner, *connections)
    database = bootstrap.database
    if not database or any(url.database != database for url in values[1:]):
        raise SystemExit("OpenSlate database URLs must name one database")
    endpoint = (bootstrap.host, bootstrap.port)
    if any((url.host, url.port) != endpoint for url in values[1:]):
        raise SystemExit("OpenSlate database URLs must use one endpoint")
    if bootstrap.username in {OWNER_ROLE, RUNTIME_ROLE}:
        raise SystemExit("DATABASE_BOOTSTRAP_URL must use a distinct cluster-admin login")
    return database


def _safe_role_attributes(cursor: object, role: str, expected: tuple[bool, ...]) -> None:
    cursor.execute(  # type: ignore[attr-defined]
        """
        SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
               rolreplication, rolbypassrls
          FROM pg_catalog.pg_roles
         WHERE rolname = %s
        """,
        (role,),
    )
    if cursor.fetchone() != expected:  # type: ignore[attr-defined]
        raise RuntimeError(f"Existing {role} role has unsafe attributes")


def _create_role(cursor: object, role: str, attributes: str, password: str | None = None) -> None:
    cursor.execute(  # type: ignore[attr-defined]
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = %s)", (role,)
    )
    row = cursor.fetchone()  # type: ignore[attr-defined]
    if row is None:
        raise RuntimeError("Unable to inspect PostgreSQL roles")
    if bool(row[0]):
        return
    statement = sql.SQL("CREATE ROLE {} {}").format(sql.Identifier(role), sql.SQL(attributes))
    if password is not None:
        statement += sql.SQL(" PASSWORD {}").format(sql.Literal(password))
    cursor.execute(statement)  # type: ignore[attr-defined]


def _rotate_password(cursor: object, role: str, password: str) -> None:
    statement = sql.SQL("ALTER ROLE {} PASSWORD {}").format(
        sql.Identifier(role), sql.Literal(password)
    )
    cursor.execute(statement)  # type: ignore[attr-defined]


def _membership_columns(cursor: object) -> set[str]:
    cursor.execute(  # type: ignore[attr-defined]
        """
        SELECT attname
          FROM pg_catalog.pg_attribute
         WHERE attrelid = 'pg_catalog.pg_auth_members'::regclass
           AND attname IN (%s, %s)
           AND NOT attisdropped
        """,
        tuple(MEMBERSHIP_OPTION_COLUMNS),
    )
    result = {row[0] for row in cursor.fetchall()}  # type: ignore[attr-defined]
    if result not in (set(), set(MEMBERSHIP_OPTION_COLUMNS)):
        raise RuntimeError("PostgreSQL role membership options are incomplete")
    return result


def _validate_runtime_membership(cursor: object, *, options_supported: bool) -> None:
    columns = (
        "membership.admin_option, membership.inherit_option, membership.set_option"
        if options_supported
        else "membership.admin_option"
    )
    cursor.execute(  # type: ignore[attr-defined]
        f"""
        SELECT {columns}
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
          JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
         WHERE member_role.rolname = %s AND granted_role.rolname = %s
        """,
        (RUNTIME_ROLE, PRIVILEGE_ROLE),
    )
    membership = cursor.fetchone()  # type: ignore[attr-defined]
    expected = (False, True, False) if options_supported else (False,)
    if membership != expected:
        raise RuntimeError("Runtime role has unsafe application-role membership")


def _validate_managed_role_memberships(
    cursor: object, *, options_supported: bool, bootstrap_role: str | None,
) -> None:
    columns = (
        "member_role.rolname, granted_role.rolname, membership.admin_option, "
        "membership.inherit_option, membership.set_option"
        if options_supported
        else "member_role.rolname, granted_role.rolname, membership.admin_option"
    )
    cursor.execute(  # type: ignore[attr-defined]
        f"""
        SELECT {columns}
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = membership.member
          JOIN pg_catalog.pg_roles AS granted_role ON granted_role.oid = membership.roleid
         WHERE member_role.rolname IN (%s, %s, %s)
            OR granted_role.rolname IN (%s, %s, %s)
         ORDER BY member_role.rolname, granted_role.rolname
        """,
        (
            OWNER_ROLE,
            PRIVILEGE_ROLE,
            RUNTIME_ROLE,
            OWNER_ROLE,
            PRIVILEGE_ROLE,
            RUNTIME_ROLE,
        ),
    )
    expected = (
        [(RUNTIME_ROLE, PRIVILEGE_ROLE, False, True, False)]
        if options_supported
        else [(RUNTIME_ROLE, PRIVILEGE_ROLE, False)]
    )
    memberships = cursor.fetchall()  # type: ignore[attr-defined]
    # PostgreSQL grants a non-superuser CREATEROLE creator administrative
    # membership with neither inheritance nor SET ROLE. Admit only that exact
    # administrative relationship for the explicitly selected bootstrap login.
    creator_grants = {
        (bootstrap_role, role, True, False, False)
        for role in (OWNER_ROLE, PRIVILEGE_ROLE, RUNTIME_ROLE)
    } if options_supported else set()
    remaining = [row for row in memberships if tuple(row) not in creator_grants]
    if remaining != expected:
        raise RuntimeError("Managed PostgreSQL roles have unsafe membership")


def _provision_session_liveness_policy(cursor: object) -> None:
    """Expose only column-granted Auth session metadata to the backend role."""
    cursor.execute(  # type: ignore[attr-defined]
        """
        SELECT polcmd, polpermissive,
               polroles = ARRAY['openslate_app'::regrole::oid],
               pg_get_expr(polqual, polrelid), polwithcheck IS NULL
          FROM pg_catalog.pg_policy
         WHERE polrelid = 'auth.sessions'::regclass
           AND polname = 'openslate_session_liveness'
        """
    )
    existing = cursor.fetchone()  # type: ignore[attr-defined]
    if existing is None:
        cursor.execute(  # type: ignore[attr-defined]
            "CREATE POLICY openslate_session_liveness ON auth.sessions "
            "FOR SELECT TO openslate_app USING (true)"
        )
    elif existing != ("r", True, True, "true", True):
        raise RuntimeError("Existing OpenSlate provider session policy is unsafe")


REALTIME_JOIN_FUNCTION = "public.can_join_realtime_topic(text)"
REALTIME_SEND_FUNCTION = "realtime.send(jsonb,text,text,boolean)"
REALTIME_JOIN_EXPRESSION = "public.can_join_realtime_topic(realtime.topic())"
REALTIME_UNGRANTED = "anon, service_role, postgres"
# Policy name -> (pg_policy.polcmd, USING expression, WITH CHECK expression).
REALTIME_POLICIES = {
    "openslate_realtime_member_read": ("r", REALTIME_JOIN_EXPRESSION, None),
    "openslate_realtime_member_write": ("a", None, REALTIME_JOIN_EXPRESSION),
}


def _provision_realtime_channel_policies(cursor: object) -> None:
    """Admit private Realtime channels only through the membership function.

    Realtime owns ``realtime.messages`` and creates it at its first start, so only this
    cluster-admin step can add policies. They call ``can_join_realtime_topic``, which the
    application owns; Alembic, which runs later, replaces this deny-all body in place.
    """
    # Deparse policy expressions with schema-qualified names.
    cursor.execute("SET LOCAL search_path TO pg_catalog")  # type: ignore[attr-defined]
    cursor.execute(  # type: ignore[attr-defined]
        """
        SELECT c.relrowsecurity, pg_catalog.to_regprocedure('realtime.topic()') IS NOT NULL
          FROM pg_catalog.pg_class AS c
         WHERE c.oid = pg_catalog.to_regclass('realtime.messages')
        """
    )
    if cursor.fetchone() != (True, True):  # type: ignore[attr-defined]
        raise RuntimeError(
            "Realtime has not initialized realtime.messages; start the realtime service "
            "and wait until it is healthy"
        )
    cursor.execute(  # type: ignore[attr-defined]
        "SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc AS p "
        "WHERE p.oid = pg_catalog.to_regprocedure(%s)",
        (REALTIME_JOIN_FUNCTION,),
    )
    owner = cursor.fetchone()  # type: ignore[attr-defined]
    if owner is None:
        cursor.execute(  # type: ignore[attr-defined]
            "CREATE FUNCTION public.can_join_realtime_topic(topic text) RETURNS boolean "
            "LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp "
            "AS $realtime$ SELECT false $realtime$"
        )
        cursor.execute(  # type: ignore[attr-defined]
            f"ALTER FUNCTION {REALTIME_JOIN_FUNCTION} OWNER TO {OWNER_ROLE}"
        )
    elif owner != (OWNER_ROLE,):
        raise RuntimeError("Existing Realtime membership function has an unexpected owner")
    # Supabase default privileges grant new public functions to its API roles by name.
    cursor.execute(  # type: ignore[attr-defined]
        f"REVOKE ALL ON FUNCTION {REALTIME_JOIN_FUNCTION} FROM PUBLIC, {REALTIME_UNGRANTED}"
    )
    cursor.execute(  # type: ignore[attr-defined]
        f"GRANT EXECUTE ON FUNCTION {REALTIME_JOIN_FUNCTION} TO authenticated"
    )
    cursor.execute(  # type: ignore[attr-defined]
        """
        SELECT polname, polcmd, polpermissive,
               polroles = ARRAY['authenticated'::regrole::oid],
               pg_catalog.pg_get_expr(polqual, polrelid),
               pg_catalog.pg_get_expr(polwithcheck, polrelid)
          FROM pg_catalog.pg_policy
         WHERE polrelid = 'realtime.messages'::regclass
        """
    )
    existing = {row[0]: tuple(row[1:]) for row in cursor.fetchall()}  # type: ignore[attr-defined]
    # Policies are permissive and combine with OR: any other one would widen access.
    if set(existing) - set(REALTIME_POLICIES):
        raise RuntimeError("realtime.messages has policies that OpenSlate does not manage")
    for name, (command, using, check) in REALTIME_POLICIES.items():
        if name not in existing:
            clause = f"USING ({using})" if using else f"WITH CHECK ({check})"
            verb = "SELECT" if command == "r" else "INSERT"
            cursor.execute(  # type: ignore[attr-defined]
                f"CREATE POLICY {name} ON realtime.messages FOR {verb} "
                f"TO authenticated {clause}"
            )
        elif existing[name] != (command, True, True, using, check):
            raise RuntimeError("Existing OpenSlate Realtime channel policy is unsafe")
    cursor.execute("RESET search_path")  # type: ignore[attr-defined]


def provision(
    bootstrap_url: str,
    migration_url: str,
    runtime_url: str,
    *,
    instance_target: InstanceTarget | None = None,
) -> None:
    bootstrap = _postgres_url(bootstrap_url, name="DATABASE_BOOTSTRAP_URL")
    owner = _postgres_url(migration_url, name="MIGRATION_DATABASE_URL")
    runtime = _postgres_url(runtime_url, name="DATABASE_URL")
    owner_password = _password(owner, name="MIGRATION_DATABASE_URL", role=OWNER_ROLE)
    runtime_password = _password(runtime, name="DATABASE_URL", role=RUNTIME_ROLE)
    database = _assert_same_database(bootstrap, owner, runtime)
    if instance_target is not None:
        assert_database_url(bootstrap_url, instance_target, expected_user=None)
        assert_database_url(migration_url, instance_target, expected_user=OWNER_ROLE)
        assert_database_url(runtime_url, instance_target, expected_user=RUNTIME_ROLE)
    with connect(_psycopg_url(bootstrap)) as connection:
        if instance_target is not None:
            assert_psycopg_target(connection, instance_target, expected_user=bootstrap.username)
        with connection.cursor() as cursor:
            _create_role(
                cursor,
                OWNER_ROLE,
                "LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
                owner_password,
            )
            _create_role(
                cursor,
                PRIVILEGE_ROLE,
                "NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
            )
            _create_role(
                cursor,
                RUNTIME_ROLE,
                "LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
                runtime_password,
            )
            _safe_role_attributes(
                cursor, OWNER_ROLE, (True, False, False, False, False, False, False)
            )
            _safe_role_attributes(
                cursor, PRIVILEGE_ROLE, (False, False, False, False, False, False, False)
            )
            _safe_role_attributes(
                cursor, RUNTIME_ROLE, (True, True, False, False, False, False, False)
            )
            _rotate_password(cursor, OWNER_ROLE, owner_password)
            _rotate_password(cursor, RUNTIME_ROLE, runtime_password)
            options_supported = bool(_membership_columns(cursor))
            grant = sql.SQL("GRANT {} TO {}").format(
                sql.Identifier(PRIVILEGE_ROLE), sql.Identifier(RUNTIME_ROLE)
            )
            if options_supported:
                grant += sql.SQL(" WITH INHERIT TRUE, SET FALSE")
            cursor.execute(grant)
            _validate_runtime_membership(cursor, options_supported=options_supported)
            _validate_managed_role_memberships(
                cursor, options_supported=options_supported, bootstrap_role=bootstrap.username,
            )

            # Supabase owns the database and provider schemas. Grant only the
            # application owner's schema creation and runtime connection rights.
            cursor.execute(
                sql.SQL("GRANT CONNECT ON DATABASE {} TO {}, {}").format(
                    sql.Identifier(database), sql.Identifier(OWNER_ROLE),
                    sql.Identifier(RUNTIME_ROLE),
                )
            )
            cursor.execute(
                sql.SQL("GRANT USAGE, CREATE ON SCHEMA public TO {}").format(
                    sql.Identifier(OWNER_ROLE)
                )
            )
            cursor.execute(
                sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(
                    sql.Identifier(PRIVILEGE_ROLE)
                )
            )
            cursor.execute(
                sql.SQL("GRANT USAGE ON SCHEMA auth TO {}").format(
                    sql.Identifier(PRIVILEGE_ROLE)
                )
            )
            cursor.execute(
                sql.SQL("GRANT SELECT (id, user_id) ON auth.sessions TO {}").format(
                    sql.Identifier(PRIVILEGE_ROLE)
                )
            )
            _provision_session_liveness_policy(cursor)
            _provision_realtime_channel_policies(cursor)
            cursor.execute(
                "SELECT pg_catalog.to_regprocedure(%s) IS NOT NULL", (REALTIME_SEND_FUNCTION,)
            )
            if cursor.fetchone() != (True,):
                raise RuntimeError("Realtime has not initialized the required send function")
            cursor.execute(f"REVOKE USAGE ON SCHEMA realtime FROM {OWNER_ROLE}")
            cursor.execute(
                f"REVOKE EXECUTE ON FUNCTION {REALTIME_SEND_FUNCTION} "
                f"FROM PUBLIC, {OWNER_ROLE}, {PRIVILEGE_ROLE}, {RUNTIME_ROLE}, authenticated"
            )
            cursor.execute(
                """
                SELECT has_schema_privilege('openslate_owner', 'public', 'CREATE'),
                       has_database_privilege('openslate_runtime', current_database(), 'CONNECT'),
                       has_schema_privilege('openslate_runtime', 'auth', 'USAGE')
                       AND has_column_privilege('openslate_runtime','auth.sessions','id','SELECT')
                       AND has_column_privilege(
                           'openslate_runtime','auth.sessions','user_id','SELECT')
                       AND NOT has_table_privilege('openslate_runtime','auth.sessions','SELECT')
                       AND NOT has_table_privilege(
                           'openslate_runtime','auth.sessions','INSERT,UPDATE,DELETE')
                       AND NOT has_table_privilege(
                           'openslate_runtime','auth.users','SELECT,INSERT,UPDATE,DELETE')
                """
            )
            if cursor.fetchone() != (True, True, True):
                raise RuntimeError("Application database privileges are incomplete")


def main(argv: Sequence[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    settings = get_provision_settings()
    target = instance_target_for_process(settings.migration_database_url, OWNER_ROLE)
    if target is None:
        bootstrap_user = _postgres_url(
            settings.database_bootstrap_url, name="DATABASE_BOOTSTRAP_URL"
        ).username
        urls = [
            (settings.database_bootstrap_url, bootstrap_user),
            (settings.migration_database_url, OWNER_ROLE),
            (settings.database_url, RUNTIME_ROLE),
        ]
        if any(
            expected_user is None
            or not test_manifest_authorizes_process(url, expected_user)
            for url, expected_user in urls
        ):
            raise SystemExit(
                "Provisioning requires exact runner-owned database URLs in its manifest"
            )
    if settings.environment.strip().casefold() not in LOCAL_ENVIRONMENTS and not args.confirm:
        raise SystemExit("--confirm is required outside development, local, and test environments")
    provision(
        settings.database_bootstrap_url,
        settings.migration_database_url,
        settings.database_url,
        instance_target=target,
    )
    print("Provisioned OpenSlate PostgreSQL roles")


if __name__ == "__main__":
    main()
