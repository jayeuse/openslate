"""Promoted S18 file journeys: real API, current policy and real private Storage."""

from datetime import datetime
from uuid import UUID

import pytest
from uuid6 import uuid7

pytestmark = pytest.mark.integration
FILE_KEYS = {
    "id",
    "org_id",
    "conversation_id",
    "creator_id",
    "purpose",
    "filename",
    "expected_size",
    "actual_size",
    "media_type",
    "state",
    "failure_code",
    "is_deleted",
    "created_at",
    "updated_at",
}


def _root(conversation):
    return f"/api/comms/conversations/{conversation}"


def _ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def _hidden(response, content):
    assert response.status_code == 404, response.text
    assert content not in response.content
    assert "no-store" in response.headers["cache-control"]


def _reserve(case, client, org, conversation, actor, *, filename="conversation.png"):
    response = client.post(
        _root(conversation) + "/files",
        json={
            "filename": filename,
            "expected_size": len(case.content),
        },
    )
    item = _ok(response, 201)
    assert response.headers["location"]
    assert set(item) == FILE_KEYS
    UUID(item["id"])
    assert (item["org_id"], item["conversation_id"], item["creator_id"]) == (
        str(org.id),
        str(conversation),
        str(actor),
    )
    assert item["purpose"] == "comms_attachment"
    assert item["filename"] == filename and item["expected_size"] == len(case.content)
    assert (item["state"], item["actual_size"], item["media_type"], item["failure_code"]) == (
        "awaiting_upload",
        None,
        None,
        None,
    )
    assert item["is_deleted"] is False
    for key in ("created_at", "updated_at"):
        assert datetime.fromisoformat(item[key]).utcoffset() is not None
    return item


def _upload(case, client, org, conversation, reserved):
    item = _ok(
        client.put(
            f"{_root(conversation)}/files/{reserved['id']}/content",
            headers={"Content-Type": "application/octet-stream"},
            content=case.content,
        )
    )
    assert set(item) == FILE_KEYS
    for key in (
        "id",
        "org_id",
        "conversation_id",
        "creator_id",
        "purpose",
        "filename",
        "expected_size",
        "created_at",
    ):
        assert item[key] == reserved[key]
    assert (item["state"], item["actual_size"], item["media_type"], item["failure_code"]) == (
        "ready",
        len(case.content),
        "image/png",
        None,
    )
    assert item["is_deleted"] is False
    assert case.storage.download(case.object_key(org, UUID(item["id"]))) == case.content
    return item


def _send(client, conversation, file_ids):
    return client.post(
        _root(conversation) + "/messages",
        json={
            "client_key": str(uuid7()),
            "body": "",
            "attachment_ids": file_ids,
        },
    )


def _assert_attachment(message, file, content):
    assert message["state"] == "live"
    assert message["attachments"] == [
        {
            "id": file["id"],
            "filename": file["filename"],
            "media_type": "image/png",
            "size": len(content),
        }
    ]


def _download(client, conversation, file_id, content):
    response = client.get(f"{_root(conversation)}/files/{file_id}/content")
    assert response.status_code == 200, response.text
    assert response.content == content and response.headers["content-type"] == "image/png"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "no-store" in response.headers["cache-control"]


def test_member_roundtrip_and_known_uuid_denials(file_routes):
    case, org = file_routes, file_routes.world.second
    member, reader = case.client(org.peer, org.id), case.client(org.author, org.id)
    reserved = _reserve(case, member, org, org.conversation, org.peer)
    ready = _upload(case, member, org, org.conversation, reserved)
    message = _ok(_send(member, org.conversation, [ready["id"]]), 201)
    assert message["author_id"] == str(org.peer) and message["seq"] == 1
    _assert_attachment(message, ready, case.content)
    _assert_attachment(
        _ok(reader.get(f"{_root(org.conversation)}/messages/{message['id']}")), ready, case.content
    )
    history = _ok(reader.get(_root(org.conversation) + "/messages"))
    assert [row["id"] for row in history["items"]] == [message["id"]]
    _assert_attachment(history["items"][0], ready, case.content)
    _download(member, org.conversation, ready["id"], case.content)
    pending = _reserve(case, member, org, org.conversation, org.peer, filename="still-pending.png")
    pending_key = case.object_key(org, UUID(pending["id"]))
    assert case.storage.download(pending_key) is None
    before, foreign_before = case.stored_state(org), case.stored_state(case.world.first)
    for denied in (
        case.client(case.world.first.peer, org.id),
        case.client(org.peer, case.world.first.id),
    ):
        _hidden(
            denied.post(
                _root(org.conversation) + "/files",
                json={"filename": "denied.png", "expected_size": len(case.content)},
            ),
            case.content,
        )
        _hidden(
            denied.put(
                f"{_root(org.conversation)}/files/{pending['id']}/content",
                headers={"Content-Type": "application/octet-stream"},
                content=case.content,
            ),
            case.content,
        )
        _hidden(denied.get(f"{_root(org.conversation)}/files/{ready['id']}/content"), case.content)
        assert (
            case.stored_state(org) == before
            and case.stored_state(case.world.first) == foreign_before
        )
    assert case.storage.download(pending_key) is None
    _upload(case, member, org, org.conversation, pending)
    _download(reader, org.conversation, ready["id"], case.content)


