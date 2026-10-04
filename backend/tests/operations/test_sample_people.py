"""API contract coverage for UI-equivalent sample identities and access groups."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest

from operations.sample.population import invitations as sample_invitations
from operations.sample.population import people as sample_people
from operations.sample.population.people import SamplePeopleError, populate_people

ORIGIN = "http://127.0.0.1:3000"
MAILPIT_URL = "http://127.0.0.1:8025"
TOKEN = "a" * 56
DEPARTMENTS = {
    key: str(uuid5(NAMESPACE_URL, f"department:{key}"))
    for key in ("sales", "service", "field", "inventory", "purchasing", "finance")
}
MODULES = {
    key: str(uuid5(NAMESPACE_URL, f"module:{key}"))
    for key in ("inspections", "products", "purchase_orders", "invoices")
}


class FakeMailpit:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []
        self.details: dict[str, dict[str, object]] = {}
        self.read_ids: list[str] = []

    def add(self, recipient: str, token: str, *, message_id: str) -> None:
        href = f"{ORIGIN}/auth/setup#token_hash={token}&amp;type=invite"
        self.messages.insert(
            0,
            {"ID": message_id, "To": [{"Address": recipient}]},
        )
        self.details[message_id] = {"HTML": f'<a href="{href}">Accept</a>'}

    def get(self, path: str, *, params: dict[str, int] | None = None) -> httpx.Response:
        if path == "/api/v1/messages":
            start = 0 if params is None else params.get("start", 0)
            limit = 50 if params is None else params.get("limit", 50)
            return httpx.Response(
                200,
                json={
                    "messages": self.messages[start : start + limit],
                    "total": len(self.messages),
                },
                request=httpx.Request("GET", f"http://mailpit{path}"),
            )
        message_id = path.removeprefix("/api/v1/message/")
        self.read_ids.append(message_id)
        return httpx.Response(
            200,
            json=self.details[message_id],
            request=httpx.Request("GET", f"http://mailpit{path}"),
        )

    def snapshot(self) -> set[str]:
        return {str(message["ID"]) for message in self.messages}

    def invitation_token(self, baseline_ids: set[str], recipient: str) -> str:
        for message in self.messages:
            message_id = str(message["ID"])
            if message_id in baseline_ids:
                continue
            if not any(
                item.get("Address", "").casefold() == recipient.casefold() for item in message["To"]
            ):
                continue
            self.read_ids.append(message_id)
            return str(TOKEN if self.details[message_id]["HTML"].find(TOKEN) >= 0 else "d" * 56)
        raise SamplePeopleError("No matching new message")

    def close(self) -> None:
        return None

    def __enter__(self) -> FakeMailpit:
        return self

    def __exit__(self, *_args: object) -> None:
        return None


class FakeAdmin:
    def __init__(self, mailpit: FakeMailpit, roster_path: Path) -> None:
        self.mailpit = mailpit
        self.roster_path = roster_path
        self.calls: list[tuple[str, str, dict[str, object], dict[str, str]]] = []
        self.groups: dict[str, dict[str, object]] = {}
        self.users: dict[str, dict[str, object]] = {}
        self.mapping_calls: list[tuple[str, str, str]] = []

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
        **_kwargs: object,
    ) -> httpx.Response:
        body = {} if json_body is None else json_body
        request_headers = {} if headers is None else headers
        self.calls.append((method, path, body, request_headers))
        if method == "POST" and path == "/api/access/groups":
            group_id = str(uuid5(NAMESPACE_URL, f"group:{body['name']}"))
            self.groups[group_id] = {
                "id": group_id,
                "revision": 1,
                "member_ids": [],
                "access": [],
            }
            return httpx.Response(201, json={"id": group_id})
        if path.startswith("/api/access/groups/"):
            group_id = path.split("/")[4]
            group = self.groups[group_id]
            if method == "GET":
                return httpx.Response(
                    200,
                    json=group,
                    headers={"ETag": f'"{group_id}:{group["revision"]}"'},
                )
            if method == "PUT" and path.endswith("/access"):
                assert request_headers.get("If-Match") == f'"{group_id}:{group["revision"]}"'
                group["access"] = body["access"]
                group["revision"] = int(group["revision"]) + 1
                return httpx.Response(200, json=group)
        if method == "POST" and path == "/api/auth/invitations":
            user_id = str(uuid5(NAMESPACE_URL, f"user:{body['email']}"))
            user = {"id": user_id, **body, "status": "pending"}
            self.users[user_id] = user
            for group_id in body.get("group_ids", []):
                self.groups[str(group_id)]["member_ids"].append(user_id)
            if body["role"] == "guest":
                assert body["sponsor_user_id"] in self.users
                assert body["expires_at"]
            self.mailpit.add(str(body["email"]), TOKEN, message_id=user_id)
            return httpx.Response(201, json={"user": user, "delivery": "email"})
        if method == "PATCH" and path.startswith("/api/users/"):
            user_id = path.rsplit("/", maxsplit=1)[1]
            self.users[user_id]["status"] = body["status"]
            return httpx.Response(200, json=self.users[user_id])
        if method == "GET" and path.startswith("/api/users/"):
            user_id = path.rsplit("/", maxsplit=1)[1]
            return httpx.Response(200, json=self.users[user_id])
        raise AssertionError(f"Unexpected API call: {method} {path}")

    def record_mapping(self, kind: str, logical_id: str, server_id: str) -> None:
        self.mapping_calls.append((kind, logical_id, server_id))

    def complete(self, password: str) -> httpx.Response:
        roster = json.loads(self.roster_path.read_text(encoding="utf-8"))
        assert stat.S_IMODE(self.roster_path.stat().st_mode) == 0o600
        account = next(row for row in roster["accounts"] if row.get("password") == password)
        assert account["state"] == "invited"
        user_id = str(uuid5(NAMESPACE_URL, f"user:{account['email']}"))
        assert self.users[user_id]["status"] == "pending"
        self.users[user_id]["status"] = "active"
        return httpx.Response(204)


class FakeAcceptanceClient:
    def __init__(self, admin: FakeAdmin, fsync_events: list[str]) -> None:
        self.admin = admin
        self.fsync_events = fsync_events
        self.fsyncs_before_completion: list[int] = []

    def complete_invitation(self, _token_hash: str, password: str) -> httpx.Response:
        self.fsyncs_before_completion.append(len(self.fsync_events))
        return self.admin.complete(password)

    def close(self) -> None:
        return None


def test_invitation_token_uses_only_new_recipient_mail_with_exact_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inbox = FakeMailpit()
    inbox.add("lead@harbor.example.test", "b" * 56, message_id="old")
    inbox.add("another@harbor.example.test", "c" * 56, message_id="wrong-recipient")
    inbox.add("lead@harbor.example.test", "d" * 56, message_id="wrong-origin")
    wrong_origin_link = f"http://localhost:3000/auth/setup#token_hash={'d' * 56}&amp;type=invite"
    inbox.details["wrong-origin"]["HTML"] = f'<a href="{wrong_origin_link}">Accept</a>'
    inbox.add("lead@harbor.example.test", TOKEN, message_id="new")

    monkeypatch.setattr(sample_invitations.httpx, "Client", lambda **_kwargs: inbox)
    mailbox = sample_invitations.InvitationMailbox(MAILPIT_URL, ORIGIN)
    found = mailbox.invitation_token({"old"}, "lead@harbor.example.test")
    mailbox.close()

    assert found == TOKEN
    assert "old" not in inbox.read_ids
    assert "wrong-recipient" not in inbox.read_ids
    assert "wrong-origin" in inbox.read_ids
    assert "new" in inbox.read_ids


def test_population_creates_ui_groups_and_identity_states_with_private_roster(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    roster_path = tmp_path / "private" / "credentials.json"
    inbox = FakeMailpit()
    stale_recipient = "lead@harbor.example.test"
    inbox.add(stale_recipient, "e" * 56, message_id="before-run")
    monkeypatch.setattr(sample_people, "InvitationMailbox", lambda _url, _origin: inbox)
    real_fsync = os.fsync
    fsync_events: list[str] = []

    def track_fsync(fd: int) -> None:
        real_fsync(fd)
        fsync_events.append("fsync")

    monkeypatch.setattr(sample_invitations.os, "fsync", track_fsync)
    admin = FakeAdmin(inbox, roster_path)
    acceptance_clients: list[FakeAcceptanceClient] = []

    def acceptance_client(*_args: object) -> FakeAcceptanceClient:
        client = FakeAcceptanceClient(admin, fsync_events)
        acceptance_clients.append(client)
        return client

    monkeypatch.setattr(sample_people, "_new_acceptance_client", acceptance_client)

    result = populate_people(
        admin, "http://127.0.0.1:8000", DEPARTMENTS, MODULES, MAILPIT_URL, ORIGIN, roster_path
    )

    assert len(result.users) == 44
    # Every active internal member can act; guests, pending and disabled accounts cannot.
    assert len(result.actors) == 30
    assert len(result.groups) == 9
    assert {person.status for person in result.users.values()} == {
        "active",
        "pending",
        "disabled",
    }
    assert sum(person.status == "active" for person in result.users.values()) == 36
    assert sum(person.status == "pending" for person in result.users.values()) == 5
    assert sum(person.status == "disabled" for person in result.users.values()) == 3
    assert set(result.actors) == {
        key
        for key, person in result.users.items()
        if person.status == "active" and person.role == "member"
    }
    assert "before-run" not in inbox.read_ids
    assert stat.S_IMODE(roster_path.stat().st_mode) == 0o600
    roster = json.loads(roster_path.read_text(encoding="utf-8"))
    assert sum("password" in account for account in roster["accounts"]) == 39
    assert sum(account["status"] == "pending" for account in roster["accounts"]) == 5
    assert all(
        "password" not in account
        for account in roster["accounts"]
        if account["status"] == "pending"
    )
    assert len(acceptance_clients) == 39
    assert all(client.fsyncs_before_completion for client in acceptance_clients)
    assert all(client.fsyncs_before_completion[0] > 0 for client in acceptance_clients)
    assert len(admin.mapping_calls) == 9 + 44  # groups plus people
    assert {kind for kind, _, _ in admin.mapping_calls} == {"group", "user"}
    group_access_writes = [
        (body, headers)
        for method, path, body, headers in admin.calls
        if method == "PUT" and path.endswith("/access")
    ]
    assert len(group_access_writes) == 9
    assert all(headers.get("If-Match") for _, headers in group_access_writes)
    group_keys = {group_id: key for key, group_id in result.groups.items()}
    scoped_access = {
        group_keys[path.split("/")[4]]: {
            (entry["department_id"], entry["module_id"]): entry["level"] for entry in body["access"]
        }
        for method, path, body, _ in admin.calls
        if method == "PUT" and path.endswith("/access")
    }
    # The department leads manage every department's shared views and reports.
    assert scoped_access["harbor-operations"] == {
        (department_id, None): "manage" for department_id in DEPARTMENTS.values()
    }
    assert scoped_access["inventory-control"] == {
        (DEPARTMENTS["inventory"], None): "write",
        (DEPARTMENTS["inventory"], MODULES["products"]): "manage",
    }
    assert scoped_access["purchasing-review"] == {(DEPARTMENTS["purchasing"], None): "write"}
    assert scoped_access["internal-audit"] == {
        (DEPARTMENTS["finance"], None): "read",
        (DEPARTMENTS["purchasing"], None): "read",
    }
    assert scoped_access["guest-readers"] == {
        (department_id, None): "manage" for department_id in DEPARTMENTS.values()
    }
    assert (
        result.actors["internal_sales_lead"].user_id
        in admin.groups[result.groups["harbor-operations"]]["member_ids"]
    )
    assert (
        result.actors["internal_sales_lead"].user_id
        in admin.groups[result.groups["sales-desk"]]["member_ids"]
    )
    invitation_calls = [
        body
        for method, path, body, _ in admin.calls
        if method == "POST" and path == "/api/auth/invitations"
    ]
    assert len(invitation_calls) == 44
    assert all(
        set(body).issubset(
            {
                "email",
                "username",
                "display_name",
                "job_title",
                "role",
                "group_ids",
                "sponsor_user_id",
                "expires_at",
            }
        )
        for body in invitation_calls
    )
    assert all(body["role"] != "admin" for body in invitation_calls)
    assert all(result.actors[key].password for key in result.actors)


def test_population_refuses_to_overwrite_an_existing_private_roster(tmp_path: Path) -> None:
    roster_path = tmp_path / "private" / "credentials.json"
    roster_path.parent.mkdir(mode=0o700)
    roster_path.write_text("owned roster", encoding="utf-8")
    admin = FakeAdmin(FakeMailpit(), roster_path)

    with pytest.raises(SamplePeopleError, match="already exists"):
        populate_people(
            admin, "http://127.0.0.1:8000", DEPARTMENTS, MODULES, MAILPIT_URL, ORIGIN, roster_path
        )

    assert admin.calls == []
    assert roster_path.read_text(encoding="utf-8") == "owned roster"


def test_population_stops_when_the_group_access_etag_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inbox = FakeMailpit()
    monkeypatch.setattr(sample_people, "InvitationMailbox", lambda _url, _origin: inbox)
    admin = FakeAdmin(inbox, tmp_path / "private" / "credentials.json")
    original_request = admin.request

    def request_without_etag(method: str, path: str, **kwargs: object) -> httpx.Response:
        response = original_request(method, path, **kwargs)
        if method == "GET" and path.startswith("/api/access/groups/"):
            return httpx.Response(200, json=response.json())
        return response

    admin.request = request_without_etag  # type: ignore[method-assign]

    with pytest.raises(SamplePeopleError, match="ETag"):
        populate_people(
            admin,
            "http://127.0.0.1:8000",
            DEPARTMENTS,
            MODULES,
            MAILPIT_URL,
            ORIGIN,
            tmp_path / "private" / "credentials.json",
        )

    assert not any(path == "/api/auth/invitations" for _, path, _, _ in admin.calls)
    assert not any(
        method == "PUT" and path.endswith("/access") for method, path, _, _ in admin.calls
    )


@pytest.mark.parametrize("response_kind", ["unexpected_success", "invalid_json", "nonobject_json"])
def test_committed_group_with_unusable_success_stops_with_unknown_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, response_kind: str
) -> None:
    roster_path = tmp_path / "private" / "credentials.json"
    inbox = FakeMailpit()
    monkeypatch.setattr(sample_people, "InvitationMailbox", lambda _url, _origin: inbox)
    admin = FakeAdmin(inbox, roster_path)
    original_request = admin.request

    def changed_response(method: str, path: str, **kwargs: object) -> httpx.Response:
        response = original_request(method, path, **kwargs)
        if method == "POST" and path == "/api/access/groups":
            if response_kind == "unexpected_success":
                return httpx.Response(200, json=response.json())
            if response_kind == "invalid_json":
                return httpx.Response(201, content=b"{broken")
            return httpx.Response(201, json=[response.json()])
        return response

    admin.request = changed_response  # type: ignore[method-assign]

    with pytest.raises(SamplePeopleError):
        populate_people(
            admin, "http://127.0.0.1:8000", DEPARTMENTS, MODULES, MAILPIT_URL, ORIGIN, roster_path
        )

    roster = json.loads(roster_path.read_text(encoding="utf-8"))
    assert len(admin.groups) == 1  # The server committed despite the unusable response.
    assert roster["last_operation"] == {
        "operation": "group-create",
        "logical_key": "harbor-operations",
        "state": "outcome_unknown",
    }
    assert roster["groups"] == {}
    assert len([call for call in admin.calls if call[:2] == ("POST", "/api/access/groups")]) == 1
    assert not any(path == "/api/auth/invitations" for _, path, _, _ in admin.calls)


def test_committed_invitation_completion_with_unexpected_success_is_unknown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    roster_path = tmp_path / "private" / "credentials.json"
    inbox = FakeMailpit()
    monkeypatch.setattr(sample_people, "InvitationMailbox", lambda _url, _origin: inbox)
    admin = FakeAdmin(inbox, roster_path)

    class UnexpectedCompletion(FakeAcceptanceClient):
        def complete_invitation(self, token_hash: str, password: str) -> httpx.Response:
            super().complete_invitation(token_hash, password)
            return httpx.Response(200, json={"accepted": True})

    monkeypatch.setattr(
        sample_people,
        "_new_acceptance_client",
        lambda *_args: UnexpectedCompletion(admin, []),
    )

    with pytest.raises(SamplePeopleError):
        populate_people(
            admin, "http://127.0.0.1:8000", DEPARTMENTS, MODULES, MAILPIT_URL, ORIGIN, roster_path
        )

    roster = json.loads(roster_path.read_text(encoding="utf-8"))
    assert roster["last_operation"] == {
        "operation": "invitation-complete",
        "logical_key": "internal_sales_lead",
        "state": "outcome_unknown",
    }
    account = next(row for row in roster["accounts"] if row["key"] == "internal_sales_lead")
    assert account["state"] == "invited"
    assert len(admin.users) == 1
    assert next(iter(admin.users.values()))["status"] == "active"
    assert len([call for call in admin.calls if call[:2] == ("POST", "/api/auth/invitations")]) == 1


def test_committed_invite_with_bad_user_readback_retains_partial_roster(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    roster_path = tmp_path / "private" / "credentials.json"
    inbox = FakeMailpit()
    monkeypatch.setattr(sample_people, "InvitationMailbox", lambda _url, _origin: inbox)
    admin = FakeAdmin(inbox, roster_path)
    original_request = admin.request

    def wrong_readback(method: str, path: str, **kwargs: object) -> httpx.Response:
        response = original_request(method, path, **kwargs)
        if method == "GET" and path.startswith("/api/users/"):
            return httpx.Response(200, json={**response.json(), "email": "wrong@example.test"})
        return response

    admin.request = wrong_readback  # type: ignore[method-assign]
    monkeypatch.setattr(
        sample_people,
        "_new_acceptance_client",
        lambda *_args: FakeAcceptanceClient(admin, []),
    )

    with pytest.raises(SamplePeopleError, match="User readback"):
        populate_people(
            admin, "http://127.0.0.1:8000", DEPARTMENTS, MODULES, MAILPIT_URL, ORIGIN, roster_path
        )

    roster = json.loads(roster_path.read_text(encoding="utf-8"))
    assert roster["last_operation"] == {
        "operation": "user-readback",
        "logical_key": "internal_sales_lead",
        "state": "failed",
    }
    account = next(row for row in roster["accounts"] if row["key"] == "internal_sales_lead")
    assert account["state"] == "active"
    assert account["user_id"] in admin.users
    assert len([call for call in admin.calls if call[:2] == ("POST", "/api/auth/invitations")]) == 1
