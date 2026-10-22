"""Wire assertions and sanitized measurements for real message-family route tests."""

import json
import os
from datetime import datetime
from uuid import UUID

from uuid6 import uuid7

from tests.repository import REPOSITORY_ROOT

IDENTITY_KEYS = {
    "id",
    "org_id",
    "conversation_id",
    "seq",
    "author_id",
    "client_key",
    "created_at",
    "parent_id",
    "reply_to_id",
    "also_send_to_channel",
    "thread",
}
LIVE_KEYS = IDENTITY_KEYS | {
    "state",
    "body",
    "edited_at",
    "pinned_at",
    "pinned_by",
    "attachments",
    "record_references",
    "mention_user_ids",
    "mentions_channel",
    "mentions_here",
    "reactions",
    "link_previews",
}
SUMMARY_KEYS = {
    "conversation",
    "preferences",
    "last_read_seq",
    "high_water_seq",
    "unread_count",
    "mention_count",
    "first_unread_seq",
}
CHANNEL_KEYS = {
    "id",
    "org_id",
    "created_at",
    "updated_at",
    "archived_at",
    "level",
    "member_count",
    "member_role",
    "kind",
    "name",
    "topic",
    "category_id",
    "position",
    "scope",
    "thread_branches",
}
PREFERENCE_KEYS = {"notify", "mute", "starred", "hidden", "manual_unread"}


def _record_performance(name, timings, counts=(), startup_ms=()):
    assert len(timings) == 30
    directory = (
        REPOSITORY_ROOT
        / "backend/test-results/comms-messages"
        / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    )
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.json").write_text(
        json.dumps(
            {
                "request_ms": timings,
                "request_p95_ms": sorted(timings)[28],
                "select_counts": counts,
                "startup_request_ms": startup_ms,
                "principal": (
                    "Supplied test principal; real organization membership and domain policy"
                ),
                "production_organization_baseline_reference": (
                    "6 warm / 9 cold SELECTs plus scope (plan §6)"
                ),
            },
            indent=2,
        )
        + "\n"
    )


def _root(conversation):
    return f"/api/comms/conversations/{conversation}"


def _payload(body="Initial route message"):
    return {"client_key": str(uuid7()), "body": body}


def send(api, path, text="Message", **fields):
    return _ok(api.post(path, json={**_payload(text), **fields}), 201)


def _edit(body="Edited route message"):
    return {
        "body": body,
        "mention_user_ids": [],
        "mentions_channel": False,
        "mentions_here": False,
    }


def _ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def _error(response, status, code):
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"detail"}
    assert set(body["detail"]) == {"code", "message"}
    assert body["detail"]["code"] == code
    assert isinstance(body["detail"]["message"], str)


def _timestamp(value):
    assert datetime.fromisoformat(value).utcoffset() is not None


def _etag(response):
    value = response.headers["etag"]
    assert value.startswith('"') and value.endswith('"') and len(value) > 2
    return value


def _live(item, org, conversation, author, payload):
    assert set(item) == LIVE_KEYS
    UUID(item["id"])
    assert (item["org_id"], item["conversation_id"], item["author_id"]) == (
        str(org),
        str(conversation),
        str(author),
    )
    assert item["client_key"] == payload["client_key"]
    assert item["state"] == "live" and item["body"] == payload["body"]
    _timestamp(item["created_at"])


def _tombstone(item):
    assert set(item) == IDENTITY_KEYS | {"state", "deleted_at"}
    assert item["state"] == "deleted"
    _timestamp(item["deleted_at"])


def _body_free(value):
    if isinstance(value, dict):
        assert "body" not in value
        for child in value.values():
            _body_free(child)
    elif isinstance(value, list):
        for child in value:
            _body_free(child)


def _bootstrap(client, org, actor):
    response = client.get("/api/comms/bootstrap")
    body = _ok(response)
    assert "no-store" in response.headers["cache-control"]
    assert set(body) == {"org_id", "user_id", "categories", "conversations"}
    assert (body["org_id"], body["user_id"]) == (str(org), str(actor))
    assert "Private bootstrap body" not in response.text
    _body_free(body)
    for entry in body["categories"]:
        assert set(entry) == {"category", "preferences"}
        category = entry["category"]
        assert set(category) == {
            "id",
            "org_id",
            "created_at",
            "updated_at",
            "name",
            "position",
            "department_id",
        }
        assert category["org_id"] == str(org)
        assert set(entry["preferences"]) == {"collapsed", "mute"}
    by_id = {}
    for summary in body["conversations"]:
        assert set(summary) == SUMMARY_KEYS
        conversation = summary["conversation"]
        assert conversation["org_id"] == str(org)
        if conversation["kind"] == "channel" and conversation["scope"] == "organization":
            assert set(conversation) == CHANNEL_KEYS
        assert set(summary["preferences"]) == PREFERENCE_KEYS
        identity = conversation["id"]
        assert identity not in by_id
        by_id[identity] = summary
    return by_id


def _unread(summary):
    return tuple(
        summary[key]
        for key in (
            "last_read_seq",
            "high_water_seq",
            "unread_count",
            "mention_count",
            "first_unread_seq",
        )
    )
