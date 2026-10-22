"""Structure-family sample contracts; message execution has its own owner."""

import copy
import json
from contextlib import ExitStack
from dataclasses import replace
from datetime import date
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.controls.actions import plan_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    execute_phase_action,
)
from operations.sample.population.people import SampleActorCredential
from operations.sample.population.run import _login
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.comms_support import (
    ADMIN,
    CATEGORY,
    CHANNEL,
    DIRECT,
    GROUP,
    INVITATION,
    ORIGIN,
    PARTNER,
    PRIMARY,
    PRIMARY_DEPARTMENT,
    PRIMARY_GROUP,
    _planned,
    _resource,
)

C = "/api/comms/conversations/{conversation_id}"
STRUCTURE_ROUTES = {
    ("GET", "/api/comms/conversations"),
    ("POST", "/api/comms/conversations"),
    ("GET", C),
    ("PATCH", C),
    ("POST", C + "/archive"),
    ("POST", C + "/restore"),
    ("GET", "/api/comms/categories"),
    ("POST", "/api/comms/categories"),
    ("GET", "/api/comms/categories/{category_id}"),
    ("PUT", "/api/comms/categories/{category_id}"),
    ("POST", "/api/comms/directs"),
    ("POST", "/api/comms/groups"),
    ("GET", C + "/members"),
    ("PUT", C + "/members/{user_id}"),
    ("DELETE", C + "/members/{user_id}"),
    ("POST", C + "/duplicates"),
    ("GET", "/api/comms/direct-blocks"),
    ("POST", "/api/comms/direct-blocks"),
    ("DELETE", "/api/comms/direct-blocks/{user_id}"),
}


def test_structure_routes_have_coupled_api_sample_and_frontend_registration():
    from app.main import create_app
    from operations.sample.verification.route_coverage import SEEDER_ROUTES
    from tests.operations.sample.verification.test_frontend_route_coverage import _shape
    from tests.repository import REPOSITORY_ROOT

    expected = {(method, _shape(path)) for method, path in STRUCTURE_ROUTES}
    api = {
        (method.upper(), _shape(path))
        for path, methods in create_app().openapi()["paths"].items()
        for method in methods
        if method in {"get", "post", "put", "patch", "delete"}
    }
    manifest = json.loads((REPOSITORY_ROOT / "frontend/api-route-manifest.json").read_text())
    assert expected <= api
    assert expected <= {(method, _shape(path)) for method, path in SEEDER_ROUTES}
    assert expected <= {(row["method"], _shape(row["path"])) for row in manifest}


