"""Partial indexes use the predicate form that `.is_(False)` and `.is_(True)` queries can use.

PostgreSQL proves a partial index usable by matching the query's terms against its
predicate. `is_deleted IS FALSE` does not match `is_deleted = false` or `NOT is_deleted` in
either direction, so a mismatch hides the index. `alembic check` never compares
`postgresql_where`; only these tests keep the models and the catalog in that form.
"""

import importlib
import json
import os
import re
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import UUID

import pytest
from sqlalchemy import Connection, Engine, event, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from sqlalchemy.sql import Select

from app.core.database import Base
from app.systems.openview.views.models import SavedView
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.conftest import alembic_heads, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

# Base.metadata holds only the models that something imported.
importlib.import_module("app.core.database.model_registry")

integration = pytest.mark.integration
PREVIOUS = "f8852c638a76"
ORG = UUID("00000000-0000-7000-8000-000000000001")
FIELD = UUID("00000000-0000-7000-8000-000000000002")
TARGET = UUID("00000000-0000-7000-8000-000000000003")
MODULE = UUID("00000000-0000-7000-8000-000000000004")

_NAMES_DELETED = re.compile(r"\bis_deleted\b")
_WRONG_FORM = re.compile(r"\bis_deleted\b(?! IS FALSE\b)|\bis_(?:home|default)\b(?! IS TRUE\b)")
_CATALOG_NOISE = re.compile(r"[()]|::\w+")
_INDEXES = text(
    """
    SELECT c.relname AS name, c.oid AS oid, i.indisvalid AS valid, i.indisunique AS is_unique,
           pg_get_indexdef(i.indexrelid) AS definition,
           pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index AS i
      JOIN pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
    """
)


@dataclass(frozen=True)
class CatalogIndex:
    oid: int
    valid: bool
    is_unique: bool
    definition: str
    predicate: str | None


def _catalog(connection: Connection) -> dict[str, CatalogIndex]:
    rows = connection.execute(_INDEXES).mappings()
    return {
        row["name"]: CatalogIndex(
            row["oid"], row["valid"], row["is_unique"], row["definition"], row["predicate"]
        )
        for row in rows
    }


def _soft_delete_predicates(indexes: dict[str, CatalogIndex]) -> dict[str, str]:
    return {
        name: index.predicate
        for name, index in indexes.items()
        if index.predicate is not None and _NAMES_DELETED.search(index.predicate)
    }


def _model_predicates() -> dict[str, str]:
    predicates = {
        index.name: str(index.dialect_options["postgresql"]["where"])
        for table in Base.metadata.tables.values()
        for index in table.indexes
        if index.name is not None and index.dialect_options["postgresql"]["where"] is not None
    }
    return {name: where for name, where in predicates.items() if _NAMES_DELETED.search(where)}


def _without_predicate(indexes: dict[str, CatalogIndex]) -> dict[str, str]:
    return {name: index.definition.split(" WHERE ")[0] for name, index in indexes.items()}


@pytest.mark.parametrize(
    ("predicate", "wrong"),
    [
        ("is_deleted = false", True),
        ("NOT is_deleted", True),
        ("(NOT is_deleted)", True),
        ("is_deleted IS NOT TRUE", True),
        ("is_home AND is_deleted IS FALSE", True),
        ("is_default IS TRUE AND NOT is_deleted", True),
        ("read_at IS NULL AND is_deleted IS FALSE", False),
        ("is_home IS TRUE AND is_deleted IS FALSE", False),
        ("(((status)::text = 'pending'::text) AND (is_deleted IS FALSE))", False),
    ],
)
def test_the_rule_rejects_each_form_that_the_planner_cannot_match(
    predicate: str, wrong: bool
) -> None:
    assert bool(_WRONG_FORM.search(predicate)) is wrong


def test_model_predicates_use_the_form_that_boolean_filters_can_match() -> None:
    assert [
        name for name, where in sorted(_model_predicates().items()) if _WRONG_FORM.search(where)
    ] == []


@integration
def test_catalog_predicates_use_that_form_and_match_the_models(
    integration_owner_db: Session,
) -> None:
    predicates = _soft_delete_predicates(_catalog(integration_owner_db.connection()))
    assert [name for name, where in sorted(predicates.items()) if _WRONG_FORM.search(where)] == []
    assert {name: _CATALOG_NOISE.sub("", where) for name, where in predicates.items()} == (
        _model_predicates()
    )


