"""Expired content becomes inaccessible immediately; proof waits for actual Storage deletion."""

from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.comms.jobs.export_worker import run_export_job
from app.systems.comms.jobs.models import CommsExport, CommsRetentionSweep
from app.systems.comms.jobs.retention_worker import run_retention_batch
from app.systems.comms.messages.models import CommsMessage
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import ProviderUnavailable
from tests.comms.jobs.test_comms_retention import NOW, policy
from tests.comms.routes.files.test_attachment_routes import _reserve
from tests.comms.routes.message_support import _ok, send

pytestmark = pytest.mark.integration


def test_retention_revokes_attachment_and_export_then_resumes_confirmed_cleanup(
    job_routes,
    file_routes,
    monkeypatch,
):
    case, org = file_routes, file_routes.world.first
    api = case.client(org.author, org.id)
    root = f"/api/comms/conversations/{org.conversation}"
    file = _reserve(case, api, org, org.conversation, org.author)
    file_path = root + "/files/" + file["id"] + "/content"
    assert (
        api.put(
            file_path, content=case.content, headers={"Content-Type": "application/octet-stream"}
        ).status_code
        == 200
    )
    key = case.object_key(org, UUID(file["id"]))
    message = send(api, root + "/messages", "Expired bytes", attachment_ids=[file["id"]])
    export = _ok(
        api.post(
            "/api/comms/exports",
            json={
                "conversation_ids": [str(org.conversation)],
                "format": "csv",
                "reason": "Owned review",
                "password": "owned-test-password",
            },
        ),
        201,
    )
    run_export_job(case.world.runtime, org.id, UUID(export["id"]), storage=case.storage)
    with case.world.session(org) as db:
        db.get(CommsMessage, UUID(message["id"])).created_at = NOW - timedelta(days=31)
        export_key = db.get(CommsExport, UUID(export["id"])).artifact_key
        assert export_key is not None
        case.setup_keys.add(export_key)
        db.commit()
    _, preview = policy(api, {"kind": "workspace"}, 30, 0)
    assert preview["message_count"] == preview["file_count"] == 1

    def unavailable(_key):
        raise ProviderUnavailable("Owned deletion refusal")

    with monkeypatch.context() as patch:
        patch.setattr(case.storage, "delete", unavailable)
        for _ in range(3):
            result = run_retention_batch(
                case.world.runtime, org.id, now=NOW, publish=lambda _: None, storage=case.storage
            )
            assert not result["complete"]
    assert api.get(file_path).status_code == 404
    assert api.get("/api/comms/exports/" + export["id"] + "/content").status_code == 404
    with case.world.session(org) as db:
        assert db.get(File, UUID(file["id"])).retention_erased_at is not None
        proof = db.scalars(select(CommsRetentionSweep)).one()
        assert proof.finished_at is None and proof.message_count == 1
    assert case.storage.download(key) == case.content
    assert case.storage.download(export_key) is not None
    for _ in range(10):
        if run_retention_batch(
            case.world.runtime, org.id, now=NOW, publish=lambda _: None, storage=case.storage
        )["complete"]:
            break
    else:
        pytest.fail("Retention cleanup did not complete after Storage recovered")
    assert case.storage.download(key) is case.storage.download(export_key) is None
    with case.world.session(org) as db:
        assert db.get(File, UUID(file["id"])) is None
        proof = db.scalars(select(CommsRetentionSweep)).one()
        assert proof.finished_at is not None and proof.file_count == 1


def test_unresolved_export_upload_does_not_defer_expired_message_erasure(job_routes, monkeypatch):
    from app.core.database.organization_scope import worker_organization
    from app.systems.comms.jobs.worker import poll_comms
    from app.systems.platform.files.storage import get_storage

    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    message = send(api, f"/api/comms/conversations/{org.conversation}/messages", "Must expire")
    export = _ok(api.post("/api/comms/exports", json={
        "conversation_ids": [str(org.other_conversation)], "format": "csv",
    }), 201)
    storage = get_storage()

    def unavailable(*_args):
        raise ProviderUnavailable("Owned upload outcome unknown")

    with monkeypatch.context() as patch:
        patch.setattr(storage, "upload", unavailable)
        run_export_job(case.world.runtime, org.id, UUID(export["id"]), storage=storage)
    with case.world.session(org) as db:
        db.get(CommsMessage, UUID(message["id"])).created_at = NOW - timedelta(days=31)
        db.get(CommsExport, UUID(export["id"])).cleanup_after = NOW - timedelta(seconds=1)
        db.commit()
    policy(api, {"kind": "workspace"}, 30, 0)
    with worker_organization(org.id), pytest.raises((ProviderUnavailable, ExceptionGroup)):
        poll_comms(case.world.runtime, publish=lambda _: None, now=NOW)
    with case.world.session(org) as db:
        retained = db.get(CommsMessage, UUID(message["id"]))
        assert retained is None or retained.retention_erased_at is not None
        assert db.get(CommsExport, UUID(export["id"])).cleanup_pending
