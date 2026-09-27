from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from pydantic import SecretStr

import app.systems.sandbox.publications.tokens as tokens
from app.systems.sandbox.publications.tokens import decode_preview_token, issue_preview_token


def test_preview_token_is_actor_session_and_expiry_bound(monkeypatch) -> None:
    settings = SimpleNamespace(
        publication_signing_key=SecretStr("publication-only-key-" * 3),
        public_origin="https://workspace.example.test",
    )
    monkeypatch.setattr(tokens, "get_settings", lambda: settings)
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
    settings.publication_signing_key = SecretStr("different-publication-key-" * 3)
    assert decode_preview_token(token, now=now) is None
