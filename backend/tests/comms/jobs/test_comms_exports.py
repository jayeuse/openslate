"""Real exported bytes and current captured-source permission checks, not metadata-only jobs."""

import csv
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, local
from uuid import UUID
from xml.etree import ElementTree

import pytest
from sqlalchemy import select

from app.systems.access.users.models import Membership
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.jobs.models import CommsExport
from app.systems.platform.files.providers import ProviderUnavailable
from app.systems.platform.files.storage import get_storage
from tests.comms.routes.message_support import _ok, _payload

pytestmark = pytest.mark.integration
ROOT = "/api/comms/exports"


@pytest.mark.parametrize("format", ["csv", "xlsx"])
def test_export_job_creates_actual_safe_bytes_and_hides_artifacts_from_metadata(job_routes, format):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    source = _ok(
        api.post(
            f"/api/comms/conversations/{org.conversation}/messages", json=_payload("=SUM(1,2)")
        ),
        201,
    )
    created = _ok(
        api.post(ROOT, json={"conversation_ids": [str(org.conversation)], "format": format}), 201
    )
    assert created["status"] == "pending" and created["failure_code"] is None
    from app.systems.comms.jobs.export_worker import run_export_job

    run_export_job(case.world.runtime, org.id, UUID(created["id"]))
    job = _ok(api.get(ROOT + "/" + created["id"]))
    assert job["status"] == "succeeded"
    assert set(job) == {
        "id",
        "org_id",
        "requested_by",
        "created_at",
        "updated_at",
        "request",
        "status",
        "failure_code",
    }
    assert "artifact" not in str(job) and "=SUM" not in str(job)
    response = api.get(ROOT + "/" + created["id"] + "/content")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert int(response.headers["content-length"]) == len(response.content)
    assert "." + format in response.headers["content-disposition"]
    if format == "csv":
        rows = list(csv.DictReader(io.StringIO(response.content.decode("utf-8"))))
        assert len(rows) == 1 and rows[0]["message_id"] == source["id"]
        assert rows[0]["body"] == "'=SUM(1,2)"
        assert response.headers["content-type"].startswith("text/csv")
    else:
        assert (
            response.headers["content-type"]
            == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            sheet = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        assert sheet.findall(".//s:f", ns) == []
        values = [node.text for node in sheet.findall(".//s:t", ns)]
        assert source["id"] in values and "=SUM(1,2)" in values
    assert (
        case.client(org.peer, org.id).get(ROOT + "/" + created["id"] + "/content").status_code
        == 403
    )


def private(room):
    """D31/D44: only direct and group messages are private sources."""
    room.kind, room.scope, room.category_id = "group", "members", None


def test_private_export_requires_fresh_proof_and_later_authority_is_rechecked(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    with case.world.session(org) as db:
        private(db.get(CommsConversation, org.conversation))
        db.commit()
    request = {
        "conversation_ids": [str(org.conversation)],
        "format": "csv",
        "reason": "Owned review",
    }
    assert api.post(ROOT, json=request).status_code == 403
    assert api.post(ROOT, json={**request, "password": "wrong"}).status_code == 403
    created = _ok(api.post(ROOT, json={**request, "password": "owned-test-password"}), 201)
    assert "password" not in str(created)
    from app.systems.comms.jobs.export_worker import run_export_job

    run_export_job(case.world.runtime, org.id, UUID(created["id"]))
    path = ROOT + "/" + created["id"] + "/content"
    assert api.get(path).status_code == 200
    with case.world.session(org) as db:
        membership = db.scalars(
            select(Membership).where(Membership.org_id == org.id, Membership.user_id == org.author)
        ).one()
        membership.role = "member"
        db.commit()
    assert api.get(path).status_code == 403


def test_export_denies_foreign_sources_and_new_private_scope_without_captured_proof(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    assert (
        api.post(
            ROOT, json={"conversation_ids": [str(case.world.second.conversation)], "format": "csv"}
        ).status_code
        == 404
    )
    job = _ok(
        api.post(ROOT, json={"conversation_ids": [str(org.conversation)], "format": "csv"}), 201
    )
    from app.systems.comms.jobs.export_worker import run_export_job

    run_export_job(case.world.runtime, org.id, UUID(job["id"]))
    path = ROOT + "/" + job["id"] + "/content"
    with case.world.session(org) as db:
        private(db.get(CommsConversation, org.conversation))
        db.commit()
    assert api.get(path).status_code == 403
    assert api.get(path, params={"password": "owned-test-password"}).status_code == 403


def test_failed_upload_is_cleaned_without_requiring_a_retention_policy(job_routes, monkeypatch):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    job = _ok(
        api.post(ROOT, json={"conversation_ids": [str(org.conversation)], "format": "csv"}), 201
    )
    identity, storage = UUID(job["id"]), get_storage()
    upload = storage.upload

    def lost_response(key, content, media_type):
        upload(key, content, media_type)
        raise ProviderUnavailable("Owned upload completed but response was lost")

    from app.systems.comms.jobs.export_worker import execute_due_exports, run_export_job

    with monkeypatch.context() as patch:
        patch.setattr(storage, "upload", lost_response)
        run_export_job(case.world.runtime, org.id, identity, storage=storage)
    assert _ok(api.get(ROOT + "/" + job["id"]))["status"] == "failed"
    with case.world.session(org) as db:
        persisted = db.get(CommsExport, identity)
        key = persisted.artifact_key
        assert persisted.cleanup_pending and storage.download(key) is not None
        persisted.cleanup_after = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    execute_due_exports(case.world.runtime, org.id)
    assert storage.download(key) is None
    with case.world.session(org) as db:
        persisted = db.get(CommsExport, identity)
        assert not persisted.cleanup_pending and persisted.artifact_key is None


def test_concurrent_confirmed_artifact_cleanup_is_idempotent(job_routes, monkeypatch):
    from app.systems.comms.jobs.export_service import cleanup_artifact, retire
    from app.systems.comms.jobs.export_worker import run_export_job

    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    job = _ok(api.post(ROOT, json={
        "conversation_ids": [str(org.conversation)], "format": "csv",
    }), 201)
    identity, storage = UUID(job["id"]), get_storage()
    run_export_job(case.world.runtime, org.id, identity, storage=storage)
    with case.world.session(org) as db:
        retire(db, [identity], now=datetime.now(UTC))
        db.commit()
    gate, state, original = Barrier(2), local(), storage.download

    def download(key):
        if not getattr(state, "arrived", False):
            state.arrived = True
            gate.wait(timeout=10)
        return original(key)

    def clean():
        with case.world.session(org) as db:
            return cleanup_artifact(db, identity, storage)

    monkeypatch.setattr(storage, "download", download)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(clean) for _ in range(2)]
        assert [future.result(timeout=30) for future in futures] == [True, True]
