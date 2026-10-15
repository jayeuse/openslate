"""Split policy bounds and membership episode storage on guarded PostgreSQL."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from tests.conftest import create_organization

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "field,value",
    [
        ("session_absolute_lifetime_minutes", 0),
        ("session_absolute_lifetime_minutes", 43201),
        ("session_concurrent_limit", 0),
        ("session_concurrent_limit", 101),
        ("mfa_grace_days", -1),
        ("mfa_grace_days", 31),
        ("login_failed_attempt_threshold", 0),
        ("login_failed_attempt_threshold", 101),
        ("login_window_minutes", 0),
        ("login_window_minutes", 1441),
        ("login_cooldown_minutes", 0),
        ("login_cooldown_minutes", 1441),
    ],
)
def test_named_checks_reject_out_of_range_storage(integration_owner_db, field, value):
    create_organization(integration_owner_db)
    table = "organizations" if field == "mfa_grace_days" else "platform_settings"
    with pytest.raises(IntegrityError) as caught, integration_owner_db.begin_nested():
        integration_owner_db.connection().execute(
            text(f"UPDATE {table} SET {field}=:value"), {"value": value}
        )
    prefix = "workspace_profiles" if field == "mfa_grace_days" else "platform_settings"
    assert caught.value.orig.diag.constraint_name == f"ck_{prefix}_{field}_range"


def test_episode_column_is_nullable_timestamp_without_default_or_index(integration_owner_db):
    connection = integration_owner_db.connection()
    assert connection.execute(
        text(
            "SELECT data_type,is_nullable,column_default FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='memberships' "
            "AND column_name='mfa_required_since'"
        )
    ).one() == ("timestamp with time zone", "YES", None)
    assert not connection.scalar(
        text(
            "SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' "
            "AND tablename='memberships' "
            "AND indexdef LIKE '%(mfa_required_since)%')"
        )
    )
