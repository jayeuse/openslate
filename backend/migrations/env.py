from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import get_migration_settings
from app.core.config.instance import (
    assert_database_url,
    assert_instance_target,
    instance_target_for_process,
    migration_advisory_lock,
)
from app.core.database import Base, model_registry  # noqa: F401
from app.core.database.migration_scope import application_migration_scope

config = context.config
settings = get_migration_settings()
config.set_main_option("sqlalchemy.url", settings.migration_database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    target = instance_target_for_process(settings.migration_database_url, "openslate_owner")
    if target is not None:
        assert_database_url(
            settings.migration_database_url,
            target,
            expected_user="openslate_owner",
        )
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        if target is not None:
            assert_instance_target(connection, target, expected_user="openslate_owner")
            connection.rollback()
        include_name = application_migration_scope(connection, target_metadata)
        connection.rollback()
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            include_name=include_name,
        )
        with context.begin_transaction():
            with migration_advisory_lock(connection):
                context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
