"""A confirmed conversation purge cannot erase metadata over an uncertain Storage delete."""

from uuid import UUID

import pytest

from app.systems.comms.messages.models import CommsMessage
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable
from tests.comms.routes.files.test_attachment_routes import _reserve
from tests.comms.routes.message_support import _ok, send
from tests.comms.routes.test_comms_purge import confirmation
from tests.comms.routes.test_comms_purge import purge_case as purge_case

pytestmark = pytest.mark.integration


def test_uncertain_storage_delete_preserves_parent_and_resumes_through_fresh_confirmation(
    purge_case, file_routes, monkeypatch,
):
    case, org = file_routes, file_routes.world.first
    api = case.client(org.author, org.id)
    root = f"/api/comms/conversations/{org.conversation}"
    file = _reserve(case, api, org, org.conversation, org.author)
    assert api.put(root + f"/files/{file['id']}/content", content=case.content,
                   headers={"Content-Type": "application/octet-stream"}).status_code == 200
    key = case.object_key(org, UUID(file["id"]))
    message = send(api, root + "/messages", "", attachment_ids=[file["id"]])
    message_path = root + "/messages/" + message["id"]
    version = api.get(message_path).headers["etag"]
    removed = api.post(message_path + "/removal", headers={"If-Match": version})
    assert removed.status_code == 200
    current = api.get(root)
    assert api.post(
        root + "/archive", headers={"If-Match": current.headers["etag"]},
    ).status_code == 200
    preview = _ok(api.post(root + "/purge/preview"))

    def unavailable(_key):
        raise ProviderUnavailable("controlled owned Storage refusal")

    with monkeypatch.context() as patch:
        patch.setattr(case.storage, "delete", unavailable)
        assert api.post(root + "/purge", json=confirmation(preview)).status_code == 503
    assert api.get(root).status_code == 200
    assert case.storage.download(key) == case.content
    with case.world.session(org) as db:
        assert db.get(CommsMessage, UUID(message["id"])) is not None
        retained = db.get(File, UUID(file["id"]))
        assert retained.state == "deleting" and retained.failure_code == "deletion_unresolved"
    current = api.get(message_path)
    assert api.post(message_path + "/restoration",
                    headers={"If-Match": current.headers["etag"]}).status_code == 422
    fresh = _ok(api.post(root + "/purge/preview"))
    result = _ok(api.post(root + "/purge", json=confirmation(fresh)))
    assert result["purged_file_count"] == result["purged_message_count"] == 1
    assert case.storage.download(key) is None and api.get(root).status_code == 404