@integration
def test_a_new_index_in_an_old_form_fails_the_catalog_rule(integration_owner_db: Session) -> None:
    connection = integration_owner_db.connection()
    connection.execute(
        text("CREATE INDEX ix_equals_false ON public.fields (module_id) WHERE is_deleted = false")
    )
    connection.execute(
        text("CREATE INDEX ix_not_deleted ON public.fields (module_id) WHERE NOT is_deleted")
    )

    predicates = _soft_delete_predicates(_catalog(connection))

    wrong = {name for name, where in predicates.items() if _WRONG_FORM.search(where)}
    assert {"ix_equals_false", "ix_not_deleted"} <= wrong


def _edge_conflict_read() -> Select[tuple[UUID]]:
    return (
        select(RelationshipEdge.id)
        .where(
            RelationshipEdge.org_id == ORG,
            RelationshipEdge.field_id == FIELD,
            RelationshipEdge.is_deleted.is_(False),
            RelationshipEdge.target_record_id == TARGET,
        )
        .order_by(RelationshipEdge.id)
    )


def _default_view_read() -> Select[tuple[UUID]]:
    return select(SavedView.id).where(
        SavedView.module_id == MODULE,
        SavedView.is_default.is_(True),
        SavedView.is_deleted.is_(False),
    )


@integration
@pytest.mark.parametrize(
    ("statement", "index", "equal_cost_rival"),
    [
        (
            _edge_conflict_read,
            "ix_relationship_edges_active_target",
            "uq_relationship_edges_active",
        ),
        (_default_view_read, "uq_saved_views_module_default", None),
    ],
)
def test_a_boolean_filter_reads_the_partial_index_and_filters_nothing_again(
    integration_owner_db: Session,
    statement: Callable[[], Select[tuple[UUID]]],
    index: str,
    equal_cost_rival: str | None,
) -> None:
    connection = integration_owner_db.connection()
    connection.execute(text("SET LOCAL enable_seqscan = off"))
    if equal_cost_rival is not None:
        # An empty table gives both partial indexes one cost, and a tie proves nothing.
        # The fixture's rollback restores the index.
        connection.execute(text(f"DROP INDEX public.{equal_cost_rival}"))
    sql = statement().compile(dialect=connection.dialect, compile_kwargs={"literal_binds": True})

    plan = json.dumps(connection.scalar(text(f"EXPLAIN (FORMAT JSON) {sql}")))

    assert f'"Index Name": "{index}"' in plan
    assert "is_deleted" not in plan


@pytest.fixture
def migration() -> Iterator[tuple[dict[str, str], Engine]]:
    """Each test starts at the head and hands the database back at the head."""
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    try:
        yield environment, engine
    finally:
        run_alembic(environment, "upgrade", head)
        engine.dispose()


def _read_catalog(engine: Engine) -> dict[str, CatalogIndex]:
    with engine.connect() as connection:
        return _catalog(connection)


