"""Recovery actions require new owned-origin mail for exactly the pack person."""

import httpx
import pytest

from operations.sample.population import invitations as sample_invitations
from operations.sample.population.invitations import InvitationMailbox, SampleInvitationError

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


def test_a_full_inbox_that_changes_while_it_is_read_is_read_again(monkeypatch) -> None:
    # Mailpit keeps at most 500 messages: new mail and pruning change the total
    # between pages of one read. The reader reads again instead of stopping. One page holds
    # 500 messages, so this inbox needs two.
    real_client = httpx.Client
    old = [{"ID": f"old-{index}", "To": [{"Address": "other@example.test"}]} for index in range(560)]
    new = {"ID": "new", "To": [{"Address": RECIPIENT}]}
    state = {"listings": 0, "arrived": False, "changed_at": 2}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path != "/api/v1/messages":
            return httpx.Response(200, json={"HTML": _link()})
        state["listings"] += 1
        rows = [new, *old] if state["arrived"] else old
        start = int(request.url.params["start"])
        limit = int(request.url.params["limit"])
        total = len(rows) + (1 if state["listings"] == state["changed_at"] else 0)
        return httpx.Response(200, json={"messages": rows[start : start + limit], "total": total})

    monkeypatch.setattr(
        sample_invitations.httpx,
        "Client",
        lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(sample_invitations.time, "sleep", lambda _seconds: None)
    with InvitationMailbox("http://127.0.0.1:8025", ORIGIN) as mailbox:
        baseline = mailbox.snapshot()
        assert baseline == {row["ID"] for row in old}
        assert state["listings"] == 4
        state["arrived"] = True
        state["changed_at"] = 6
        assert mailbox.recovery_token(baseline, RECIPIENT) == TOKEN
        assert state["listings"] == 8


def test_an_inbox_that_never_settles_stops_at_the_deadline(monkeypatch) -> None:
    real_client = httpx.Client
    old = [{"ID": f"old-{index}", "To": [{"Address": "other@example.test"}]} for index in range(60)]
    listings = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        listings["count"] += 1
        start = int(request.url.params["start"])
        return httpx.Response(
            200, json={"messages": old[start : start + 50], "total": 60 + listings["count"]}
        )

    monkeypatch.setattr(
        sample_invitations.httpx,
        "Client",
        lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handler)),
    )
    monkeypatch.setattr(sample_invitations, "_WAIT_SECONDS", 0)
    with InvitationMailbox("http://127.0.0.1:8025", ORIGIN) as mailbox:
        with pytest.raises(SampleInvitationError, match="changed during message pagination"):
            mailbox.snapshot()
        with pytest.raises(SampleInvitationError, match="changed during message pagination"):
            mailbox.recovery_token(set(), RECIPIENT)
