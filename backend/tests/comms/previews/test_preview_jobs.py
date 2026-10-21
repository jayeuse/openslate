"""Existing message API plus real durable work; only the external fetch boundary is controlled."""

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import UUID

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.core.database.session import AuditSession
from app.systems.access.users.models import Membership
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.models import CommsMessage
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import ScheduledWork
from tests.comms.jobs.test_comms_retention import policy
from tests.comms.routes.message_support import _edit, _ok, _payload

pytestmark = pytest.mark.integration
KIND = "comms-link-preview"
URL = "https://preview.example.com/owned?token=synthetic-url-canary"
META = {
    "url": URL,
    "title": "synthetic-title-canary",
    "description": "Plain description",
    "site_name": "Owned",
}


def setting(api, conversation, enabled):
    path = f"/api/comms/settings/channel/{conversation}"
    current = api.get(path)
    response = api.patch(
        path, json={"link_previews": enabled}, headers={"If-Match": current.headers["etag"]}
    )
    assert response.status_code == 200


def work(case, org, message_id):
    with case.world.session(org) as db:
        return db.scalars(
            select(ScheduledWork.id)
            .where(
                ScheduledWork.kind == KIND,
                ScheduledWork.comms_preview_message_id == UUID(message_id),
            )
            .order_by(ScheduledWork.created_at.desc(), ScheduledWork.id.desc())
        ).first()


