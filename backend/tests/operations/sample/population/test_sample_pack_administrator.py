"""The operator invites each pack organization's own administrator through Mailpit."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import httpx
import pytest

from operations.sample.packs import get_pack
from operations.sample.population import administrator as sample_administrator
from operations.sample.population.administrator import (
    administrator_identity,
    create_run_roster,
    invite_pack_administrator,
)
from operations.sample.population.run import SamplePopulationError
from tests.operations.sample.population.test_sample_people import (
    MAILPIT_URL,
    ORIGIN,
    FakeAcceptanceClient,
    FakeAdmin,
    FakeMailpit,
)

OPERATOR_ID = "0190a000-0000-7000-8000-0000000000f1"


def _invite(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, pack_key: str = "harbor"):
    roster_path = tmp_path / "private" / "credentials.json"
    inbox = FakeMailpit()
    operator = FakeAdmin(inbox, roster_path)
    monkeypatch.setattr(sample_administrator, "InvitationMailbox", lambda _url, _origin: inbox)
    acceptances: list[tuple[object, ...]] = []

    def acceptance(*args: object) -> FakeAcceptanceClient:
        acceptances.append(args)
        return FakeAcceptanceClient(operator, [])

    monkeypatch.setattr(sample_administrator, "SampleClient", acceptance)
    roster = create_run_roster(roster_path, get_pack(pack_key))

    def run() -> object:
        return invite_pack_administrator(
            operator,  # type: ignore[arg-type]
            roster,
            api_url="http://127.0.0.1:8000",
            origin=ORIGIN,
            mailpit_url=MAILPIT_URL,
            organization_id="0190a000-0000-7000-8000-0000000000aa",
            operator_id=OPERATOR_ID,
        )

    return run, operator, inbox, roster_path, acceptances


@pytest.mark.parametrize(
    ("pack_key", "email", "username"),
    (
        ("harbor", "admin@harbor.test", "harbor-administrator"),
        ("school", "admin@school.test", "school-administrator"),
    ),
)
def test_the_operator_invites_one_pack_administrator_as_a_testing_account(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pack_key: str, email: str, username: str
) -> None:
    run, operator, _inbox, roster_path, acceptances = _invite(
        tmp_path, monkeypatch, pack_key=pack_key
    )

    credential = run()

    invitations = [body for method, path, body, _ in operator.calls if path.endswith("invitations")]
    assert invitations == [
        {
            "email": email,
            "username": username,
            "display_name": f"{get_pack(pack_key).identity.workspace_name} Administrator",
            "job_title": "Organization administrator",
            "role": "admin",
        }
    ]
    assert administrator_identity(get_pack(pack_key))["email"] == email
    roster = json.loads(roster_path.read_text(encoding="utf-8"))
    account = roster["accounts"][0]
    assert stat.S_IMODE(roster_path.stat().st_mode) == 0o600
    assert (account["key"], account["state"]) == ("administrator", "active")
    assert account["role"] == "admin"
    assert credential.user_id == account["user_id"] != OPERATOR_ID  # type: ignore[attr-defined]
    assert credential.password == account["password"]  # type: ignore[attr-defined]
    assert operator.users[account["user_id"]]["status"] == "active"
    # The invitation completes in its own client; its journal sits beside the roster.
    assert len(acceptances) == 1 and acceptances[0][2] == roster_path.parent / (
        "invitation-requests.jsonl"
    )


def test_an_existing_account_is_not_accepted_as_the_pack_administrator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run, operator, _inbox, _roster_path, acceptances = _invite(tmp_path, monkeypatch)
    original = operator.request

    def in_app(method: str, path: str, **kwargs: object) -> httpx.Response:
        response = original(method, path, **kwargs)
        if path == "/api/auth/invitations":
            return httpx.Response(201, json={**response.json(), "delivery": "in_app"})
        return response

    operator.request = in_app  # type: ignore[method-assign]

    with pytest.raises(SamplePopulationError, match="must be a new account"):
        run()
    assert acceptances == []


def test_a_missing_invitation_email_keeps_the_roster_and_stops(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run, _operator, inbox, roster_path, acceptances = _invite(tmp_path, monkeypatch)
    inbox.add = lambda *_args, **_kwargs: None  # type: ignore[method-assign]

    def no_mail(_baseline: set[str], _recipient: str) -> str:
        raise sample_administrator.SampleInvitationError("No new matching email action")

    inbox.invitation_token = no_mail  # type: ignore[method-assign]

    with pytest.raises(SamplePopulationError, match="No matching invite email"):
        run()
    account = json.loads(roster_path.read_text(encoding="utf-8"))["accounts"][0]
    assert account["state"] == "email_not_confirmed" and acceptances == []


def test_the_administrator_must_not_collide_with_a_pack_person(tmp_path: Path) -> None:
    from dataclasses import replace

    pack = get_pack("harbor")
    first = replace(pack.actors.people[0], username="harbor-administrator")
    pack = replace(pack, actors=replace(pack.actors, people=(first, *pack.actors.people[1:])))

    with pytest.raises(SamplePopulationError, match="username collides"):
        create_run_roster(tmp_path / "credentials.json", pack)
    assert not (tmp_path / "credentials.json").exists()


def test_a_permanent_run_keeps_the_administrators_testing_password(tmp_path: Path) -> None:
    from operations.sample.population.administrator import ADMINISTRATOR_KEY, create_run_roster

    pack = get_pack("harbor")
    kept = create_run_roster(tmp_path / "kept.json", pack, "kept-testing-password")
    generated = create_run_roster(tmp_path / "generated.json", pack)

    assert kept.password(ADMINISTRATOR_KEY) == "kept-testing-password"
    assert generated.password(ADMINISTRATOR_KEY) not in {"", "kept-testing-password"}
    assert kept.accounts[ADMINISTRATOR_KEY]["email"] == "admin@harbor.test"