def _version(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return connection.scalar(text("SELECT version_num FROM alembic_version"))


@contextmanager
def _statements() -> Iterator[list[str]]:
    seen: list[str] = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany) -> None:
        seen.append(statement)

    event.listen(Engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(Engine, "before_cursor_execute", record)


@integration
def test_upgrade_and_downgrade_change_only_the_predicates(
    migration: tuple[dict[str, str], Engine],
) -> None:
    environment, engine = migration
    [head] = alembic_heads()
    at_head = _read_catalog(engine)

    run_alembic(environment, "downgrade", PREVIOUS)
    restored = _read_catalog(engine)
    assert sorted(_soft_delete_predicates(restored)) == sorted(_soft_delete_predicates(at_head))
    assert all(_WRONG_FORM.search(where) for where in _soft_delete_predicates(restored).values())
    assert _without_predicate(restored) == _without_predicate(at_head)

    # The old revisions, not this file's own text, say what the downgrade must restore.
    run_alembic(environment, "downgrade", "base")
    run_alembic(environment, "upgrade", PREVIOUS)
    original = _read_catalog(engine)
    assert {name: index.definition for name, index in restored.items()} == {
        name: index.definition for name, index in original.items()
    }

    run_alembic(environment, "upgrade", head)
    assert {name: index.definition for name, index in _read_catalog(engine).items()} == {
        name: index.definition for name, index in at_head.items()
    }
    run_alembic(environment, "check")


@integration
def test_each_index_is_built_concurrently_before_its_old_index_is_dropped(
    migration: tuple[dict[str, str], Engine],
) -> None:
    environment, engine = migration
    [head] = alembic_heads()
    run_alembic(environment, "downgrade", PREVIOUS)
    names = sorted(_soft_delete_predicates(_read_catalog(engine)))

    with _statements() as seen:
        run_alembic(environment, "upgrade", head)

    index_statements = [
        statement
        for statement in seen
        if re.match(r"\s*(CREATE (UNIQUE )?INDEX|DROP INDEX|ALTER INDEX)", statement)
    ]
    built = [
        statement
        for statement in index_statements
        if re.match(r"\s*CREATE (UNIQUE )?INDEX", statement)
    ]
    assert len(built) == len(names)
    assert all("INDEX CONCURRENTLY " in statement for statement in built)
    for name in names:
        order = [
            kind
            for statement in index_statements
            for kind, pattern in (
                ("build", rf"CREATE (UNIQUE )?INDEX CONCURRENTLY {name}_swap ON "),
                ("drop", rf"DROP INDEX CONCURRENTLY IF EXISTS {name}$"),
                ("rename", rf"ALTER INDEX public\.{name}_swap RENAME TO {name}$"),
            )
            if re.match(pattern, statement.strip())
        ]
        assert order == ["build", "drop", "rename"], name


@integration
def test_a_stopped_upgrade_keeps_every_unique_rule_and_a_rerun_finishes(
    migration: tuple[dict[str, str], Engine],
) -> None:
    # A real stop: the writer on `modules` outlasts the 5 s lock limit, so the concurrent
    # build fails after its catalog row exists and leaves an INVALID index.
    environment, engine = migration
    [head] = alembic_heads()
    at_head = _read_catalog(engine)
    run_alembic(environment, "downgrade", PREVIOUS)
    before = _read_catalog(engine)

    with engine.connect() as holder:
        holder.execute(text("SET idle_in_transaction_session_timeout = '30s'"))
        holder.commit()
        holder.execute(text("LOCK TABLE public.modules IN ROW EXCLUSIVE MODE"))
        with pytest.raises(subprocess.CalledProcessError) as failure:
            run_alembic(environment, "upgrade", head)
        holder.rollback()
    assert "lock timeout" in failure.value.stderr

    stopped = _read_catalog(engine)
    assert _version(engine) == PREVIOUS
    assert stopped["uq_modules_department_name_active_swap"].valid is False
    assert stopped["uq_modules_department_name_active"].predicate == "(is_deleted = false)"
    assert [
        name
        for name, index in before.items()
        if index.is_unique and not (name in stopped and stopped[name].valid)
    ] == []
    finished = {
        name
        for name, where in _soft_delete_predicates(stopped).items()
        if not _WRONG_FORM.search(where) and not name.endswith("_swap")
    }
    assert finished

    run_alembic(environment, "upgrade", head)

    rerun = _read_catalog(engine)
    assert _version(engine) == head
    assert {name: index.definition for name, index in rerun.items()} == {
        name: index.definition for name, index in at_head.items()
    }
    assert {name: rerun[name].oid for name in finished} == {
        name: stopped[name].oid for name in finished
    }


@integration
@pytest.mark.parametrize("old_index_is_gone", [False, True])
def test_a_rerun_keeps_a_valid_swap_index_and_only_renames_it(
    migration: tuple[dict[str, str], Engine], old_index_is_gone: bool
) -> None:
    environment, engine = migration
    [head] = alembic_heads()
    name = "uq_departments_name_active"
    run_alembic(environment, "downgrade", PREVIOUS)

    with engine.begin() as connection:
        connection.execute(
            text(
                f"CREATE UNIQUE INDEX {name}_swap ON public.departments "
                "(org_id, department_name) WHERE is_deleted IS FALSE"
            )
        )
        if old_index_is_gone:
            connection.execute(text(f"DROP INDEX public.{name}"))
    swap = _read_catalog(engine)[f"{name}_swap"]

    run_alembic(environment, "upgrade", head)

    indexes = _read_catalog(engine)
    assert f"{name}_swap" not in indexes
    assert indexes[name].oid == swap.oid
    assert indexes[name].predicate == "(is_deleted IS FALSE)"
