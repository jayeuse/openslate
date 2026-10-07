"""Compatible policy migration and fail-closed downgrade on guarded PostgreSQL."""

import subprocess
import sys
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
PREVIOUS = "f750b931b1e5"
REVISION = "37e161cacb06"
FIELDS = (
    "session_absolute_lifetime_minutes",
    "session_concurrent_limit",
    "mfa_require_admin",
    "mfa_require_member",
    "mfa_require_guest",
    "mfa_grace_days",
    "login_failed_attempt_threshold",
    "login_window_minutes",
    "login_cooldown_minutes",
)


def _rows(connection, table, clause="true", parameters=None):
    return (
        connection.execute(
            text(f"SELECT to_jsonb(t) FROM {table} t WHERE {clause}"), parameters or {}
        )
        .scalars()
        .all()
    )


@pytest.mark.parametrize("legacy", ["optional", "admins", "everyone"])
def test_upgrade_maps_roles_and_established_episodes_without_eviction(legacy):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identities = [uuid7() for _ in range(7)]
    session_id, fingerprint = uuid7(), uuid7().hex * 2
    timestamp = datetime.now(UTC)
    try:
        run_alembic(environment, "downgrade", PREVIOUS)
        with engine.begin() as connection:
            original = _rows(connection, "workspace_profiles")[0]
            connection.execute(
                text("UPDATE workspace_profiles SET mfa_policy=:mode"), {"mode": legacy}
            )
            states = [
                ("admin", "active", None, None, False),
                ("admin", "disabled", None, None, False),
                ("member", "active", timestamp, timestamp, False),
                ("admin", "disabled", timestamp, None, False),
                ("admin", "pending", timestamp, timestamp, False),
                ("admin", "active", None, None, True),
                ("guest", "active", timestamp, timestamp, False),
            ]
            for identity, (role, status, sent, accepted, archived) in zip(
                identities, states, strict=True
            ):
                connection.execute(
                    text(
                        "INSERT INTO users(id,email,username,role,status,invitation_sent_at,"
                        "invitation_accepted_at,is_deleted,sponsor_user_id,expires_at) "
                        "VALUES(:id,:email,:username,:role,:status,:sent,:accepted,:archived,:sponsor,:expiry)"
                    ),
                    {
                        "id": identity,
                        "email": f"migration-{identity}@example.test",
                        "username": str(identity),
                        "role": role,
                        "status": status,
                        "sent": sent,
                        "accepted": accepted,
                        "archived": archived,
                        "sponsor": identities[0] if role == "guest" else None,
                        "expiry": timestamp + timedelta(days=1) if role == "guest" else None,
                    },
                )
            connection.execute(
                text(
                    "INSERT INTO identity_sessions(id,user_id,refresh_token_digest,"
                    "csrf_token_digest,"
                    "created_at,refreshed_at,expires_at,provider_access_token_encrypted) "
                    "VALUES(:id,:user,:digest,:digest,:created,:created,:expiry,'owned-opaque-test-data')"
                ),
                {
                    "id": session_id,
                    "user": identities[0],
                    "digest": fingerprint,
                    "created": timestamp,
                    "expiry": timestamp + timedelta(hours=1),
                },
            )
            connection.execute(
                text(
                    "INSERT INTO identity_rate_limit_buckets(fingerprint,attempt_count,"
                    "window_started_at,blocked_until) "
                    "VALUES(:key,3,:now,:deadline)"
                ),
                {
                    "key": fingerprint,
                    "now": timestamp,
                    "deadline": timestamp + timedelta(minutes=4),
                },
            )
            before_users = {
                row["id"]: row
                for row in _rows(connection, "users", "id=ANY(:ids)", {"ids": identities})
            }
            before_profile = _rows(connection, "workspace_profiles")[0]
            before_session = _rows(connection, "identity_sessions", "id=:id", {"id": session_id})
            before_budget = _rows(
                connection, "identity_rate_limit_buckets", "fingerprint=:key", {"key": fingerprint}
            )
        run_alembic(environment, "upgrade", REVISION)
        with engine.connect() as connection:
            policy = _rows(connection, "workspace_profiles")[0]
            # JSON provides an observable missing-value red without a missing-column error.
            assert policy.get("mfa_require_admin") is (legacy != "optional")
            assert policy.get("mfa_require_member") is (legacy == "everyone")
            assert policy.get("mfa_require_guest") is (legacy == "everyone")
            assert "mfa_policy" not in policy
            assert {key: policy[key] for key in FIELDS if not key.startswith("mfa_require_")} == {
                "session_absolute_lifetime_minutes": None,
                "session_concurrent_limit": None,
                "mfa_grace_days": 0,
                "login_failed_attempt_threshold": 5,
                "login_window_minutes": 15,
                "login_cooldown_minutes": 15,
            }
            assert {key: value for key, value in policy.items() if key not in FIELDS} == {
                key: value for key, value in before_profile.items() if key != "mfa_policy"
            }
            users = _rows(connection, "users", "id=ANY(:ids)", {"ids": identities})
            seeded = []
            for index, identity in enumerate(identities):
                row = next(row for row in users if row["id"] == str(identity))
                expected = (
                    legacy != "optional"
                    and index not in (3, 4)
                    and (legacy == "everyone" or states[index][0] == "admin")
                )
                assert (row.get("mfa_required_since") is not None) == expected
                if expected:
                    seeded.append(row["mfa_required_since"])
                assert {
                    key: value for key, value in row.items() if key != "mfa_required_since"
                } == before_users[str(identity)]
            assert len(set(seeded)) <= 1
            assert (
                _rows(connection, "identity_sessions", "id=:id", {"id": session_id})
                == before_session
            )
            assert (
                _rows(
                    connection,
                    "identity_rate_limit_buckets",
                    "fingerprint=:key",
                    {"key": fingerprint},
                )
                == before_budget
            )
    finally:
        try:
            with engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM identity_sessions WHERE id=:id"), {"id": session_id}
                )
                connection.execute(
                    text("DELETE FROM identity_rate_limit_buckets WHERE fingerprint=:key"),
                    {"key": fingerprint},
                )
                connection.execute(
                    text("DELETE FROM users WHERE id=ANY(:ids)"), {"ids": identities}
                )
                if "mfa_require_admin" in _rows(connection, "workspace_profiles")[0]:
                    connection.execute(
                        text(
                            "UPDATE workspace_profiles SET mfa_require_admin=false,"
                            "mfa_require_member=false,mfa_require_guest=false"
                        )
                    )
            run_alembic(environment, "downgrade", PREVIOUS)
            with engine.begin() as connection:
                connection.execute(
                    text("UPDATE workspace_profiles SET mfa_policy=:mode"),
                    {"mode": original["mfa_policy"]},
                )
        finally:
            try:
                run_alembic(environment, "upgrade", "head")
                subprocess.run(
                    [sys.executable, "-m", "alembic", "check"], env=environment, check=True
                )
            finally:
                engine.dispose()


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
    with pytest.raises(IntegrityError) as caught, integration_owner_db.begin_nested():
        integration_owner_db.connection().execute(
            text(f"UPDATE workspace_profiles SET {field}=:value"), {"value": value}
        )
    assert caught.value.orig.diag.constraint_name == f"ck_workspace_profiles_{field}_range"


