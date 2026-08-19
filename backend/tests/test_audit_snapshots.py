from datetime import UTC, datetime
from enum import StrEnum
from uuid import uuid7

from app.systems.audit.models import AuditLog
from app.systems.audit.snapshots import (
    REDACTED,
    build_update_snapshot,
    serialize_record,
    serialize_value,
)
from app.systems.users.models import User


class ExampleRole(StrEnum):
    MEMBER = "member"


def test_serialize_value_handles_common_database_values() -> None:
    timestamp = datetime.now(UTC)
    identifier = uuid7()

    assert serialize_value(identifier) == str(identifier)
    assert serialize_value(timestamp) == timestamp.isoformat()
    assert serialize_value(ExampleRole.MEMBER) == "member"
    assert serialize_value([identifier]) == [str(identifier)]
    assert serialize_value(b"secret") == REDACTED


def test_serialize_record_omits_metadata_and_redacts_passwords() -> None:
    user = User(
        username="alice",
        password_hash="password-hash",
        role="member",
        is_active=True,
        preferences={"theme": "dark"},
    )

    snapshot = serialize_record(user)

    assert snapshot == {
        "username": "alice",
        "password_hash": REDACTED,
        "role": "member",
        "is_active": True,
        "preferences": {"theme": "dark"},
    }
    assert "id" not in snapshot
    assert "created_at" not in snapshot
    assert "is_deleted" not in snapshot


def test_update_snapshot_contains_only_changed_nested_values() -> None:
    snapshot = build_update_snapshot(
        {
            "role": ("member", "admin"),
            "preferences": (
                {"theme": "light", "timezone": "UTC"},
                {"theme": "dark", "timezone": "UTC", "density": "compact"},
            ),
            "is_active": (True, True),
        }
    )

    assert snapshot == {
        "before": {
            "role": "member",
            "preferences": {"theme": "light"},
        },
        "after": {
            "role": "admin",
            "preferences": {"theme": "dark", "density": "compact"},
        },
    }


def test_update_snapshot_redacts_sensitive_changes() -> None:
    snapshot = build_update_snapshot({"password_hash": ("old", "new")})

    assert snapshot == {
        "before": {"password_hash": REDACTED},
        "after": {"password_hash": REDACTED},
    }


def test_audit_log_is_not_included_in_its_own_record_snapshot() -> None:
    log = AuditLog(
        action="create",
        table_name="users",
        record_id=uuid7(),
        snapshot={"after": {"username": "alice"}},
    )

    snapshot = serialize_record(log)

    assert "snapshot" in snapshot
    assert "id" not in snapshot
    assert "created_at" not in snapshot
