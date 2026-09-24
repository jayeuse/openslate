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
INSPECTOR_ROLE = "openslate_inspector"
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
    if bootstrap.username in {OWNER_ROLE, RUNTIME_ROLE, INSPECTOR_ROLE}:
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


def _validate_managed_role_memberships(cursor: object, *, options_supported: bool) -> None:
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
         WHERE member_role.rolname IN (%s, %s, %s, %s)
            OR granted_role.rolname IN (%s, %s, %s, %s)
         ORDER BY member_role.rolname, granted_role.rolname
        """,
        (
            OWNER_ROLE,
            PRIVILEGE_ROLE,
            RUNTIME_ROLE,
            INSPECTOR_ROLE,
            OWNER_ROLE,
            PRIVILEGE_ROLE,
            RUNTIME_ROLE,
            INSPECTOR_ROLE,
        ),
    )
    expected = (
        [(RUNTIME_ROLE, PRIVILEGE_ROLE, False, True, False)]
        if options_supported
        else [(RUNTIME_ROLE, PRIVILEGE_ROLE, False)]
    )
    if cursor.fetchall() != expected:  # type: ignore[attr-defined]
        raise RuntimeError("Managed PostgreSQL roles have unsafe membership")


def provision(
    bootstrap_url: str,
    migration_url: str,
    runtime_url: str,
    inspector_url: str | None = None,
    *,
    instance_target: InstanceTarget | None = None,
) -> None:
    bootstrap = _postgres_url(bootstrap_url, name="DATABASE_BOOTSTRAP_URL")
    owner = _postgres_url(migration_url, name="MIGRATION_DATABASE_URL")
    runtime = _postgres_url(runtime_url, name="DATABASE_URL")
    inspector = (
        _postgres_url(inspector_url, name="DATABASE_INSPECTOR_URL") if inspector_url else None
    )
    owner_password = _password(owner, name="MIGRATION_DATABASE_URL", role=OWNER_ROLE)
    runtime_password = _password(runtime, name="DATABASE_URL", role=RUNTIME_ROLE)
    inspector_password = (
        _password(inspector, name="DATABASE_INSPECTOR_URL", role=INSPECTOR_ROLE)
        if inspector is not None
        else None
    )
    database = _assert_same_database(
        bootstrap, owner, runtime, *([inspector] if inspector is not None else [])
    )
    if instance_target is not None:
        assert_database_url(bootstrap_url, instance_target, expected_user=None)
        assert_database_url(migration_url, instance_target, expected_user=OWNER_ROLE)
        assert_database_url(runtime_url, instance_target, expected_user=RUNTIME_ROLE)
        if inspector_url is not None:
            assert_database_url(inspector_url, instance_target, expected_user=INSPECTOR_ROLE)

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
            if inspector_password is not None:
                _create_role(
                    cursor,
                    INSPECTOR_ROLE,
                    "LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
                    inspector_password,
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
            if inspector_password is not None:
                _safe_role_attributes(
                    cursor, INSPECTOR_ROLE, (True, False, False, False, False, False, False)
                )
            _rotate_password(cursor, OWNER_ROLE, owner_password)
            _rotate_password(cursor, RUNTIME_ROLE, runtime_password)
            if inspector_password is not None:
                _rotate_password(cursor, INSPECTOR_ROLE, inspector_password)

            options_supported = bool(_membership_columns(cursor))
            grant = sql.SQL("GRANT {} TO {}").format(
                sql.Identifier(PRIVILEGE_ROLE), sql.Identifier(RUNTIME_ROLE)
            )
            if options_supported:
                grant += sql.SQL(" WITH INHERIT TRUE, SET FALSE")
            cursor.execute(grant)
            _validate_runtime_membership(cursor, options_supported=options_supported)
            _validate_managed_role_memberships(cursor, options_supported=options_supported)

            cursor.execute(
                sql.SQL("ALTER DATABASE {} OWNER TO {}").format(
                    sql.Identifier(database), sql.Identifier(OWNER_ROLE)
                )
            )
            cursor.execute(
                sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(database))
            )
            cursor.execute(
                sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                    sql.Identifier(database), sql.Identifier(RUNTIME_ROLE)
                )
            )
            if inspector_password is not None:
                cursor.execute(
                    sql.SQL("REVOKE ALL ON DATABASE {} FROM {}").format(
                        sql.Identifier(database), sql.Identifier(INSPECTOR_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                        sql.Identifier(database), sql.Identifier(INSPECTOR_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL("REVOKE ALL ON SCHEMA public FROM {}").format(
                        sql.Identifier(INSPECTOR_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(
                        sql.Identifier(INSPECTOR_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {}").format(
                        sql.Identifier(INSPECTOR_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA public TO {}").format(
                        sql.Identifier(INSPECTOR_ROLE)
                    )
                )
                cursor.execute(
                    sql.SQL(
                        "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                        "REVOKE ALL ON TABLES FROM {}"
                    ).format(sql.Identifier(OWNER_ROLE), sql.Identifier(INSPECTOR_ROLE))
                )
                cursor.execute(
                    sql.SQL(
                        "ALTER DEFAULT PRIVILEGES FOR ROLE {} IN SCHEMA public "
                        "GRANT SELECT ON TABLES TO {}"
                    ).format(sql.Identifier(OWNER_ROLE), sql.Identifier(INSPECTOR_ROLE))
                )
            cursor.execute(
                """
                SELECT datdba::regrole::text,
                       has_database_privilege('public', current_database(), 'CONNECT')
                  FROM pg_catalog.pg_database
                 WHERE datname = current_database()
                """
            )
            if cursor.fetchone() != (OWNER_ROLE, False):
                raise RuntimeError("Database ownership or PUBLIC privileges are unsafe")


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
        if settings.database_inspector_url is not None:
            urls.append((settings.database_inspector_url, INSPECTOR_ROLE))
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
        settings.database_inspector_url,
        instance_target=target,
    )
    print("Provisioned OpenSlate PostgreSQL roles")


if __name__ == "__main__":
    main()