def test_download_rechecks_access_after_storage_read(file_routes, monkeypatch):
    case, org = file_routes, file_routes.world.second
    member, remaining = case.client(org.peer, org.id), case.client(org.author, org.id)
    ready = _upload(
        case, member, org, org.conversation, _reserve(case, member, org, org.conversation, org.peer)
    )
    _ok(_send(member, org.conversation, [ready["id"]]), 201)
    _download(member, org.conversation, ready["id"], case.content)
    target, original = case.object_key(org, UUID(ready["id"])), case.storage.download
    reached = []

    def remove_after_real_read(key):
        content = original(key)
        if key == target and not reached:
            assert content == case.content
            case.remove_second_peer()
            reached.append(True)
        return content

    path = f"{_root(org.conversation)}/files/{ready['id']}/content"
    with monkeypatch.context() as patch:
        patch.setattr(case.storage, "download", remove_after_real_read)
        _hidden(member.get(path), case.content)
    assert reached == [True]
    _hidden(member.get(path), case.content)
    _download(remaining, org.conversation, ready["id"], case.content)
    assert original(target) == case.content


def test_wrong_purpose_and_foreign_conversation_links_are_atomic(file_routes):
    case, org = file_routes, file_routes.world.first
    actor = case.client(org.author, org.id)
    good = _upload(
        case, actor, org, org.conversation, _reserve(case, actor, org, org.conversation, org.author)
    )
    foreign = _upload(
        case,
        actor,
        org,
        org.other_conversation,
        _reserve(
            case, actor, org, org.other_conversation, org.author, filename="other-channel.png"
        ),
    )
    library = case.ready_library_fixture(org)
    for bad in (str(library), foreign["id"]):
        key, before = case.object_key(org, UUID(bad)), case.stored_state(org)
        refused = _send(actor, org.conversation, [good["id"], bad])
        assert 400 <= refused.status_code < 500, refused.text
        assert case.stored_state(org) == before
        _hidden(
            actor.put(
                f"{_root(org.conversation)}/files/{bad}/content",
                headers={"Content-Type": "application/octet-stream"},
                content=case.content,
            ),
            case.content,
        )
        _hidden(actor.get(f"{_root(org.conversation)}/files/{bad}/content"), case.content)
        assert case.stored_state(org) == before and case.storage.download(key) == case.content
    assert _ok(actor.get(_root(org.conversation) + "/messages"))["items"] == []
    message = _ok(_send(actor, org.conversation, [good["id"]]), 201)
    assert message["seq"] == 1
    _assert_attachment(
        _ok(actor.get(f"{_root(org.conversation)}/messages/{message['id']}")), good, case.content
    )
    _download(actor, org.conversation, good["id"], case.content)


def test_upload_revocation_preserves_recoverable_intent_without_a_generic_private_file_bypass(
    file_routes, monkeypatch
):
    from sqlalchemy import select

    from app.systems.access.users.models import Membership
    from app.systems.comms.conversations.models import CommsMember
    from app.systems.platform.files.models import File
    from tests.comms.conftest import NOW

    case, org = file_routes, file_routes.world.first
    member, admin = case.client(org.peer, org.id), case.client(org.author, org.id)
    reserved = _reserve(case, member, org, org.conversation, org.peer)
    original = case.storage.upload
    reached = []

    def revoke_after_upload(key, content, media_type):
        original(key, content, media_type)
        with case.world.session(org) as db:
            row = db.scalar(
                select(CommsMember).where(
                    CommsMember.org_id == org.id,
                    CommsMember.conversation_id == org.conversation,
                    CommsMember.user_id == org.peer,
                )
            )
            row.is_deleted, row.deleted_at = True, NOW
            db.commit()
        reached.append(True)

    path = f"{_root(org.conversation)}/files/{reserved['id']}/content"
    with monkeypatch.context() as patch:
        patch.setattr(case.storage, "upload", revoke_after_upload)
        _hidden(
            member.put(
                path, headers={"Content-Type": "application/octet-stream"}, content=case.content
            ),
            case.content,
        )
    assert reached == [True]
    with case.world.session(org) as db:
        assert db.get(File, UUID(reserved["id"])).state == "uploading"
        db.add(
            Membership(
                org_id=org.id, user_id=case.world.second.author, role="admin", status="active"
            )
        )
        db.commit()
    outsider = case.client(case.world.second.author, org.id)
    generic = f"/api/files/{reserved['id']}"
    _hidden(outsider.get(generic), case.content)
    _hidden(outsider.post(generic + "/reconcile"), case.content)
    # Existing operator recovery retains exact-admin AND current private-parent admission.
    recovered = _ok(admin.post(generic + "/reconcile"))
    assert recovered["state"] == "ready"
    _download(admin, org.conversation, reserved["id"], case.content)
    _hidden(member.get(path), case.content)
