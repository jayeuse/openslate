"""Provision the least-privilege PostgreSQL login used by FastAPI."""

import argparse
import os
from collections.abc import Sequence

from psycopg import connect, sql
from sqlalchemy.engine import make_url

RUNTIME_ROLE = "openslate_runtime"
PRIVILEGE_ROLE = "openslate_app"
LOCAL_ENVIRONMENTS = frozenset({"development", "dev", "local"})


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
                           SELECT rolsuper OR rolcreatedb OR rolcreaterole
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
                    sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(
                        sql.Identifier(RUNTIME_ROLE), sql.Literal(password)
                    )
                )
            cursor.execute(
                sql.SQL("GRANT {} TO {}").format(
                    sql.Identifier(PRIVILEGE_ROLE), sql.Identifier(RUNTIME_ROLE)
                )
            )


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
