"""Every soft-delete table rejects an is_deleted and deleted_at pair that disagree."""

import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic, sleep

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from app.systems.sandbox.departments.models import Department
from tests.conftest import alembic_heads, create_organization, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
BACKEND = Path(__file__).resolve().parents[2]
BEFORE_CHECKS, CHECKS = "48e05d7138d7", "e10810d4789c"
_WAITING_ON_RECORDS = text(
    "SELECT pid FROM pg_stat_activity WHERE datname = current_database() "
    "AND wait_event_type = 'Lock' AND query ILIKE '%ck_records_deletion_state%'"
)
_EXCLUSIVE_TABLE_LOCKS = text(
    "SELECT count(*) FROM pg_locks AS l JOIN pg_class AS c ON c.oid = l.relation "
    "WHERE l.pid = :pid AND l.granted AND l.mode = 'AccessExclusiveLock' AND c.relkind = 'r'"
)

# Tables with both soft-delete columns that lack a validated pair check of the shared form.
_UNCHECKED = text(
    """
    SELECT c.relname
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid
                   AND attname = 'is_deleted' AND NOT attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = c.oid
                   AND attname = 'deleted_at' AND NOT attisdropped)
       AND NOT EXISTS (
           SELECT 1 FROM pg_constraint AS con
            WHERE con.conrelid = c.oid AND con.contype = 'c' AND con.convalidated
              AND con.conname = 'ck_' || c.relname || '_deletion_state'
              AND pg_get_constraintdef(con.oid) = :definition
       )
     ORDER BY 1
    """
)
_DEFINITION = (
    "CHECK (((is_deleted AND (deleted_at IS NOT NULL)) OR "
    "((NOT is_deleted) AND (deleted_at IS NULL))))"
)


def test_every_soft_delete_table_has_a_validated_deletion_state_check(
    integration_owner_db: Session,
) -> None:
    # 82 tables kept the pair only in application code (plan finding F7). The query reads
    # the catalog, so a table that defines the columns without BaseModel is checked too.
    connection = integration_owner_db.connection()
    tables = connection.scalar(
        text(
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_schema = 'public' AND column_name = 'deleted_at'"
        )
    )
    assert tables is not None and tables > 0
    unchecked = connection.scalars(_UNCHECKED, {"definition": _DEFINITION}).all()
    assert unchecked == []


@pytest.mark.parametrize(
    ("is_deleted", "deleted_at"),
    [
        pytest.param(True, None, id="deleted-without-time"),
        pytest.param(False, datetime(2026, 10, 31, tzinfo=UTC), id="live-with-time"),
    ],
)
def test_a_mismatched_soft_delete_pair_is_rejected(
    integration_db: Session, is_deleted: bool, deleted_at: datetime | None
) -> None:
    organization = create_organization(integration_db)
    integration_db.add(
        Department(
            org_id=organization.id,
            department_name=f"Deletion state {uuid7()}",
            is_deleted=is_deleted,
            deleted_at=deleted_at,
        )
    )
    with pytest.raises(IntegrityError) as rejected:
        integration_db.flush()
    assert getattr(rejected.value.orig, "sqlstate", None) == "23514"
    assert rejected.value.orig.diag.constraint_name == "ck_departments_deletion_state"


def test_the_deletion_state_migration_locks_one_table_at_a_time() -> None:
    # 82 NOT VALID additions in one transaction held an ACCESS EXCLUSIVE lock on every
    # earlier table until the validation, so one busy table stopped writes to all of them.
    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    run: subprocess.Popen[str] | None = None
    try:
        run_alembic(environment, "downgrade", BEFORE_CHECKS)
        with (
            engine.connect() as holder,
            engine.connect().execution_options(isolation_level="AUTOCOMMIT") as observer,
        ):
            holder.execute(text("LOCK TABLE public.records IN SHARE MODE"))
            run = subprocess.Popen(
                [sys.executable, "-m", "alembic", "upgrade", CHECKS],
                cwd=BACKEND, env=environment, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            deadline = monotonic() + 60
            while (pid := observer.scalar(_WAITING_ON_RECORDS)) is None:
                assert run.poll() is None, run.communicate()[0][-1500:]
                assert monotonic() < deadline, "the migration never reached the records table"
                sleep(0.05)
            assert observer.scalar(_EXCLUSIVE_TABLE_LOCKS, {"pid": pid}) == 0
            holder.rollback()
        output = run.communicate(timeout=120)[0]
        assert run.returncode == 0, output
    finally:
        if run is not None and run.poll() is None:
            run.kill()
            run.communicate()
        run_alembic(environment, "upgrade", head)
        engine.dispose()