def test_default_off_is_no_work_and_enabled_send_uses_existing_message_projection(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    root = f"/api/comms/conversations/{org.conversation}/messages"
    before = _ok(api.post(root, json=_payload(URL)), 201)
    assert before["link_previews"] == []
    with case.world.session(org) as db:
        assert (
            db.scalar(
                select(func.count()).select_from(ScheduledWork).where(ScheduledWork.kind == KIND)
            )
            == 0
        )
    setting(api, org.conversation, True)
    request = _payload(URL)
    created = _ok(api.post(root, json=request), 201)
    assert created["link_previews"] == []  # No network belongs to request acknowledgement.
    with case.world.session(org) as db:
        assert (
            db.scalar(
                select(func.count()).select_from(ScheduledWork).where(ScheduledWork.kind == KIND)
            )
            == 1
        )
    from app.systems.comms.previews.jobs import run_preview_job

    events, fetched = [], []

    def fetch(url):
        fetched.append(url)
        return dict(META)

    identity = work(case, org, created["id"])
    run_preview_job(case.world.runtime, org.id, identity, publish=events.extend, fetch=fetch)
    run_preview_job(case.world.runtime, org.id, identity, publish=events.extend, fetch=fetch)
    result = _ok(api.get(root + "/" + created["id"]))
    assert result["link_previews"] == [META] and result["body"] == URL
    assert _ok(api.post(root, json=request))["id"] == created["id"]
    assert fetched == [URL]
    assert len([row for row in events if row["event"] == "message"]) == 1
    assert "synthetic-url-canary" not in json.dumps(
        events
    ) and "synthetic-title-canary" not in json.dumps(events)
    with case.world.session(org) as db:
        audit = json.dumps(
            [(row.before, row.after) for row in db.scalars(select(AuditLog))], default=str
        )
        assert "synthetic-url-canary" not in audit and "synthetic-title-canary" not in audit
        assert db.get(ScheduledWork, identity).state == "succeeded"
    setting(api, org.conversation, False)
    assert _ok(api.get(root + "/" + created["id"]))["link_previews"] == []


@pytest.mark.parametrize(
    "change",
    ["edit", "delete", "setting-off", "setting-off-on", "access-loss", "archive", "org-inactive"],
)
def test_inflight_preview_cannot_survive_source_or_policy_revocation(job_routes, change):
    case, org = job_routes, job_routes.world.first
    admin, author = case.client(org.author, org.id), case.client(org.peer, org.id)
    with case.world.session(org) as db:
        db.get(CommsConversation, org.conversation).scope = "members"
        db.commit()
    setting(admin, org.conversation, True)
    root = f"/api/comms/conversations/{org.conversation}"
    message = _ok(author.post(root + "/messages", json=_payload(URL)), 201)
    identity = work(case, org, message["id"])
    from app.systems.comms.previews.jobs import run_preview_job

    def fetch(_url):
        if change == "edit":
            assert (
                author.patch(
                    root + "/messages/" + message["id"],
                    json=_edit("https://preview.example.com/new"),
                ).status_code
                == 200
            )
        elif change == "delete":
            assert author.delete(root + "/messages/" + message["id"]).status_code == 200
        elif change.startswith("setting-off"):
            setting(admin, org.conversation, False)
            if change == "setting-off-on":
                setting(admin, org.conversation, True)
        elif change == "access-loss":
            current = admin.get(root)
            assert (
                admin.delete(
                    root + "/members/" + str(org.peer),
                    headers={"If-Match": current.headers["etag"]},
                ).status_code
                == 204
            )
        elif change == "archive":
            current = admin.get(root)
            assert (
                admin.post(
                    root + "/archive", headers={"If-Match": current.headers["etag"]}
                ).status_code
                == 200
            )
        else:
            with case.world.session(org) as db:
                db.get(WorkspaceProfile, org.id).is_deleted = True
                db.commit()
        return dict(META)

    events = []
    run_preview_job(case.world.runtime, org.id, identity, publish=events.extend, fetch=fetch)
    with case.world.session(org) as db:
        retained = db.get(CommsMessage, UUID(message["id"]))
        assert retained.link_previews == [] and retained.link_preview_generation is None
        assert db.get(ScheduledWork, identity).state != "succeeded"
    assert events == []


@pytest.mark.parametrize("failure", ["none", "exception", "wrong-url", "extra-content", "commit"])
def test_optional_fetch_or_commit_failure_never_fails_or_partially_enriches_message(
    job_routes, caplog, failure
):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    setting(api, org.conversation, True)
    root = f"/api/comms/conversations/{org.conversation}/messages"
    message = _ok(api.post(root, json=_payload(URL)), 201)
    identity = work(case, org, message["id"])
    from app.systems.comms.previews.jobs import run_preview_job

    def fetch(_url):
        if failure == "exception":
            raise OSError("synthetic-url-canary")
        if failure == "none":
            return None
        if failure == "wrong-url":
            return {**META, "url": "https://other.example.com/"}
        if failure == "extra-content":
            return {**META, "image": "http://127.0.0.1/"}
        return dict(META)

    def refuse(db, _context, _instances):
        if any(isinstance(row, CommsMessage) and row.link_previews for row in db.dirty):
            raise SQLAlchemyError("Owned metadata commit failure")

    events = []
    if failure == "commit":
        event.listen(AuditSession, "before_flush", refuse)
    try:
        with caplog.at_level("DEBUG"):
            run_preview_job(
                case.world.runtime, org.id, identity, publish=events.extend, fetch=fetch
            )
    finally:
        if failure == "commit":
            event.remove(AuditSession, "before_flush", refuse)
    assert _ok(api.get(root + "/" + message["id"]))["link_previews"] == []
    assert events == [] and "synthetic-url-canary" not in caplog.text
    with case.world.session(org) as db:
        row = db.get(ScheduledWork, identity)
        assert row.state == "failed" and row.attempt_count == 1


def test_job_org_actor_and_old_lease_are_fenced_and_concurrent_completion_is_unique(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    setting(api, org.conversation, True)
    root = f"/api/comms/conversations/{org.conversation}/messages"
    message = _ok(api.post(root, json=_payload(URL)), 201)
    identity = work(case, org, message["id"])
    from app.systems.comms.previews.jobs import (
        claim_preview,
        execute_preview_claim,
        run_preview_job,
    )

    fetched, events = [], []

    def fetch(url):
        fetched.append(url)
        return dict(META)

    run_preview_job(
        case.world.runtime, case.world.second.id, identity, publish=events.extend, fetch=fetch
    )
    assert fetched == []
    with case.world.session(org) as db:
        stale = claim_preview(db, identity, now=datetime.now(UTC))
        db.commit()
    with case.world.session(org) as db:
        db.get(ScheduledWork, identity).lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    with case.world.session(org) as db:
        current = claim_preview(db, identity, now=datetime.now(UTC))
        db.commit()
    execute_preview_claim(case.world.runtime, org.id, stale, publish=events.extend, fetch=fetch)
    assert fetched == []
    execute_preview_claim(case.world.runtime, org.id, current, publish=events.extend, fetch=fetch)
    execute_preview_claim(case.world.runtime, org.id, current, publish=events.extend, fetch=fetch)
    assert fetched == [URL] and len(events) == 1
    another = _ok(api.post(root, json=_payload(URL + "-two")), 201)
    other_id = work(case, org, another["id"])
    with case.world.session(org) as db:
        db.get(ScheduledWork, other_id).scheduling_actor_id = org.peer
        db.commit()
    run_preview_job(case.world.runtime, org.id, other_id, publish=events.extend, fetch=fetch)
    assert fetched == [URL]


def test_two_workers_cannot_fetch_or_publish_the_same_generation_twice(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    setting(api, org.conversation, True)
    root = f"/api/comms/conversations/{org.conversation}/messages"
    message = _ok(api.post(root, json=_payload(URL)), 201)
    identity = work(case, org, message["id"])
    from app.systems.comms.previews.jobs import run_preview_job

    gate, fetched, events = Barrier(2), [], []

    def run():
        gate.wait(timeout=10)
        run_preview_job(
            case.world.runtime,
            org.id,
            identity,
            publish=events.extend,
            fetch=lambda url: fetched.append(url) or dict(META),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(run) for _ in range(2)]
        for future in futures:
            future.result(timeout=30)
    assert fetched == [URL] and len(events) == 1


def test_edits_replace_pending_work_and_retention_removes_cache_and_work_without_resurrection(
    job_routes,
):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    setting(api, org.conversation, True)
    root = f"/api/comms/conversations/{org.conversation}/messages"
    message = _ok(api.post(root, json=_payload(URL)), 201)
    old = work(case, org, message["id"])
    new_url = "https://preview.example.com/replacement"
    assert api.patch(root + "/" + message["id"], json=_edit(new_url)).status_code == 200
    current = work(case, org, message["id"])
    assert current != old
    with case.world.session(org) as db:
        assert db.get(ScheduledWork, old).state == "canceled"
    from app.systems.comms.jobs.retention_worker import run_retention_batch
    from app.systems.comms.previews.jobs import run_preview_job

    run_preview_job(
        case.world.runtime,
        org.id,
        current,
        publish=lambda _: None,
        fetch=lambda _: {**META, "url": new_url},
    )
    assert _ok(api.get(root + "/" + message["id"]))["link_previews"][0]["url"] == new_url
    now = datetime.now(UTC)
    with case.world.session(org) as db:
        db.get(CommsMessage, UUID(message["id"])).created_at = now - timedelta(days=31)
        db.commit()
    policy(api, {"kind": "workspace"}, 30, 0)
    for _ in range(10):
        if run_retention_batch(case.world.runtime, org.id, publish=lambda _: None, now=now)[
            "complete"
        ]:
            break
    with case.world.session(org) as db:
        assert db.get(CommsMessage, UUID(message["id"])) is None
        assert (
            db.scalar(
                select(func.count()).select_from(ScheduledWork).where(ScheduledWork.kind == KIND)
            )
            == 0
        )


@pytest.mark.parametrize("change", ["setting-off", "author-disabled", "delete", "wrong-generation"])
def test_source_refusal_happens_before_external_fetch(job_routes, change):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    setting(api, org.conversation, True)
    root = f"/api/comms/conversations/{org.conversation}/messages"
    message = _ok(api.post(root, json=_payload(URL)), 201)
    identity = work(case, org, message["id"])
    if change == "setting-off":
        setting(api, org.conversation, False)
    elif change == "delete":
        assert api.delete(root + "/" + message["id"]).status_code == 200
    else:
        with case.world.session(org) as db:
            if change == "author-disabled":
                db.scalars(
                    select(Membership).where(Membership.user_id == org.author)
                ).one().status = "disabled"
            else:
                db.get(ScheduledWork, identity).comms_preview_generation = 1
            db.commit()
    from app.systems.comms.previews.jobs import run_preview_job

    fetched = []
    run_preview_job(
        case.world.runtime,
        org.id,
        identity,
        publish=lambda _: None,
        fetch=lambda url: fetched.append(url) or dict(META),
    )
    assert fetched == []


def test_purge_removes_preview_dependencies_and_old_work_cannot_refetch(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    setting(api, org.conversation, True)
    root = f"/api/comms/conversations/{org.conversation}"
    message = _ok(api.post(root + "/messages", json=_payload(URL)), 201)
    identity = work(case, org, message["id"])
    from app.systems.comms.previews.jobs import run_preview_job

    run_preview_job(
        case.world.runtime, org.id, identity, publish=lambda _: None, fetch=lambda _: dict(META)
    )
    current = api.get(root)
    assert (
        api.post(root + "/archive", headers={"If-Match": current.headers["etag"]}).status_code
        == 200
    )
    preview = _ok(api.post(root + "/purge/preview"))
    result = api.post(
        root + "/purge",
        json={
            "token": preview["token"],
            "confirmation_name": preview["confirmation_name"],
            "password": "owned-test-password",
        },
    )
    assert result.status_code == 200
    fetched = []
    run_preview_job(
        case.world.runtime,
        org.id,
        identity,
        publish=lambda _: None,
        fetch=lambda url: fetched.append(url) or dict(META),
    )
    assert fetched == []
    with case.world.session(org) as db:
        assert db.get(CommsMessage, UUID(message["id"])) is None
        assert db.get(ScheduledWork, identity) is None


@pytest.mark.parametrize("generation", [None, 1])
def test_database_rejects_unbound_or_stale_cached_metadata(job_routes, generation):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    message = _ok(
        api.post(f"/api/comms/conversations/{org.conversation}/messages", json=_payload(URL)), 201
    )
    with case.world.session(org) as db:
        row = db.get(CommsMessage, UUID(message["id"]))
        row.link_previews, row.link_preview_generation = [META], generation
        with pytest.raises(IntegrityError):
            db.flush()
        db.rollback()