@pytest.mark.parametrize(
    "field,value",
    [
        ("mfa_require_member", True),
        ("mfa_require_guest", True),
        ("session_absolute_lifetime_minutes", 1),
        ("session_concurrent_limit", 1),
        ("mfa_grace_days", 1),
        ("login_failed_attempt_threshold", 4),
        ("login_window_minutes", 16),
        ("login_cooldown_minutes", 16),
    ],
)
def test_downgrade_refuses_unrepresentable_enforcement_before_changes(field, value):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        with engine.begin() as connection:
            before = _rows(connection, "workspace_profiles")[0]
            connection.execute(
                text(f"UPDATE workspace_profiles SET {field}=:value"), {"value": value}
            )
            configured = _rows(connection, "workspace_profiles")[0]
            revision = connection.scalar(text("SELECT version_num FROM alembic_version"))
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", PREVIOUS)
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT version_num FROM alembic_version")) == revision
            assert _rows(connection, "workspace_profiles")[0] == configured
    finally:
        with engine.begin() as connection:
            connection.execute(
                text(f"UPDATE workspace_profiles SET {field}=:value"), {"value": before[field]}
            )
        engine.dispose()


def test_episode_column_is_nullable_timestamp_without_default_or_index(integration_owner_db):
    connection = integration_owner_db.connection()
    assert connection.execute(
        text(
            "SELECT data_type,is_nullable,column_default FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='users' "
            "AND column_name='mfa_required_since'"
        )
    ).one() == ("timestamp with time zone", "YES", None)
    assert not connection.scalar(
        text(
            "SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' "
            "AND tablename='users' "
            "AND indexdef LIKE '%(mfa_required_since)%')"
        )
    )
