"""Real route, audited transaction and conflicting-writer proof in the guarded stack."""

import copy
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Event
from uuid import UUID

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.middleware.request_context import get_request_context
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.designs.models import SandboxDocument, SandboxVersion
from app.systems.sandbox.designs.service import _append_version, create_version, read_document
from tests.conftest import guarded_create_engine
from tests.rbac.support import make_user
from tests.route_app_support import route_app

pytestmark = pytest.mark.integration


@pytest.fixture
def prune_world():
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    actor = make_user("prune-" + uuid7().hex)
    owned = set()
    with AuditSession(owner, expire_on_commit=False) as db:
        row = db.scalar(select(SandboxDocument))
        assert row is not None
        assert not list(
            db.scalars(select(SandboxVersion).where(SandboxVersion.is_deleted.is_(False)))
        )
        initial = (row.revision, row.performed_by)
        db.add(actor)
        db.commit()
    reached = Event()

    def database(request: Request):
        reached.set()
        context = get_request_context(request)
        with AuditSession(runtime) as db:
            db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                performed_by=actor.id,
                request_id=context.request_id,
                request_method=request.method,
                request_path=request.url.path,
            )
            yield db

    app = route_app()
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_user] = lambda: actor
    try:
        with TestClient(app) as client:
            yield {
                "owner": owner,
                "runtime": runtime,
                "actor": actor,
                "client": client,
                "owned": owned,
                "reached": reached,
                "app": app,
            }
    finally:
        app.dependency_overrides.clear()
        with AuditSession(owner) as db:
            for identifier in owned:
                version = db.get(SandboxVersion, identifier)
                if version is not None:
                    db.delete(version)
            row = db.scalar(select(SandboxDocument))
            row.revision, row.performed_by = initial
            user = db.get(type(actor), actor.id)
            if user is not None:
                db.delete(user)
            db.commit()
        runtime.dispose()
        owner.dispose()


def _seed(world, count, *, newest_published=False):
    with AuditSession(world["owner"], expire_on_commit=False) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=world["actor"].id,
            request_id=uuid7(),
            request_method="POST",
            request_path="/api/test/prune-seed",
        )
        row = db.scalar(select(SandboxDocument))
        document = read_document(db).document
        versions = []

        def append(kind, label):
            version = _append_version(
                db,
                row=row,
                document=document,
                kind=kind,
                label=label,
                note=None,
                actor_id=world["actor"].id,
            )
            db.flush()
            world["owned"].add(version.id)
            versions.append(version)
            return version

        deleted = append("checkpoint", "Already deleted")
        deleted.is_deleted, deleted.deleted_at = True, datetime.now(UTC)
        append("published", "Older published snapshot")
        for index in range(count):
            append("checkpoint" if index % 2 == 0 else "imported", f"Mutable {index:02}")
        if newest_published:
            append("published", "Newest published snapshot")
        db.commit()
        return row.revision, versions


def _rows(world):
    with Session(world["owner"]) as db:
        versions = list(db.scalars(select(SandboxVersion).order_by(SandboxVersion.sequence)))
        row = db.scalar(select(SandboxDocument))
        return row.revision, {
            version.id: {
                "deleted": version.is_deleted,
                "kind": version.kind,
                "snapshot": copy.deepcopy(version.snapshot),
                "hash": version.content_hash,
                "deleted_at": version.deleted_at,
                "actor": version.performed_by,
            }
            for version in versions
        }


@pytest.mark.parametrize("newest_published", (False, True))
def test_prune_route_soft_deletes_only_oldest_mutable_and_audits_one_revision(
    prune_world, newest_published
):
    world = prune_world
    revision, versions = _seed(world, 50, newest_published=newest_published)
    _, before = _rows(world)
    mutable = [
        version for version in versions if version.kind != "published" and not version.is_deleted
    ]
    response = world["client"].post(
        "/api/sandbox/versions/prune", json={"expectedRevision": revision}
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"deletedCount": 10}
    after_revision, after = _rows(world)
    assert after_revision == revision + 1
    assert {
        identifier
        for identifier, row in after.items()
        if row["deleted"] and not before[identifier]["deleted"]
    } == {version.id for version in mutable[:10]}
    assert sum(not row["deleted"] and row["kind"] != "published" for row in after.values()) == 40
    for identifier, row in after.items():
        assert (
            row["snapshot"] == before[identifier]["snapshot"]
            and row["hash"] == before[identifier]["hash"]
        )
        if identifier in {version.id for version in mutable[:10]}:
            assert row["deleted_at"] is not None and row["actor"] == world["actor"].id
        elif not before[identifier]["deleted"]:
            assert not row["deleted"]
    request_id = UUID(response.headers["X-Request-ID"])
    with Session(world["owner"]) as db:
        audits = list(db.scalars(select(AuditLog).where(AuditLog.request_id == request_id)))
    assert len(audits) == 11
    assert all(
        row.performed_by == world["actor"].id and row.request_path == "/api/sandbox/versions/prune"
        for row in audits
    )
    assert {row.entity_id for row in audits if row.entity_type == "sandbox_versions"} == {
        version.id for version in mutable[:10]
    }
    assert all(row.action == "delete" for row in audits if row.entity_type == "sandbox_versions")
    documents = [row for row in audits if row.entity_type == "sandbox_documents"]
    assert len(documents) == 1 and documents[0].after["revision"] == revision + 1


