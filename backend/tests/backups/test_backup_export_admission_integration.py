"""Current password admission refusals through actual signed-cookie HTTP boundaries."""

from datetime import timedelta

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentityRateLimitBucket, IdentitySession
from app.systems.access.identity.rate_limits import login_fingerprint
from app.systems.access.users.models import User
from tests.backups.test_backup_export_downloads_integration import _stored

pytest_plugins = ("tests.backups.test_backup_export_downloads_integration",)
pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "case", ["wrong-password", "provider-down", "role-loss", "session-loss", "csrf", "bearer"]
)
def test_download_admission_rechecks_after_provider_commit_and_preserves_failure_contract(
    ready_export, case
):
    world = ready_export

    def hook(request):
        if request.url.path == "/auth/v1/token":
            if case == "wrong-password":
                return httpx.Response(400, json={"error": "invalid_credentials"})
            if case == "provider-down":
                return httpx.Response(503)
            if case in {"role-loss", "session-loss"}:
                with Session(world.auth.owner) as db:
                    if case == "role-loss":
                        db.get(User, world.auth.actor_id).role = "member"
                    else:
                        db.get(
                            IdentitySession, world.auth.session_ids[0]
                        ).revoked_at = world.auth.clock
                    db.commit()

    temporary = world.auth.hook
    world.auth.hook = lambda request: hook(request) or temporary(request)
    if case == "csrf":
        world.csrf_headers = {}
    elif case == "bearer":
        world.auth.client.cookies.clear()
        world.csrf_headers = world.auth.headers()
    response = world.admit()
    assert (
        response.status_code
        == {
            "wrong-password": 403,
            "provider-down": 503,
            "role-loss": 403,
            "session-loss": 401,
            "csrf": 401,
            "bearer": 403,
        }[case]
    )
    assert world.auth.password not in response.text
    assert _stored(world)[0].admission_digest is None


def test_current_password_budget_refuses_before_provider_or_admission_write(ready_export):
    world = ready_export
    fingerprint = login_fingerprint(world.auth.email, None)
    world.auth.bucket_ids.append(fingerprint)
    with Session(world.auth.owner) as db:
        now = db.scalar(select(func.clock_timestamp()))
        db.add(
            IdentityRateLimitBucket(
                fingerprint=fingerprint,
                attempt_count=5,
                window_started_at=now,
                blocked_until=now + timedelta(seconds=90),
            )
        )
        db.commit()
    before = world.auth.calls.count(("POST", "/auth/v1/token"))
    refused = world.admit()
    assert refused.status_code == 429 and refused.headers["cache-control"] == "no-store"
    assert refused.json()["detail"]["code"] == "export_password_rate_limited"
    assert world.auth.calls.count(("POST", "/auth/v1/token")) == before
    assert world.auth.password not in refused.text
    row, events = _stored(world)
    assert row.admission_digest is None and not events


@pytest.mark.parametrize("endpoint", ["admission", "content"])
def test_export_row_lock_wait_cannot_admit_a_now_expired_presented_credential(
    ready_export, monkeypatch, endpoint
):
    from concurrent.futures import ThreadPoolExecutor
    from datetime import UTC, datetime
    from threading import Event

    from sqlalchemy import event

    from app.systems.manage.backups import downloads
    from app.systems.manage.backups.models import BackupExportOperation

    world = ready_export
    attempted, prepared, locked = Event(), Event(), Event()
    before = None
    if endpoint == "content":
        assert world.admit().status_code == 200
        before = _stored(world)[0].admission_digest
        original = downloads.prepare_artifact

        def hold_before_consumption(*args, **kwargs):
            archive = original(*args, **kwargs)
            prepared.set()
            assert locked.wait(10), "Real final-consumption blocker was not admitted"
            return archive

        monkeypatch.setattr(downloads, "prepare_artifact", hold_before_consumption)
    deadline = int(datetime.now(UTC).timestamp()) + 3
    world.auth.client.cookies.set("openslate_access", world.auth.access(exp=deadline))
    with Session(world.auth.owner) as blocker:

        def lock_export():
            blocker.scalar(
                select(BackupExportOperation)
                .where(BackupExportOperation.id == world.export_id)
                .with_for_update()
            )
            locked.set()

        if endpoint == "admission":
            lock_export()

        def query_started(connection, cursor, statement, parameters, context, executemany):
            if "backup_export_operations" in statement and "FOR UPDATE" in statement:
                if endpoint == "admission" or locked.is_set():
                    attempted.set()

        event.listen(world.runtime, "before_cursor_execute", query_started)
        try:
            with ThreadPoolExecutor(max_workers=1) as requests:
                admitted = (
                    requests.submit(world.admit)
                    if endpoint == "admission"
                    else requests.submit(
                        world.auth.client.get,
                        world.path + "/content",
                        headers=world.native_headers,
                    )
                )
                try:
                    if endpoint == "content":
                        assert prepared.wait(10), "Real verified artifact boundary was not reached"
                        lock_export()
                    assert attempted.wait(10), "Actual admission export-lock query was not reached"
                    # Await the precise server clock boundary, not an arbitrary delay.
                    blocker.scalar(
                        select(
                            func.pg_sleep(
                                func.greatest(
                                    0.0, deadline - func.extract("epoch", func.clock_timestamp())
                                )
                            )
                        )
                    )
                    assert blocker.scalar(select(func.clock_timestamp())).timestamp() >= deadline
                finally:
                    locked.set()
                    blocker.rollback()
                response = admitted.result(timeout=20)
        finally:
            event.remove(world.runtime, "before_cursor_execute", query_started)
    assert response.status_code == 401
    assert "content-disposition" not in response.headers and response.content != world.content
    row, events = _stored(world)
    if endpoint == "admission":
        assert (
            row.admission_digest,
            row.admission_actor_id,
            row.admission_session_id,
            row.admission_expires_at,
        ) == (None, None, None, None)
    else:
        assert row.admission_digest == before and before is not None
    assert not events


@pytest.mark.parametrize("shape", ["canonical", "compact", "braced", "invalid"])
@pytest.mark.parametrize("chunked", [False, True])
def test_admission_route_family_bounds_secret_body_before_parsing_or_provider(
    ready_export, shape, chunked
):
    world = ready_export
    segment = {
        "canonical": str(world.export_id),
        "compact": world.export_id.hex,
        "braced": "{" + str(world.export_id) + "}",
        "invalid": "not-a-uuid",
    }[shape]
    path = f"/api/backups/exports/{segment}/download-admission"
    body = b'{"password":"' + b"x" * 2000 + b'"}'
    before = world.auth.calls.count(("POST", "/auth/v1/token"))
    response = world.auth.client.post(
        path,
        headers={**world.csrf_headers, "Content-Type": "application/json"},
        content=(part for part in (body[:900], body[900:])) if chunked else body,
    )
    assert response.status_code == 413 and response.headers["cache-control"] == "no-store"
    assert "x" * 128 not in response.text
    assert world.auth.calls.count(("POST", "/auth/v1/token")) == before
    row, events = _stored(world)
    assert row.admission_digest is None and not events
    bounded = world.auth.client.post(
        path,
        headers=world.csrf_headers,
        json={"password": world.auth.password},
    )
    assert bounded.status_code == (422 if shape == "invalid" else 200)
    assert world.auth.password not in bounded.text
    if shape == "invalid":
        assert world.auth.calls.count(("POST", "/auth/v1/token")) == before
        assert _stored(world)[0].admission_digest is None
    else:
        assert f"Path={world.path}/content" in bounded.headers["set-cookie"]
