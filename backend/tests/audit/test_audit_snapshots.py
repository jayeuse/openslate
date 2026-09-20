from datetime import UTC, datetime
from enum import StrEnum
from secrets import token_urlsafe

from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import (
    REDACTED,
    build_update_snapshot,
    serialize_record,
    serialize_value,
)

BINARY_CANARY = token_urlsafe(32)
OLD_FIELD_CANARY = token_urlsafe(32)
NEW_FIELD_CANARY = token_urlsafe(32)
ADDED_FIELD_CANARY = token_urlsafe(32)


class ExampleRole(StrEnum):
    MEMBER = "member"


def test_serialize_value_handles_common_database_values() -> None:
    timestamp = datetime.now(UTC)
    identifier = uuid7()

    assert serialize_value(identifier) == str(identifier)
    assert serialize_value(timestamp) == timestamp.isoformat()
    assert serialize_value(ExampleRole.MEMBER) == "member"
    assert serialize_value([identifier]) == [str(identifier)]
    assert serialize_value(BINARY_CANARY.encode()) == REDACTED


def test_serialize_record_contains_only_local_profile_fields() -> None:
    user = User(
        id=uuid7(),
        email="alice@example.com",
        username="alice",
        status="active",
        role_id=uuid7(),
    )

    snapshot = serialize_record(user)

    assert snapshot == {
        "email": "alice@example.com",
        "username": "alice",
        "status": "active",
        "role_id": str(user.role_id),
    }
    assert "password_hash" not in snapshot
    assert "id" not in snapshot
    assert "created_at" not in snapshot
    assert "is_deleted" not in snapshot


def test_update_snapshot_contains_only_changed_nested_values() -> None:
    snapshot = build_update_snapshot(
        {
            "role": ("member", "admin"),
            "config": (
                {"theme": "light", "timezone": "UTC"},
                {"theme": "dark", "timezone": "UTC", "density": "compact"},
            ),
            "required": (False, True),
        }
    )

    assert snapshot == {
            "before": {
                "role": "member",
                "config": {"theme": "light"},
                "required": False,
            },
            "after": {
                "role": "admin",
                "config": {"theme": "dark", "density": "compact"},
                "required": True,
            },
    }


def test_update_snapshot_redacts_sensitive_changes() -> None:
    snapshot = build_update_snapshot({"password_hash": (BINARY_CANARY, OLD_FIELD_CANARY)})

    assert snapshot == {
        "before": {"password_hash": REDACTED},
        "after": {"password_hash": REDACTED},
    }


def test_update_snapshot_redacts_dynamic_field_keys_in_add_remove_diffs() -> None:
    redacted_field_id = str(uuid7())
    added_field_id = str(uuid7())

    snapshot = build_update_snapshot(
        {
            "data": (
                {redacted_field_id: OLD_FIELD_CANARY, "clear-field": "old"},
                {
                    "clear-field": "new",
                    redacted_field_id: NEW_FIELD_CANARY,
                    added_field_id: ADDED_FIELD_CANARY,
                },
            )
        },
        {redacted_field_id, added_field_id},
    )

    assert snapshot == {
        "before": {
            "data": {
                redacted_field_id: REDACTED,
                "clear-field": "old",
            }
        },
        "after": {
            "data": {
                "clear-field": "new",
                redacted_field_id: REDACTED,
                added_field_id: REDACTED,
            }
        },
    }


def test_audit_log_is_not_included_in_its_own_record_snapshot() -> None:
    log = AuditLog(
        action="create",
        entity_type="users",
        entity_id=uuid7(),
        after={"username": "alice"},
    )

    snapshot = serialize_record(log)

    assert "after" in snapshot
    assert "id" not in snapshot
    assert "created_at" not in snapshot
