from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.systems.sandbox.publications.tokens import decode_preview_token, issue_preview_token


def test_preview_token_is_actor_session_and_expiry_bound() -> None:
    now = datetime(2026, 9, 21, tzinfo=UTC)
    token, issued = issue_preview_token(
        actor_id=uuid4(),
        session_id=uuid4(),
        document_revision=3,
        document_hash="a" * 64,
        impact_digest="b" * 64,
        live_state_digest="c" * 64,
        now=now,
    )

    decoded = decode_preview_token(token, now=now)

    assert decoded == issued
    assert decode_preview_token(token, now=now + timedelta(minutes=6)) is None
