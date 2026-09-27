"""Limit Alembic reflection to application-owned public objects."""

from collections.abc import Callable, Mapping

from sqlalchemy import MetaData, text
from sqlalchemy.engine import Connection

IncludeName = Callable[[str | None, str, Mapping[str, str | None]], bool]


def application_migration_scope(connection: Connection, metadata: MetaData) -> IncludeName:
    model_names = {table.name for table in metadata.tables.values()}
    if any(table.schema not in (None, "public") for table in metadata.tables.values()):
        raise RuntimeError("Application models must use the public schema")
    rows = connection.execute(text("""
        SELECT c.relname, c.relowner = current_user::regrole::oid AS app_owned
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    """)).all()
    if any(name in model_names and not owned for name, owned in rows):
        raise RuntimeError("A model table is not owned by the application migration role")
    # Keep removed application tables visible so a later deliberate model
    # removal still produces drift, while provider relations stay untouched.
    allowed = model_names | {name for name, owned in rows if owned}

    def include_name(
        name: str | None, kind: str, parents: Mapping[str, str | None],
    ) -> bool:
        if kind == "schema":
            return name in (None, "public")
        if parents.get("schema_name") not in (None, "public"):
            return False
        if kind == "table":
            return name in allowed
        table_name = parents.get("table_name")
        return table_name is None or table_name in allowed

    return include_name
