"""Independent invitation wire fixtures and faults for the SampleClient journey."""

from typing import Any

INVITATION_CASES = (
    [(None, None)]
    + [
        (fault, None)
        for fault in (
            "before_id",
            "before_email",
            "before_status",
            "response_id",
            "response_wrapper",
            "response_timestamp",
            "readback_unsent",
            "readback_id",
            "unknown",
            "cleanup_unknown",
            "cleanup_readback",
        )
    ]
    + [
        (None, fault)
        for fault in (
            "missing_first",
            "missing_last",
            "actor",
            "target",
            "outcome",
            "status",
            "path",
            "request_id",
            "reused_request_id",
            "before",
            "after",
            "duplicate",
            "split_target",
        )
    ]
)


def user_response(
    *,
    user_id: str,
    email: str,
    username: str,
    role: str,
    status: str,
    deleted: bool,
    actor_id: str,
) -> dict[str, Any]:
    """Full literal UserResponse; never generated from the production schema."""
    return {
        "id": user_id,
        "email": email,
        "username": username,
        "display_name": "Sample Person",
        "job_title": "External reviewer",
        "role": role,
        "status": status,
        "is_deleted": deleted,
        "invitation_sent_at": None,
        "sponsor_user_id": None,
        "expires_at": None,
        "created_at": "2026-10-01T10:00:00Z",
        "updated_at": "2026-10-02T11:44:20Z",
        "deleted_at": "2026-10-02T11:44:20Z" if deleted else None,
        "performed_by": actor_id,
    }


def corrupt_invitation(body: dict[str, Any], fault: str, wrong_id: str) -> dict[str, Any]:
    if fault == "response_wrapper":
        return {"user": body, "delivery": "email"}
    return {
        **body,
        **{
            "id": {"id": wrong_id},
            "email": {"email": "foreign@example.test"},
            "status": {"status": "active"},
            "timestamp": {"invitation_sent_at": "sent"},
            "unsent": {"invitation_sent_at": None},
        }[fault.rsplit("_", 1)[1]],
    }
