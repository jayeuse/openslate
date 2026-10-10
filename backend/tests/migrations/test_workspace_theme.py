"""Organization look upgrades preserve the guarded singleton and its settings."""

import pytest
from sqlalchemy import text

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
PREVIOUS_HEAD = "a16df813658f"
REVISION = "32182dce4bf8"


def test_workspace_theme_upgrade_backfills_without_rewriting_existing_settings():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    original = None
    try:
        run_alembic(environment, "downgrade", PREVIOUS_HEAD)
        with engine.begin() as connection:
            original = (
                connection.execute(
                    text(
                        "SELECT display_name,currency,mark,contact_email,timezone,revision "
                        "FROM workspace_profiles"
                    )
                )
                .one()
                ._mapping
            )
            original = dict(original)
            connection.execute(
                text(
                    "UPDATE workspace_profiles SET display_name='Legacy workspace', "
                    "currency='USD',mark='OLD',contact_email='legacy@example.test', "
                    "timezone='Asia/Manila',revision=19"
                )
            )
            before = connection.scalar(text("SELECT to_jsonb(p) FROM workspace_profiles p"))
        run_alembic(environment, "upgrade", REVISION)
        with engine.connect() as connection:
            after = connection.scalar(text("SELECT to_jsonb(p) FROM workspace_profiles p"))
            assert after == {**before, "theme": "slate"}
            column = connection.execute(
                text(
                    "SELECT data_type,character_maximum_length,is_nullable,column_default "
                    "FROM information_schema.columns WHERE table_schema='public' "
                    "AND table_name='workspace_profiles' AND column_name='theme'"
                )
            ).one()
            assert column[:3] == ("character varying", 16, "NO")
            assert column.column_default.startswith("'slate'")
        run_alembic(environment, "downgrade", PREVIOUS_HEAD)
        with engine.connect() as connection:
            reverted = connection.scalar(text("SELECT to_jsonb(p) FROM workspace_profiles p"))
            assert reverted == before
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
            if original is not None:
                with engine.begin() as connection:
                    connection.execute(
                        text(
                            "UPDATE workspace_profiles SET display_name=:display_name, "
                            "currency=:currency,mark=:mark,contact_email=:contact_email, "
                            "timezone=:timezone,revision=:revision"
                        ),
                        original,
                    )
            run_alembic(environment, "check")
        finally:
            engine.dispose()
