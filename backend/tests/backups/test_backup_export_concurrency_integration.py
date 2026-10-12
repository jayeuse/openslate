"""Two independent HTTP transactions prove queue and native-consumption serialization."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.backups import downloads, exports
from app.systems.manage.backups.models import BackupExportOperation

pytestmark = pytest.mark.integration


def test_simultaneous_identical_export_requests_commit_one_addressable_operation(
    export_world, monkeypatch
):
    world = export_world
    key, admitted = uuid4().hex, Barrier(2)
    original = exports.queue_export

    def overlapping(*args, **kwargs):
        admitted.wait(timeout=10)
        return original(*args, **kwargs)

    monkeypatch.setattr(exports, "queue_export", overlapping)
    with ThreadPoolExecutor(max_workers=2) as requests:
        first = requests.submit(world.create, key)
        second = requests.submit(world.create, key)
        responses = [first.result(timeout=20), second.result(timeout=20)]
    assert [response.status_code for response in responses] == [201, 201]
    assert responses[0].json() == responses[1].json()
    export_id = UUID(responses[0].json()["id"])
    with Session(world.auth.owner) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(BackupExportOperation)
                .where(BackupExportOperation.backup_run_id == world.source_id)
            )
            == 1
        )
        assert db.get(BackupExportOperation, export_id).state == "queued"


def test_overlapping_native_requests_have_one_consume_attempt_and_retained_descriptor(
    ready_export, monkeypatch
):
    world = ready_export
    assert world.admit().status_code == 200
    entered, release = Event(), Event()
    original = downloads.prepare_artifact
    opened = []

    def held(*args, **kwargs):
        artifact = original(*args, **kwargs)
        opened.append(artifact)
        entered.set()
        assert release.wait(10), "Owned verified descriptor was not released"
        return artifact

    monkeypatch.setattr(downloads, "prepare_artifact", held)
    with ThreadPoolExecutor(max_workers=2) as requests:
        first = requests.submit(
            world.auth.client.get, world.path + "/content", headers=world.native_headers
        )
        try:
            assert entered.wait(10), "Native preparation was not reached"
            refused = world.auth.client.get(world.path + "/content", headers=world.native_headers)
            assert refused.status_code == 503 and refused.headers["retry-after"] == "5"
            with Session(world.auth.owner) as db:
                assert db.get(BackupExportOperation, world.export_id).admission_digest is not None
                assert (
                    db.scalar(
                        select(func.count())
                        .select_from(SecurityEvent)
                        .where(SecurityEvent.subject_id == world.export_id)
                    )
                    == 0
                )
            world.artifact.unlink()
            world.artifact.write_bytes(b"Unrelated replacement after verified open")
        finally:
            release.set()
        completed = first.result(timeout=20)
    assert completed.status_code == 200 and completed.content == world.content
    assert opened and all(archive.closed for archive in opened)
    with Session(world.auth.owner) as db:
        assert db.get(BackupExportOperation, world.export_id).admission_digest is None
        events = list(
            db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id == world.export_id))
        )
        assert len(events) == 1 and events[0].event_type == "backup.export.download"
        assert events[0].outcome == "attempt"
    assert (
        world.auth.client.get(world.path + "/content", headers=world.native_headers).status_code
        == 403
    )
