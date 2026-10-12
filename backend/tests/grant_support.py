"""Table grant checks with the real PostgreSQL roles (plan item 20).

Every application table grants exactly the four data privileges to ``openslate_runtime``
and none of them to the Supabase provider roles. Rows of the table under test name it.
"""

from sqlalchemy import Connection, text

RUNTIME_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE")
PROVIDER_ROLES = ("anon", "authenticated", "service_role")


def assert_runtime_only_grants(connection: Connection, table_name: str) -> None:
    """The runtime role holds every data privilege on *table_name*; provider roles hold none."""

    statement = text("SELECT has_table_privilege(:role, :table_name, :privilege)")
    for privilege in RUNTIME_PRIVILEGES:
        granted = {"role": "openslate_runtime", "table_name": table_name, "privilege": privilege}
        assert connection.scalar(statement, granted) is True, granted
        for role in PROVIDER_ROLES:
            denied = {"role": role, "table_name": table_name, "privilege": privilege}
            assert connection.scalar(statement, denied) is False, denied
