"""Recovery actions require new owned-origin mail for exactly the pack person."""

import httpx
import pytest

from operations import sample_invitations
from operations.sample_invitations import InvitationMailbox, SampleInvitationError

ORIGIN = "http://127.0.0.1:3000"
RECIPIENT = "person@example.test"
TOKEN = "a" * 56


def _mailbox(monkeypatch, summaries, details) -> InvitationMailbox:
    real_client = httpx.Client

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/messages":
            return httpx.Response(200, json={"messages": summaries, "total": len(summaries)})
        return httpx.Response(200, json={"HTML": details[request.url.path.rsplit("/", 1)[-1]]})

    monkeypatch.setattr(
        sample_invitations.httpx,
        "Client",
        lambda **kwargs: real_client(
            **kwargs,
            transport=httpx.MockTransport(handler),
        ),
    )
    return InvitationMailbox("http://127.0.0.1:8025", ORIGIN)


def _link(token=TOKEN, *, origin=ORIGIN, path="/auth/recovery", kind="recovery") -> str:
    return f'<a href="{origin}{path}#token_hash={token}&amp;type={kind}">Continue</a>'


def test_recovery_uses_only_new_recipient_matching_recovery_actions(monkeypatch) -> None:
    rows = [
        {"ID": key, "To": [{"Address": recipient}]}
        for key, recipient in [
            ("old", RECIPIENT),
            ("other", "other@example.test"),
            ("invite", RECIPIENT),
            ("foreign", RECIPIENT),
            ("new", RECIPIENT),
        ]
    ]
    details = {
        "old": _link("b" * 56),
        "other": _link("c" * 56),
        "invite": _link(path="/auth/setup", kind="invite"),
        "foreign": _link(origin="http://localhost:3000"),
        "new": _link(),
    }
    with _mailbox(monkeypatch, rows, details) as mailbox:
        assert mailbox.recovery_token({"old"}, RECIPIENT) == TOKEN


@pytest.mark.parametrize("invalid", ["origin", "path", "type", "query", "duplicate", "short"])
def test_untrusted_recovery_actions_timeout_without_exposing_the_link(
    monkeypatch,
    invalid,
) -> None:
    links = {
        "origin": _link(origin="https://attacker.example.test"),
        "path": _link(path="/auth/setup"),
        "type": _link(kind="invite"),
        "query": _link(path="/auth/recovery?extra=1"),
        "duplicate": _link().replace("type=recovery", "type=recovery&amp;type=recovery"),
        "short": _link("a" * 55),
    }
    monkeypatch.setattr(sample_invitations, "_WAIT_SECONDS", 0)
    rows = [{"ID": "new", "To": [{"Address": RECIPIENT}]}]
    with _mailbox(monkeypatch, rows, {"new": links[invalid]}) as mailbox:
        with pytest.raises(SampleInvitationError, match="timeout") as error:
            mailbox.recovery_token(set(), RECIPIENT)
    assert TOKEN not in str(error.value) and RECIPIENT not in str(error.value)


def test_multiple_new_recovery_links_fail_without_choosing_or_replaying_one(monkeypatch) -> None:
    rows = [{"ID": key, "To": [{"Address": RECIPIENT}]} for key in ["first", "second"]]
    with _mailbox(monkeypatch, rows, {"first": _link(), "second": _link("b" * 56)}) as mailbox:
        with pytest.raises(SampleInvitationError, match="Multiple"):
            mailbox.recovery_token(set(), RECIPIENT)
