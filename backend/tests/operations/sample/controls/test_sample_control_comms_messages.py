"""Message-only sample executors use real planning, dispatch and HTTP journaling."""

import json
from datetime import date
from uuid import NAMESPACE_URL, UUID, uuid5

import httpx
import pytest

from app.main import create_app
from operations.sample.client import SampleClient
from operations.sample.controls.verification import verify_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    execute_phase_action,
)
from operations.sample.phases.plan import phase_action_to_manifest
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import SEEDER_ROUTES, read_route_evidence
from tests.operations.sample.controls.comms_support import (
    ADMIN,
    AT,
    CHANNEL,
    EDITED_AT,
    MESSAGE,
    ORIGIN,
    PARTNER,
    PRIMARY,
    _planned,
    _resource,
)
from tests.operations.sample.controls.test_sample_control_verification import (
    _patch_plan_and_final_verifiers,
)
from tests.operations.sample.verification.test_frontend_route_coverage import _shape
from tests.repository import REPOSITORY_ROOT

ROOT = "/api/comms/conversations/{conversation_id}"
MESSAGE_ROUTES = {
    ("GET", "/api/comms/bootstrap"),
    ("GET", f"{ROOT}/messages"),
    ("POST", f"{ROOT}/messages"),
    ("GET", f"{ROOT}/messages/{{message_id}}"),
    ("GET", f"{ROOT}/messages/by-sequence/{{seq}}"),
    ("PATCH", f"{ROOT}/messages/{{message_id}}"),
    ("DELETE", f"{ROOT}/messages/{{message_id}}"),
    ("PUT", f"{ROOT}/read"),
}


