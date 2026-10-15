"""Concurrent download readers must cooperate while mutations remain authoritative."""

import os
from hashlib import sha256
from io import BytesIO
from threading import Event, Thread
from types import SimpleNamespace
from typing import Annotated
from uuid import uuid4

import pytest
from fastapi import Depends, Request
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import event, inspect, select, text

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.router import update_workspace
from app.systems.manage.workspace.schemas import WorkspaceUpdate
from app.systems.platform.files import delivery, service
from app.systems.platform.files.models import File
from app.systems.platform.files.storage import get_storage
from tests.conftest import create_member, create_organization, guarded_create_engine

pytestmark = pytest.mark.integration


@pytest.fixture
def committed_logo(guarded_db):
    # The central guard ran before this engine was obtained. Commit only this owned
    # fixture so two independent request sessions can observe the same rows.
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    actor_id, file_id = uuid4(), uuid4()
    output = BytesIO()
    Image.new("RGB", (2, 2)).save(output, format="PNG")
    content = output.getvalue()
    with AuditSession(engine) as db:
        profile = create_organization(db)
        org_id = profile.id
        actor, membership = create_member(
            db, profile,
            id=actor_id,
            email=f"logo-concurrency-{actor_id}@example.com",
            username=f"logo_{actor_id.hex[:12]}",
            role="admin",
            status="active",
        )
        membership_id = membership.id
        file = File(
            org_id=org_id,
            id=file_id,
            purpose="workspace_logo",
            creator_id=actor_id,
            filename="logo.png",
            expected_size=len(content),
            actual_size=len(content),
            media_type="image/png",
            digest=sha256(content).hexdigest(),
            object_key=uuid4().hex,
            state="ready",
        )
        db.add(file)
        db.flush()
        profile = db.scalar(select(WorkspaceProfile).with_for_update())
        profile_snapshot = {
            column.key: getattr(profile, column.key)
            for column in inspect(WorkspaceProfile).column_attrs
        }
        profile.logo_file_id = file_id
        db.commit()
    try:
        yield engine, actor_id, file_id, content
    finally:
        with AuditSession(engine) as db:
            profile = db.scalar(select(WorkspaceProfile).with_for_update())
            # Restore the snapshot's actor as well: AuditSession otherwise replaces
            # performed_by during flush, even when that attribute was assigned explicitly.
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=profile_snapshot["performed_by"],
                request_id=uuid4(),
                request_method="TEST",
                request_path="/test/fixture-cleanup",
            )
            for name, value in profile_snapshot.items():
                setattr(profile, name, value)
            db.flush()
            file = db.get(File, file_id)
            if file is not None:
                db.delete(file)
            db.commit()
            db.refresh(profile)
            assert {
                column.key: getattr(profile, column.key)
                for column in inspect(WorkspaceProfile).column_attrs
            } == profile_snapshot
        with AuditSession(engine) as db:
            db.delete(db.get(Membership, membership_id))
            db.flush()
            actor = db.get(User, actor_id)
            if actor is not None:
                db.delete(actor)
            db.commit()
        with engine.begin() as cleanup:
            cleanup.execute(text("DELETE FROM public.audit_logs WHERE org_id = :id"),
                            {"id": org_id})
            cleanup.execute(text("DELETE FROM public.organizations WHERE id = :id"),
                            {"id": org_id})
        engine.dispose()


def client_for(engine, actor_id, storage):
    app = create_app()
    # Only the readers and mutation callback participate in this concurrency fixture.
    app.state.provider_signout_worker = SimpleNamespace(start=lambda: None, stop=lambda: True)

    def database(request: Request):
        with AuditSession(engine) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_id=uuid4(), request_method="GET", request_path="/api/workspace/logo"
            )

            def mark_reader(session, transaction, connection):
                connection.info["logo_reader"] = request.headers.get("x-test-reader")

            event.listen(db, "after_begin", mark_reader)
            try:
                yield db
            finally:
                event.remove(db, "after_begin", mark_reader)

    def actor(db: Annotated[AuditSession, Depends(get_db)]):
        return db.scalar(select(User).where(User.id == actor_id))

    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_user] = actor
    app.dependency_overrides[get_storage] = lambda: storage
    return TestClient(app)


def test_two_admitted_logo_readers_both_return_exact_content(committed_logo, monkeypatch):
    engine, actor_id, file_id, content = committed_logo
    first_in_storage, second_holds_file, release_second = Event(), Event(), Event()
    first_finished = Event()
    results = {}

    class Storage:
        def download(self, key):
            first_in_storage.set()
            assert second_holds_file.wait(10), "Second reader never acquired its initial file lock"
            return content

    def after_sql(connection, cursor, statement, parameters, context, executemany):
        if (
            connection.info.get("logo_reader") == "second"
            and "FROM files" in statement
            and ("FOR UPDATE" in statement or "FOR SHARE" in statement)
            and not second_holds_file.is_set()
        ):
            second_holds_file.set()
            assert release_second.wait(10), "Test failed to release the second reader"

    monkeypatch.setattr(delivery, "append_committed_security_event", lambda payload: None)
    event.listen(engine, "after_cursor_execute", after_sql)
    try:
        with client_for(engine, actor_id, Storage()) as client:

            def get(name):
                try:
                    results[name] = client.get(
                        "/api/workspace/logo", headers={"x-test-reader": name}
                    )
                except BaseException as exc:
                    results[name] = exc
                finally:
                    if name == "first":
                        first_finished.set()

            first = Thread(target=get, args=("first",))
            second = Thread(target=get, args=("second",))
            first.start()
            try:
                assert first_in_storage.wait(10)
                second.start()
                assert second_holds_file.wait(10)
                assert first_finished.wait(10), "First reader blocked behind another reader"
                result = results["first"]
                assert not isinstance(result, BaseException), repr(result)
                assert result.status_code == 200, result.text
                assert result.content == content
            finally:
                release_second.set()
                first.join(10)
                if second.ident is not None:
                    second.join(10)
            assert not first.is_alive() and not second.is_alive()
            assert results["second"].status_code == 200, results["second"].text
            assert results["second"].content == content
    finally:
        release_second.set()
        event.remove(engine, "after_cursor_execute", after_sql)


@pytest.mark.parametrize("mutation", ["archive", "replace"])
def test_logo_mutation_during_storage_read_prevents_stale_delivery(
    committed_logo, monkeypatch, mutation
):
    engine, actor_id, file_id, content = committed_logo

    class Storage:
        def __init__(self):
            self.deleted = set()

        def delete(self, key):
            self.deleted.add(key)

        def download(self, key):
            if key in self.deleted:
                return None
            with AuditSession(engine) as db:
                if mutation == "archive":
                    service.archive(db, actor_id, file_id)
                else:
                    profile = db.scalar(select(WorkspaceProfile))
                    actor = db.scalar(select(User).where(User.id == actor_id))
                    update_workspace(
                        WorkspaceUpdate(revision=profile.revision, logo_file_id=None), actor, db
                    )
            return content

    monkeypatch.setattr(delivery, "append_committed_security_event", lambda payload: None)
    storage = Storage()
    monkeypatch.setattr("app.systems.manage.workspace.router.get_storage", lambda: storage)
    with client_for(engine, actor_id, storage) as client:
        result = client.get("/api/workspace/logo")
    assert result.status_code == 404, result.text
    assert result.content != content