@pytest.mark.parametrize(
    ("pack_key", "foreign_reply"),
    [("harbor", False), ("school", False), ("harbor", True)],
)
def test_comms_partner_executor_admits_group_member_and_uses_bound_clients(
    tmp_path,
    pack_key,
    foreign_reply,
):
    pack = get_pack(pack_key)
    people = tuple(
        replace(person, email=f"person-{i}@example.test", username=f"person_{i}")
        for i, person in enumerate(pack.actors.people)
    )
    pack = replace(pack, actors=replace(pack.actors, people=people))
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=pack)
    action = _planned(dataset, "partner_conversations")
    assert action.actor_key == "admin" and action.values["organization"] == "partner"
    assert action.target_key.startswith("partner:")
    members = action.values["member_keys"]
    assert isinstance(members, list) and len(set(members)) == len(members) == 2
    account = next(row for row in plan_controls(dataset) if row.kind == "account_controls")
    assert members[0] == account.actor_key
    chosen = [next(person for person in people if person.key == key) for key in members]
    assert all(person.role == "member" and person.status == "active" for person in chosen)
    ids = {"admin": ADMIN, **{p.key: str(uuid5(NAMESPACE_URL, p.key)) for p in chosen}}
    emails = {"admin": "fixture-admin@example.test", **{p.key: p.email for p in chosen}}
    journal = tmp_path / "requests.jsonl"
    seen, factory_calls, member_reads, resource_reads = [], [], set(), set()
    partner_identity_reads = set()
    admitted = {members[0]}
    invited = False
    direct_calls = 0
    created = {}

    def _participants(user_ids):
        names = {user_id: key for key, user_id in ids.items()}
        return [{"user_id": user_id, "display_name": names[user_id]} for user_id in user_ids]

    def response(status, payload=None, *, tag=None, location=None):
        headers = {
            "X-Request-ID": str(uuid5(NAMESPACE_URL, f"partner-reply-{len(seen)}")),
            "Cache-Control": "private, no-store",
        }
        if tag:
            headers["ETag"] = tag
        if location:
            headers["Location"] = location
        return httpx.Response(
            status,
            headers=headers,
            **({} if status == 204 else {"json": payload}),
        )

    def handler(request):
        nonlocal invited, direct_calls
        seen.append(request)
        method, path = request.method, request.url.path
        body = json.loads(request.content) if request.content else {}
        org = request.headers["x-org"]
        if path == "/api/auth/login":
            actor = next(key for key, email in emails.items() if email == body["email"])
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers=[
                    ("Set-Cookie", f"openslate_access={actor}; Path=/; HttpOnly"),
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                ],
            )
        cookies = dict(piece.split("=", 1) for piece in request.headers["cookie"].split("; "))
        actor = cookies["openslate_access"]
        if (method, path) == ("GET", "/api/auth/me"):
            if org == PARTNER:
                partner_identity_reads.add(actor)
            return response(
                200,
                {
                    "id": ids[actor],
                    "email": emails[actor],
                    "role": "admin" if actor == "admin" else "member",
                    "status": "active",
                    "current_organization": {"org_id": org},
                    "pending_invitations": [
                        {"id": INVITATION, "org_id": PARTNER},
                    ]
                    if invited and actor == members[1] and actor not in admitted
                    else [],
                },
            )
        if (method, path) == ("POST", "/api/auth/invitations"):
            assert actor == "admin" and org == PARTNER and not invited
            assert body == {
                "email": chosen[1].email,
                "username": chosen[1].username,
                "role": "member",
            }
            invited = True
            return response(201, {"user": {"id": ids[members[1]]}, "delivery": "in_app"})
        if (method, path) == ("POST", f"/api/auth/invitations/{INVITATION}/accept"):
            assert invited and actor == members[1] and actor not in admitted
            admitted.add(actor)
            return response(204)
        if (method, path) == ("POST", "/api/auth/session/organization"):
            assert actor in admitted and body["org_id"] in {PRIMARY, PARTNER}
            return response(
                200,
                {
                    "id": ids[actor],
                    "email": emails[actor],
                    "status": "active",
                    "role": "member",
                    "current_organization": {"org_id": body["org_id"]},
                },
            )
        assert path.startswith("/api/comms/")
        assert org == PARTNER, "Session selection cannot replace a bound partner client"
        assert actor in partner_identity_reads, "Partner identity must be read before Comms use"
        assert PRIMARY_DEPARTMENT not in request.content.decode()
        assert PRIMARY_GROUP not in request.content.decode()
        assert actor == "admin" or actor in admitted
        if (method, path) == ("POST", "/api/comms/categories"):
            assert body == {
                "name": action.values["category_name"],
                "position": 0,
                "department_id": None,
            }
            created[CATEGORY] = {**_resource(CATEGORY, PARTNER), **body}
            return response(201, created[CATEGORY], tag='"category"', location=f"{path}/{CATEGORY}")
        if (method, path) == ("POST", "/api/comms/conversations"):
            assert body == {
                "name": action.values["channel_name"],
                "topic": "",
                "position": 0,
                "category_id": CATEGORY,
                "scope": "organization",
            }
            assert admitted == set(members)
            created[CHANNEL] = {
                **_resource(CHANNEL, PARTNER),
                "kind": "channel",
                "scope": "organization",
                "name": body["name"],
                "topic": "",
                "position": 0,
                "category_id": CATEGORY,
                "thread_branches": "all",
                "archived_at": None,
                "level": "manage",
                "member_role": "manager",
                "member_count": 3,
            }
            return response(201, created[CHANNEL], tag='"channel"', location=f"{path}/{CHANNEL}")
        if (method, path) == ("POST", "/api/comms/directs"):
            assert actor == "admin" and body == {"recipient_id": ids[members[0]]}
            direct_calls += 1
            assert direct_calls <= 2
            created[DIRECT] = {
                **_resource(DIRECT, PARTNER),
                "kind": "direct",
                "archived_at": None,
                "level": "manage",
                "member_role": "manager",
                "member_count": 2,
                "participant_ids": [ADMIN, ids[members[0]]],
                "participants": _participants([ADMIN, ids[members[0]]]),
            }
            return response(
                201 if direct_calls == 1 else 200,
                created[DIRECT],
                tag='"direct"',
                location=f"/api/comms/conversations/{DIRECT}" if direct_calls == 1 else None,
            )
        if (method, path) == ("POST", "/api/comms/groups"):
            assert actor == "admin" and admitted == set(members)
            assert set(body) == {"name", "participant_ids"}
            assert body["name"] == action.values["group_name"]
            assert len(body["participant_ids"]) == 3
            assert set(body["participant_ids"]) == {ADMIN, *(ids[key] for key in members)}
            created[GROUP] = {
                **_resource(GROUP, PARTNER),
                "kind": "group",
                "archived_at": None,
                "level": "manage",
                "member_role": "manager",
                "member_count": 3,
                "name": body["name"],
                "participant_ids": [ADMIN, *(ids[key] for key in members)],
                "participants": _participants([ADMIN, *(ids[key] for key in members)]),
            }
            return response(
                201,
                created[GROUP],
                tag='"group"',
                location=f"/api/comms/conversations/{GROUP}",
            )
        if method == "GET":
            identifier = path.rsplit("/", 1)[-1]
            assert path in {
                f"/api/comms/categories/{CATEGORY}",
                *(f"/api/comms/conversations/{key}" for key in (CHANNEL, DIRECT, GROUP)),
            }
            row = dict(created[identifier])
            resource_reads.add(identifier)
            if actor != "admin":
                assert identifier == CHANNEL
                member_reads.add(actor)
                row.update(level="post", member_role="member")
            if foreign_reply and identifier == CHANNEL:
                row["org_id"] = PRIMARY
            return response(200, row, tag='"read-current"')
        raise AssertionError(f"Unexpected partner request: {method} {path}")

    with ExitStack() as stack:

        def client(actor, org):
            result = stack.enter_context(
                SampleClient(
                    "http://sample.test",
                    ORIGIN,
                    journal,
                    org,
                    transport=httpx.MockTransport(handler),
                )
            )
            _login(result, emails[actor], "fixture-only", expected_id=ids[actor])
            return result

        primary_clients = {key: client(key, PRIMARY) for key in ids}

        def partner_actor(actor):
            assert actor in members and actor in admitted
            factory_calls.append(actor)
            return client(actor, PARTNER)

        original = {"comms_conversations": {"primary:preserve": CHANNEL}}
        context = PhaseExecutionContext(
            clients=primary_clients,
            user_ids=ids,
            group_ids={"primary-group": PRIMARY_GROUP},
            department_ids={"primary-department": PRIMARY_DEPARTMENT},
            module_ids={},
            field_ids={},
            mappings=copy.deepcopy(original),
            admin_password="fixture-only",
            private_values={
                "credentials": {
                    key: SampleActorCredential(ids[key], emails[key], "fixture-only")
                    for key in members
                },
                "partner_admin": lambda: client("admin", PARTNER),
                "partner_actor": partner_actor,
            },
        )
        if foreign_reply:
            with pytest.raises(SamplePhaseActionError):
                execute_phase_action(action, dataset, context)
        else:
            result = execute_phase_action(action, dataset, context)
            assert result["outcome"] == "completed" and result["organization_id"] == PARTNER
            assert result["partner_members_verified"] is True
            assert invited and admitted == set(members)
            assert set(factory_calls) == set(members) and member_reads == set(members)
            assert partner_identity_reads == {"admin", *members}
            assert direct_calls == 2 and set(created) == {CATEGORY, CHANNEL, DIRECT, GROUP}
            assert resource_reads == {CATEGORY, CHANNEL, DIRECT, GROUP}
            receipts = result["mappings"]
            assert {row["server_id"] for row in receipts} == {CATEGORY, CHANNEL, DIRECT, GROUP}
            assert all(row["logical_id"].startswith("partner:") for row in receipts)
            assert all(
                context.runtime_mappings[row["kind"]][row["logical_id"]] == row["server_id"]
                for row in receipts
            )
            evidence = result["request_evidence"]
            assert any(
                row["path"] == "/api/auth/invitations"
                and row["actor_id"] == ADMIN
                and row["status_code"] == 201
                for row in evidence
            )
            assert any(
                row["path"] == f"/api/auth/invitations/{INVITATION}/accept"
                and row["actor_id"] == ids[members[1]]
                and row["status_code"] == 204
                for row in evidence
            )
            assert [
                row["status_code"] for row in evidence if row["path"] == "/api/comms/directs"
            ] == [201, 200]
        assert context.runtime_mappings["comms_conversations"]["primary:preserve"] == CHANNEL
        assert context.mappings == original
        assert all(primary_clients[key].organization_id == PRIMARY for key in ids)
        assert context.clients is primary_clients