@pytest.mark.parametrize(
    "pack_key,fault",
    [
        ("harbor", None),
        ("school", None),
        ("harbor", "new_is_200"),
        ("harbor", "missing_etag"),
        ("harbor", "missing_request_id"),
        ("harbor", "old_readback"),
        ("harbor", "receipt_erased"),
        ("harbor", "end_state_erased"),
    ],
)
def test_message_executor_covers_message_routes_and_checks_observed_state_without_if_match(
    tmp_path,
    monkeypatch,
    pack_key,
    fault,
):
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(pack_key))
    action = _planned(dataset, "message_roundtrip")
    assert action.actor_key == "admin" and action.values["organization"] == "primary"
    assert action.target_key.startswith("primary:")
    assert action.values["conversation_key"].startswith("primary:")
    body, edited_body = action.values["body"], action.values["edited_body"]
    assert isinstance(body, str) and body.strip() and isinstance(edited_body, str)
    assert edited_body.strip() and body != edited_body
    collection = f"/api/comms/conversations/{CHANNEL}/messages"
    item = f"{collection}/{MESSAGE}"
    journal = tmp_path / "requests.jsonl"
    sent, seen, reads = [], [], set()
    edits, deleted, read_seq = 0, False, 0
    reads_before_edit = reads_after_edit = 0

    def response(status, payload, *, tag=None, location=None, receipt=True):
        headers = {"Cache-Control": "private, no-store"}
        if receipt:
            headers["X-Request-ID"] = str(uuid5(NAMESPACE_URL, f"message-reply-{len(seen)}"))
        if tag:
            headers["ETag"] = tag
        if location:
            headers["Location"] = location
        return httpx.Response(status, json=payload, headers=headers)

    def message(*, edited=False):
        identity = {
            "id": MESSAGE,
            "org_id": PRIMARY,
            "conversation_id": CHANNEL,
            "seq": 7,
            "author_id": ADMIN,
            "client_key": sent[0]["client_key"],
            "created_at": AT,
            "parent_id": None,
            "reply_to_id": None,
            "also_send_to_channel": False,
            "thread": None,
        }
        if deleted:
            return identity | {"state": "deleted", "deleted_at": EDITED_AT}
        return identity | {
            "state": "live",
            "body": edited_body if edited else body,
            "edited_at": EDITED_AT if edited else None,
            "pinned_at": None,
            "pinned_by": None,
            "attachments": [],
            "record_references": [],
            "mention_user_ids": [],
            "mentions_channel": False,
            "mentions_here": False,
            "reactions": [],
            "link_previews": [],
        }

    def handler(request):
        nonlocal edits, deleted, read_seq, reads_before_edit, reads_after_edit
        assert request.headers["x-org"] == PRIMARY
        if request.url.path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
                ],
            )
        seen.append(request)
        method, path = request.method, request.url.path
        assert "if-match" not in request.headers
        if (method, path) == ("GET", "/api/comms/bootstrap"):
            reads.add("bootstrap")
            return response(
                200,
                {
                    "org_id": PRIMARY,
                    "user_id": ADMIN,
                    "categories": [],
                    "conversations": [
                        {
                            "conversation": _resource(CHANNEL, PRIMARY)
                            | {
                                "kind": "channel",
                                "scope": "organization",
                                "name": "Sample messages",
                                "topic": "",
                                "category_id": None,
                                "position": 0,
                                "thread_branches": "all",
                                "archived_at": None,
                                "level": "manage",
                                "member_count": 1,
                                "member_role": "manager",
                            },
                            "preferences": {
                                "notify": "all",
                                "mute": {"kind": "off"},
                                "starred": False,
                                "hidden": False,
                                "manual_unread": False,
                            },
                            "last_read_seq": read_seq,
                            "high_water_seq": 7 if sent else 6,
                            "unread_count": 0,
                            "mention_count": 0,
                            "first_unread_seq": None,
                        }
                    ],
                },
            )
        if (method, path) == ("POST", collection):
            payload = json.loads(request.content)
            assert set(payload) == {"client_key", "body"}
            assert str(UUID(payload["client_key"])) == payload["client_key"]
            assert payload["body"] == body
            sent.append(payload)
            if len(sent) == 1:
                return response(
                    200 if fault == "new_is_200" else 201,
                    message(),
                    location=item,
                    receipt=fault != "missing_request_id",
                )
            assert len(sent) == 2 and sent[1] == sent[0]
            assert edits == 1 and not deleted
            return response(200, message(edited=True))
        if method == "GET" and path in (item, f"{collection}/by-sequence/7"):
            reads.add("item" if path == item else "sequence")
            if edits and not deleted:
                reads_after_edit += 1
            elif not edits:
                reads_before_edit += 1
            return response(
                200,
                message(edited=bool(edits) and fault != "old_readback"),
                tag=None if fault == "missing_etag" else '"message-current"',
            )
        if (method, path) == ("PATCH", item):
            assert "item" in reads
            assert json.loads(request.content) == {
                "body": edited_body,
                "mention_user_ids": [],
                "mentions_channel": False,
                "mentions_here": False,
            }
            edits += 1
            assert edits == 1
            return response(200, message(edited=True), tag='"message-current"')
        if (method, path) == ("GET", collection):
            reads.add("history")
            return response(
                200,
                {
                    "org_id": PRIMARY,
                    "conversation_id": CHANNEL,
                    "thread_root_id": None,
                    "items": [message(edited=bool(edits))],
                    "pagination": {
                        "limit": int(request.url.params.get("limit", "50")),
                        "count": 1,
                        "first_seq": 7,
                        "last_seq": 7,
                        "high_water_seq": 7,
                        "has_older": False,
                        "has_newer": False,
                    },
                },
            )
        if (method, path) == ("PUT", f"/api/comms/conversations/{CHANNEL}/read"):
            assert json.loads(request.content) == {"last_read_seq": 7}
            read_seq = 7
            return response(200, {"conversation_id": CHANNEL, "last_read_seq": read_seq})
        if (method, path) == ("DELETE", item):
            assert not deleted and edits == 1
            deleted = True
            return response(200, message(), tag='"message-deleted"')
        raise AssertionError(f"Unexpected message-family request: {method} {path}")

    with SampleClient(
        "http://sample.test", ORIGIN, journal, PRIMARY, transport=httpx.MockTransport(handler)
    ) as client:
        assert client.login("fixture-admin@example.test", "fixture-only").status_code == 200
        context = PhaseExecutionContext(
            clients={"admin": client},
            user_ids={"admin": ADMIN},
            group_ids={},
            department_ids={},
            module_ids={},
            field_ids={},
            admin_password="fixture-only",
            mappings={"comms_conversations": {action.values["conversation_key"]: CHANNEL}},
        )
        if fault in {"new_is_200", "missing_etag", "missing_request_id", "old_readback"}:
            with pytest.raises(SamplePhaseActionError):
                execute_phase_action(action, dataset, context)
            assert not deleted
            if fault in {"new_is_200", "missing_etag", "missing_request_id"}:
                assert edits == 0 and len(sent) == 1
            else:
                assert edits == 1 and reads_after_edit >= 1
            return
        result = execute_phase_action(action, dataset, context)
        assert result["outcome"] == "completed"
        assert result["organization_id"] == PRIMARY and result["message_id"] == MESSAGE
        assert result["message_edited"] is True and result["message_deleted"] is True
        assert result["read_marked"] is True and read_seq == 7
        assert reads_before_edit >= 1 and reads_after_edit >= 1 and len(sent) == 2
        assert reads == {"bootstrap", "item", "sequence", "history"}
        assert context.runtime_mappings["comms_messages"][action.target_key] == MESSAGE
        assert {
            "kind": "comms_messages",
            "logical_id": action.target_key,
            "server_id": MESSAGE,
        } in result["mappings"]
        receipts = result["request_evidence"]
        assert [(row["method"], row["path"], row["status_code"]) for row in receipts] == [
            ("POST", collection, 201),
            ("PATCH", item, 200),
            ("POST", collection, 200),
            ("PUT", f"/api/comms/conversations/{CHANNEL}/read", 200),
            ("DELETE", item, 200),
        ]
        assert len({row["request_id"] for row in receipts}) == 5
        assert all(row["actor_id"] == ADMIN for row in receipts)
        covered = {(row["method"], row["path"]) for row in read_route_evidence(journal)["covered"]}
        assert covered >= MESSAGE_ROUTES
        _patch_plan_and_final_verifiers(monkeypatch, action)
        manifest = {
            "organization_id": PRIMARY,
            "partner_organization_id": PARTNER,
            "control_plan": [phase_action_to_manifest(action)],
            "control_results": [result],
            "actor_ids": {"admin": ADMIN},
            "mappings": context.runtime_mappings,
        }
        if fault == "receipt_erased":
            receipts.pop(0)
        if fault == "end_state_erased":
            result.pop("message_deleted")
        counts, issues = verify_controls(client, dataset, manifest, ADMIN)
        if fault in {"receipt_erased", "end_state_erased"}:
            assert issues, "Incomplete execution must not verify"
        else:
            assert issues == []
            assert counts["control_requests_verified"] == 5


def test_message_routes_have_coupled_api_sample_and_frontend_registration():
    expected = {(method, _shape(path)) for method, path in MESSAGE_ROUTES}
    registered = {
        (method.upper(), _shape(path))
        for path, methods in create_app().openapi()["paths"].items()
        for method in methods
        if method in {"get", "post", "put", "patch", "delete"}
    }
    manifest = json.loads((REPOSITORY_ROOT / "frontend/api-route-manifest.json").read_text())
    frontend = {(row["method"], _shape(row["path"])) for row in manifest}
    assert expected <= registered
    assert expected <= {(method, _shape(path)) for method, path in SEEDER_ROUTES}
    assert expected <= frontend
