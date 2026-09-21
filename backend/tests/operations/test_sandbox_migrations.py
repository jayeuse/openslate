"""Historical Sandbox migration regressions on a runner-owned PostgreSQL database."""

import json

import pytest
from sqlalchemy import text
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic


@pytest.mark.integration
def test_normalized_placeholder_cleanup_preserves_genuine_checkpoint() -> None:
    environment = guarded_migration_environment()
    placeholder_hash = "bbaea97be6c1a9edd7cefefbf242c91f8683257c291eae4338a5ddfdffa26409"
    empty_document = {
        "kind": "openslate-sandbox",
        "schemaVersion": 2,
        "design": {"departments": [], "modules": [], "relationships": [], "layout": {}},
        "automations": [],
        "scenarios": [],
    }
    version_ids = (str(uuid7()), str(uuid7()))
    original: dict[str, object] | None = None
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        run_alembic(environment, "downgrade", "a96c2f4e7d31")
        with owner_engine.begin() as connection:
            original = dict(
                connection.execute(
                    text(
                        "SELECT id, document::text AS document, content_hash, byte_count, revision "
                        "FROM public.sandbox_documents"
                    )
                ).mappings().one()
            )
            connection.execute(
                text(
                    "UPDATE public.sandbox_documents "
                    "SET document = CAST(:document AS jsonb), content_hash = :content_hash, "
                    "byte_count = :byte_count, revision = 1"
                ),
                {
                    "document": json.dumps(empty_document),
                    "content_hash": placeholder_hash,
                    "byte_count": len(json.dumps(empty_document).encode()),
                },
            )
            for sequence, version_id, kind, label in (
                (101, version_ids[0], "release", "Starting structure"),
                (102, version_ids[1], "checkpoint", "Genuine checkpoint"),
            ):
                connection.execute(
                    text(
                        "INSERT INTO public.sandbox_versions "
                        "(id, document_id, sequence, kind, label, source_document_revision, "
                        "snapshot, content_hash, byte_count, metadata_revision) "
                        "VALUES (:id, :document_id, :sequence, :kind, :label, 1, "
                        "CAST(:snapshot AS jsonb), :content_hash, :byte_count, 1)"
                    ),
                    {
                        "id": version_id,
                        "document_id": original["id"],
                        "sequence": sequence,
                        "kind": kind,
                        "label": label,
                        "snapshot": json.dumps(empty_document),
                        "content_hash": placeholder_hash,
                        "byte_count": len(json.dumps(empty_document).encode()),
                    },
                )

        run_alembic(environment, "upgrade", "b47e91a6c3d2")

        with owner_engine.connect() as connection:
            remaining = connection.execute(
                text(
                    "SELECT id, kind, label FROM public.sandbox_versions "
                    "WHERE id IN (:release_id, :checkpoint_id) ORDER BY sequence"
                ),
                {"release_id": version_ids[0], "checkpoint_id": version_ids[1]},
            ).mappings().all()
        assert [
            (str(row["id"]), row["kind"], row["label"])
            for row in remaining
        ] == [(version_ids[1], "checkpoint", "Genuine checkpoint")]
    finally:
        run_alembic(environment, "upgrade", "head")
        if original is not None:
            with owner_engine.begin() as connection:
                connection.execute(
                    text(
                        "DELETE FROM public.sandbox_versions "
                        "WHERE id IN (:release_id, :checkpoint_id)"
                    ),
                    {"release_id": version_ids[0], "checkpoint_id": version_ids[1]},
                )
                connection.execute(
                    text(
                        "UPDATE public.sandbox_documents "
                        "SET document = CAST(:document AS jsonb), content_hash = :content_hash, "
                        "byte_count = :byte_count, revision = :revision"
                    ),
                    original,
                )
        owner_engine.dispose()


@pytest.mark.integration
def test_schedule_progress_repair_converges_legacy_ff_schema_and_downgrades_safely() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        run_alembic(environment, "downgrade", "ff192a8fcc06")
        with owner_engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE public.published_automation_events "
                    "DROP CONSTRAINT ck_published_automation_events_schedule_progress, "
                    "DROP COLUMN schedule_action_count, "
                    "DROP COLUMN schedule_matched_count, "
                    "DROP COLUMN schedule_cursor_record_id, "
                    "DROP COLUMN schedule_upper_record_id"
                )
            )

        run_alembic(environment, "upgrade", "5147066a0b3a")
        with owner_engine.connect() as connection:
            repaired_columns = _schedule_progress_columns(connection)
            repaired_constraint = _schedule_progress_constraint(connection)
        assert repaired_columns == [
            ("schedule_action_count", "NO", "0"),
            ("schedule_cursor_record_id", "YES", None),
            ("schedule_matched_count", "NO", "0"),
            ("schedule_upper_record_id", "YES", None),
        ]
        assert all(
            name in repaired_constraint
            for name in (
                "schedule_upper_record_id",
                "schedule_cursor_record_id",
                "schedule_matched_count",
                "schedule_action_count",
            )
        )

        run_alembic(environment, "downgrade", "ff192a8fcc06")
        with owner_engine.connect() as connection:
            downgraded_columns = _schedule_progress_columns(connection)
            downgraded_constraint = _schedule_progress_constraint(connection)
        assert downgraded_columns == repaired_columns
        assert downgraded_constraint == repaired_constraint
    finally:
        run_alembic(environment, "upgrade", "head")
        owner_engine.dispose()


def _schedule_progress_columns(connection):
    return connection.execute(
        text(
            "SELECT column_name, is_nullable, column_default "
            "FROM information_schema.columns "
            "WHERE table_schema = 'public' "
            "AND table_name = 'published_automation_events' "
            "AND column_name IN ("
            "'schedule_upper_record_id', 'schedule_cursor_record_id', "
            "'schedule_matched_count', 'schedule_action_count') "
            "ORDER BY column_name"
        )
    ).all()


def _schedule_progress_constraint(connection):
    return connection.execute(
        text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'ck_published_automation_events_schedule_progress' "
            "AND conrelid = 'public.published_automation_events'::regclass"
        )
    ).scalar_one()
