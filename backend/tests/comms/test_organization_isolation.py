"""Runtime-role visibility for every S15 table; not a substitute for S16 policy tests."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, ProgrammingError
from uuid6 import uuid7

from app.core.database.base import Base
from app.core.database.organization_scope import apply_connection_scope
from tests.migrations.test_organization_root import COMMS_TABLES

pytestmark = pytest.mark.integration


def test_all_twenty_tables_fail_closed_and_keep_two_organization_rows_separate(comms_world):
    first = comms_world.seed_graph(comms_world.first)
    second = comms_world.seed_graph(comms_world.second)
    with comms_world.runtime.connect() as connection:
        assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
        for name in sorted(COMMS_TABLES):
            assert connection.scalar(text(f"SELECT count(*) FROM {name}")) == 0
        connection.rollback()
        for org, visible, hidden in (
            (comms_world.first, first, second), (comms_world.second, second, first),
        ):
            apply_connection_scope(connection, org.id)
            for name in sorted(COMMS_TABLES):
                rows = set(connection.scalars(text(
                    f"SELECT id FROM {name} WHERE id IN (:visible,:hidden)"
                ), {"visible": visible[name], "hidden": hidden[name]}))
                assert rows == {visible[name]}, name
                assert connection.execute(text(f"UPDATE {name} SET id=id WHERE id=:id"),
                                          {"id": hidden[name]}).rowcount == 0
                assert connection.execute(text(f"DELETE FROM {name} WHERE id=:id"),
                                          {"id": hidden[name]}).rowcount == 0
            connection.commit()
            # A new transaction on this same connection cannot retain its previous scope.
            assert connection.scalar(text("SELECT count(*) FROM comms_messages")) == 0
            connection.rollback()


def test_every_table_rejects_cross_organization_insert_even_with_valid_parent_ids(comms_world):
    second = comms_world.seed_graph(comms_world.second)
    with comms_world.owner.connect() as owner:
        stored = {}
        for name in COMMS_TABLES:
            table = Base.metadata.tables[name]
            row = dict(owner.execute(select(table).where(
                table.c.id == second[name],
            )).mappings().one())
            stored[name] = {
                key: value for key, value in row.items() if table.c[key].computed is None
            }
    attempted_ids = {}
    with comms_world.runtime.begin() as connection:
        apply_connection_scope(connection, comms_world.first.id)
        for name in sorted(COMMS_TABLES):
            values = stored[name] | {"id": uuid7()}
            attempted_ids[name] = values["id"]
            if name == "comms_message_revisions":
                with pytest.raises(IntegrityError) as guarded, connection.begin_nested():
                    connection.execute(Base.metadata.tables[name].insert().values(**values))
                assert guarded.value.orig.sqlstate == "23514", name
                assert guarded.value.orig.diag.constraint_name == (
                    "ck_comms_message_revisions_parent_org"
                )
            else:
                with pytest.raises(ProgrammingError) as denied, connection.begin_nested():
                    connection.execute(Base.metadata.tables[name].insert().values(**values))
                assert denied.value.orig.sqlstate == "42501", name
    # Observe committed storage through the owner, not the caller's RLS-filtered view.
    with comms_world.owner.connect() as owner:
        for name, identity in attempted_ids.items():
            table = Base.metadata.tables[name]
            assert owner.scalar(select(table.c.id).where(table.c.id == identity)) is None, name


def test_application_default_grants_do_not_expose_comms_to_provider_browser_roles(comms_world):
    with comms_world.owner.connect() as connection:
        for name in sorted(COMMS_TABLES):
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                assert connection.scalar(text(
                    "SELECT has_table_privilege('openslate_runtime', :table, :privilege)"
                ), {"table": f"public.{name}", "privilege": privilege}) is True
                for role in ("anon", "authenticated", "service_role"):
                    assert connection.scalar(text(
                        "SELECT has_table_privilege(:role, :table, :privilege)"
                    ), {"role": role, "table": f"public.{name}", "privilege": privilege}) is False
