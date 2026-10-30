"""Shared stand-ins for file transfer capacity tests that drive the app without a database."""

from datetime import UTC, datetime
from uuid import uuid4


def uploaded_file(*_args: object, **_kwargs: object) -> dict[str, object]:
    """A valid upload result for a route whose ``service.upload`` is replaced."""
    now = datetime.now(UTC)
    return {
        "id": uuid4(), "purpose": "record_attachment", "record_id": None, "board_id": None,
        "department_id": None, "creator_id": uuid4(), "filename": "a.pdf",
        "media_type": "application/pdf", "expected_size": 1, "actual_size": 1,
        "state": "ready", "failure_code": None, "is_deleted": False,
        "created_at": now, "updated_at": now,
    }
