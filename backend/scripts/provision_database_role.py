"""Provision the least-privilege PostgreSQL login used by FastAPI."""

import argparse
import os
from collections.abc import Sequence

from psycopg import connect, sql
from sqlalchemy.engine import make_url

RUNTIME_ROLE = "openslate_runtime"
PRIVILEGE_ROLE = "openslate_app"
LOCAL_ENVIRONMENTS = frozenset({"development", "dev", "local"})
MEMBERSHIP_OPTION_COLUMNS = frozenset({"inherit_option", "set_option"})


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="required outside development/local environments",
    )
    return parser


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _psycopg_url(value: str) -> str:
    url = make_url(value)
    if url.drivername not in {"postgresql", "postgresql+psycopg"}:
        raise SystemExit("MIGRATION_DATABASE_URL must use PostgreSQL")
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def provision(migration_url: str, password: str) -> None:
    with connect(_psycopg_url(migration_url)) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s),
                       COALESCE((
                           SELECT NOT (rolcanlogin AND rolinherit)
                                  OR rolsuper OR rolcreatedb OR rolcreaterole
                                  OR rolreplication OR rolbypassrls
                             FROM pg_roles
                            WHERE rolname = %s
                       ), false)
                """,
                (RUNTIME_ROLE, RUNTIME_ROLE),
            )
            row = cursor.fetchone()
            if row is None:
                raise RuntimeError("Unable to inspect PostgreSQL roles")
            exists = bool(row[0])
            if bool(row[1]):
                raise RuntimeError("Existing runtime role has unsafe privileges")
            if not exists:
                cursor.execute(
                    sql.SQL(
                        "CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                        "NOREPLICATION NOBYPASSRLS PASSWORD {}"
                    ).format(sql.Identifier(RUNTIME_ROLE), sql.Literal(password))
                )
            else:
                cursor.execute(
                    sql.SQL("ALTER ROLE {} WITH LOGIN INHERIT PASSWORD {}").format(
                        sql.Identifier(RUNTIME_ROLE), sql.Literal(password)
                    )
                )
            cursor.execute(
                """
                SELECT attname
                  FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'pg_catalog.pg_auth_members'::regclass
                   AND attname IN (%s, %s)
                   AND NOT attisdropped
                """,
                tuple(MEMBERSHIP_OPTION_COLUMNS),
            )
            membership_option_columns = {row[0] for row in cursor.fetchall()}
            if membership_option_columns not in (set(), set(MEMBERSHIP_OPTION_COLUMNS)):
                raise RuntimeError("PostgreSQL role membership options are incomplete")

            grant = sql.SQL("GRANT {} TO {}").format(
                sql.Identifier(PRIVILEGE_ROLE), sql.Identifier(RUNTIME_ROLE)
            )
            if membership_option_columns:
                # Do not include ADMIN FALSE: an existing delegated edge must
                # fail verification and roll back rather than being revoked.
                grant += sql.SQL(" WITH INHERIT TRUE, SET FALSE")
            cursor.execute(grant)
            cursor.execute(
                """
                SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb,
                       rolcreaterole, rolreplication, rolbypassrls
                  FROM pg_catalog.pg_roles
                 WHERE rolname = %s
                """,
                (RUNTIME_ROLE,),
            )
            attributes = cursor.fetchone()
            if attributes != (True, True, False, False, False, False, False):
                raise RuntimeError("Provisioned runtime role has unsafe runtime role attributes")

            cursor.execute(
                """
                SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb,
                       rolcreaterole, rolreplication, rolbypassrls
                  FROM pg_catalog.pg_roles
                 WHERE rolname = %s
                """,
                (PRIVILEGE_ROLE,),
            )
            privilege_attributes = cursor.fetchone()
            # The migration creates this NOLOGIN group role without NOINHERIT, so
            # PostgreSQL's default INHERIT is part of the expected role contract.
            if privilege_attributes != (False, True, False, False, False, False, False):
                raise RuntimeError("Privilege role has unsafe privilege role attributes")

            cursor.execute(
                """
                SELECT membership.admin_option,
                       membership.inherit_option,
                       membership.set_option
                  FROM pg_catalog.pg_auth_members AS membership
                  JOIN pg_catalog.pg_roles AS member_role
                    ON member_role.oid = membership.member
                  JOIN pg_catalog.pg_roles AS granted_role
                    ON granted_role.oid = membership.roleid
                 WHERE member_role.rolname = %s
                   AND granted_role.rolname = %s
                """
                if membership_option_columns
                else """
                SELECT membership.admin_option
                  FROM pg_catalog.pg_auth_members AS membership
                  JOIN pg_catalog.pg_roles AS member_role
                    ON member_role.oid = membership.member
                  JOIN pg_catalog.pg_roles AS granted_role
                    ON granted_role.oid = membership.roleid
                 WHERE member_role.rolname = %s
                   AND granted_role.rolname = %s
                """,
                (RUNTIME_ROLE, PRIVILEGE_ROLE),
            )
            direct_membership = cursor.fetchone()
            if direct_membership is None or direct_membership[0] is not False:
                raise RuntimeError("Provisioned runtime role has administrative role membership")
            if membership_option_columns and direct_membership[1:] != (True, False):
                raise RuntimeError("Provisioned runtime role has unsafe membership options")

            cursor.execute(
                """
                WITH RECURSIVE inherited_roles(oid, rolname) AS (
                    SELECT role_row.oid, role_row.rolname
                      FROM pg_catalog.pg_roles AS role_row
                     WHERE role_row.rolname = %s
                    UNION
                    SELECT granted_role.oid, granted_role.rolname
                      FROM inherited_roles AS member_role
                      JOIN pg_catalog.pg_auth_members AS membership
                        ON membership.member = member_role.oid
                      JOIN pg_catalog.pg_roles AS granted_role
                        ON granted_role.oid = membership.roleid
                )
                SELECT rolname
                  FROM inherited_roles
                 WHERE rolname <> %s
                 ORDER BY rolname
                """,
                (RUNTIME_ROLE, RUNTIME_ROLE),
            )
            inherited_memberships = {row[0] for row in cursor.fetchall()}
            if inherited_memberships != {PRIVILEGE_ROLE}:
                raise RuntimeError("Provisioned runtime role has unexpected role membership")


def main(argv: Sequence[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    environment = os.environ.get("ENVIRONMENT", "development").strip().casefold()
    if environment not in LOCAL_ENVIRONMENTS and not args.confirm:
        raise SystemExit("--confirm is required outside development/local environments")

    provision(
        _required_environment("MIGRATION_DATABASE_URL"),
        _required_environment("OPENSLATE_DATABASE_PASSWORD"),
    )
    print(f"Provisioned database role {RUNTIME_ROLE}")


if __name__ == "__main__":
    main()