@pytest.mark.parametrize("count", (0, 1, 40, 41))
def test_prune_boundaries_and_stale_noop_do_not_create_extra_changes(prune_world, count):
    revision, _ = _seed(prune_world, count)
    before_revision, before = _rows(prune_world)
    response = prune_world["client"].post(
        "/api/sandbox/versions/prune", json={"expectedRevision": revision}
    )
    assert response.status_code == 200, response.text
    expected = max(0, count - 40)
    assert response.json() == {"deletedCount": expected}
    after_revision, after = _rows(prune_world)
    assert after_revision == before_revision + bool(expected)
    with Session(prune_world["owner"]) as db:
        audits = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.request_id == UUID(response.headers["X-Request-ID"])
                )
            )
        )
    if not expected:
        assert after == before and audits == []
    stale = prune_world["client"].post(
        "/api/sandbox/versions/prune", json={"expectedRevision": after_revision + 10}
    )
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_revision"
    assert _rows(prune_world) == (after_revision, after)


@pytest.mark.parametrize(
    "payload",
    ({}, {"expectedRevision": 0}, {"expectedRevision": -1}, {"expectedRevision": 1, "retain": 1}),
)
def test_prune_request_validation_cannot_mutate_history(prune_world, payload):
    _seed(prune_world, 41)
    before = _rows(prune_world)
    response = prune_world["client"].post("/api/sandbox/versions/prune", json=payload)
    assert response.status_code == 422, response.text
    assert _rows(prune_world) == before


@pytest.mark.parametrize("role", ("member", "guest"))
def test_prune_remains_administrator_only(prune_world, role):
    revision, _ = _seed(prune_world, 41)
    before = _rows(prune_world)
    prune_world["actor"].role = role
    response = prune_world["client"].post(
        "/api/sandbox/versions/prune", json={"expectedRevision": revision}
    )
    assert response.status_code == 403, response.text
    assert _rows(prune_world) == before


def test_prune_requires_the_existing_authenticated_identity_boundary(prune_world):
    revision, _ = _seed(prune_world, 41)
    before = _rows(prune_world)
    prune_world["app"].dependency_overrides.pop(get_current_user)
    response = prune_world["client"].post(
        "/api/sandbox/versions/prune", json={"expectedRevision": revision}
    )
    assert response.status_code == 401, response.text
    assert _rows(prune_world) == before


def test_prune_flush_failure_rolls_back_versions_revision_and_audits(prune_world, monkeypatch):
    revision, _ = _seed(prune_world, 50)
    before = _rows(prune_world)
    commit = AuditSession.commit

    def unavailable(db):
        if db.get_bind() is prune_world["runtime"]:
            db.flush()
            raise OperationalError("private statement", {}, RuntimeError("private database detail"))
        return commit(db)

    monkeypatch.setattr(AuditSession, "commit", unavailable)
    response = prune_world["client"].post(
        "/api/sandbox/versions/prune", json={"expectedRevision": revision}
    )
    assert response.status_code == 503, response.text
    assert "private" not in response.text
    assert _rows(prune_world) == before
    with Session(prune_world["owner"]) as db:
        assert not list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.request_id == UUID(response.headers["X-Request-ID"])
                )
            )
        )


def test_prune_rechecks_revision_after_a_concurrent_checkpoint_writer(prune_world):
    world = prune_world
    revision, _ = _seed(world, 41)
    world["reached"].clear()
    with AuditSession(world["owner"]) as holder:
        holder.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=world["actor"].id,
            request_id=uuid7(),
            request_method="POST",
            request_path="/api/test/prune-race",
        )
        assert holder.scalar(select(SandboxDocument).with_for_update()) is not None
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(
                world["client"].post,
                "/api/sandbox/versions/prune",
                json={"expectedRevision": revision},
            )
            assert world["reached"].wait(5), "Prune route did not reach its database dependency"
            version = create_version(
                holder,
                actor_id=world["actor"].id,
                expected_revision=revision,
                kind="checkpoint",
                label="Concurrent newest checkpoint",
                note=None,
            )
            world["owned"].add(version.id)
            response = future.result(5)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "stale_revision"
    final_revision, rows = _rows(world)
    assert final_revision == revision + 1
    assert sum(not row["deleted"] and row["kind"] != "published" for row in rows.values()) == 42
    assert not rows[version.id]["deleted"]
