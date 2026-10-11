"""Published occurrences notify current admins atomically without snapshot hydration."""

from functools import partial
from hashlib import sha256

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users.models import UserRole, UserStatus
from app.systems.platform.scheduling.models import InAppNotification
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.service import (
    create_version,
    export_bundle,
    import_bundle,
    read_document,
    replace_document,
)
from app.systems.sandbox.publications.executor import PublicationError
from app.systems.sandbox.publications.models import SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from tests.platform_scheduling.test_notification_routes import _client
from tests.rbac.support import add_user
from tests.sandbox_publications.support import publish_saved, publishable_document

pytestmark = pytest.mark.integration


def _prepared(db, publisher):
    """Return one reviewed publication request; calling it again replays the same request."""
    current = read_document(db)
    plan = publication_plan(db, current.document)
    assert not plan.blockers
    token = sha256(uuid7().bytes).hexdigest()
    return partial(
        publish_saved,
        db,
        publisher.id,
        current,
        plan,
        token_digest=token,
        idempotency_key=str(uuid7()),
    )


@pytest.mark.parametrize("fail_commit", [False, True])
def test_fresh_publications_notify_eligible_admins_once_with_atomic_rollback(
    integration_owner_db, monkeypatch, fail_commit
):
    db = integration_owner_db
    publisher, other = add_user(db, role=UserRole.ADMIN), add_user(db, role=UserRole.ADMIN)
    add_user(db, role=UserRole.ADMIN, status=UserStatus.DISABLED)
    add_user(db, role=UserRole.ADMIN, status=UserStatus.PENDING)
    add_user(db, role=UserRole.MEMBER)
    initial = read_document(db)
    replace_document(
        db,
        actor_id=publisher.id,
        expected_revision=initial.revision,
        document=publishable_document(),
    )
    first = _prepared(db, publisher)
    if fail_commit:

        def reject():
            db.flush()
            raise IntegrityError("controlled publication persistence failure", {}, RuntimeError())

        monkeypatch.setattr(db, "commit", reject)
        with pytest.raises(PublicationError) as failed:
            first()
        assert failed.value.code == "publication_unavailable"
        assert list(db.scalars(select(SandboxPublication))) == []
        assert list(db.scalars(select(InAppNotification))) == []
        return
    result = first()
    assert first().id == result.id
    next_result = _prepared(db, publisher)()
    assert next_result.version.id != result.version.id
    notices = list(db.scalars(select(InAppNotification)))
    assert {(n.recipient_id, n.subject_id) for n in notices} == {
        (recipient, version)
        for recipient in (publisher.id, other.id)
        for version in (result.version.id, next_result.version.id)
    }
    assert len(notices) == 4
    assert all(
        n.kind == "sandbox-published" and n.subject_type == "sandbox_version" and n.work_id is None
        for n in notices
    )
    client = _client(db, other)
    sql = []

    def capture(_conn, _cursor, statement, _parameters, _context, _many):
        sql.append(statement)

    event.listen(db.bind, "before_cursor_execute", capture)
    try:
        pages = [client.get(f"/api/notifications?limit=1&offset={offset}") for offset in (0, 1)]
        assert all(page.status_code == 200 for page in pages), [page.text for page in pages]
        items = [page.json()["items"][0] for page in pages]
        assert {item["version_sequence"] for item in items} == {
            result.version.sequence,
            next_result.version.sequence,
        }
        assert all(item["scheduled_for"] is None and "snapshot" not in item for item in items)
        assert client.get("/api/notifications/unread-count").json() == {"unread_count": 2}
    finally:
        event.remove(db.bind, "before_cursor_execute", capture)
    assert not any("sandbox_versions.snapshot" in query for query in sql)
    assert client.post("/api/notifications/read-all").json() == {"updated_count": 2}
    notice_id = next(n.id for n in notices if n.recipient_id == other.id)
    other.role = UserRole.MEMBER.value
    db.commit()
    assert client.get("/api/notifications").json()["items"] == []
    assert client.get("/api/notifications/unread-count").json() == {"unread_count": 0}
    assert client.post("/api/notifications/read-all").json() == {"updated_count": 0}
    assert client.post(f"/api/notifications/{notice_id}/read").status_code == 404
    other.role = UserRole.ADMIN.value
    version = db.get(SandboxVersion, result.version.id)
    version.is_deleted = True
    db.commit()
    assert client.get("/api/notifications").json()["pagination"]["total"] == 1


def test_checkpoint_and_import_are_not_publication_occurrences(integration_owner_db):
    db = integration_owner_db
    publisher = add_user(db, role=UserRole.ADMIN)
    current = read_document(db)
    create_version(
        db,
        actor_id=publisher.id,
        expected_revision=current.revision,
        kind="checkpoint",
        label="Private draft",
        note=None,
    )
    current = read_document(db)
    import_bundle(
        db,
        actor_id=publisher.id,
        expected_revision=current.revision,
        bundle=export_bundle(db, include_versions=False),
    )
    assert list(db.scalars(select(InAppNotification))) == []
