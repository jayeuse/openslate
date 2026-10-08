"""Administrator Jobs journeys against guarded disposable PostgreSQL."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.main import create_app
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.backups.models import BackupRun
from app.systems.platform.scheduling.models import ScheduledWork
from tests.jobs.job_route_support import NOW, failed_jobs
from tests.rbac.support import _client as request_client
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration


def _client(application, user: User, db: Session):
    # Requests own their rollback; fixture admission must already be durable.
    db.commit()
    return request_client(application, user, db)


def test_jobs_union_pages_every_kind_with_global_totals_and_safe_subjects(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    jobs = failed_jobs(db, shared_id=uuid7())
    admin = add_user(db, role="admin")
    with _client(create_app(), admin, db) as client:
        pages = [client.get("/api/jobs", params={"limit": 1, "offset": i}) for i in range(4)]
    assert all(page.status_code == 200 for page in pages), [page.status_code for page in pages]
    rows = [page.json()["items"][0] for page in pages]
    assert {(row["kind"], row["id"]) for row in rows} == {
        (kind, str(job.id)) for kind, job in jobs.items()
    }
    for index, response in enumerate(pages):
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["pagination"] == {
            "limit": 1,
            "offset": index,
            "count": 1,
            "total": 4,
            "has_more": index < 3,
        }
    assert all(row["state"] == "failed" and row["can_retry"] for row in rows)
    assert all(row["failure_label"] and row["next_attempt_at"] is None for row in rows)
    assert all(row["last_attempt_at"] == NOW.isoformat().replace("+00:00", "Z") for row in rows)
    assert (
        next(row for row in rows if row["kind"] == "report-run")["subject_label"]
        == "Literal_% report"
    )
    assert (
        next(row for row in rows if row["kind"] == "backup")["subject_link"]
        == "/manage?view=backup"
    )


def test_jobs_failed_priority_literal_search_and_global_date_filters(integration_owner_db: Session):
    db = integration_owner_db
    jobs = failed_jobs(db)
    report_work = jobs["report-run"]
    pending = ScheduledWork(
        report_id=report_work.report_id,
        scheduled_for=NOW + timedelta(days=1),
        next_attempt_at=NOW + timedelta(days=1),
    )
    db.add(pending)
    db.flush()
    with _client(create_app(), add_user(db, role="admin"), db) as client:
        default = client.get("/api/jobs").json()
        assert [row["state"] for row in default["items"]] == ["failed"] * 4 + ["pending"]
        literal = client.get("/api/jobs", params={"search": "_%", "limit": 1}).json()
        assert literal["pagination"]["total"] == 2
        assert literal["items"][0]["id"] == str(report_work.id)
        bounded = client.get(
            "/api/jobs",
            params={
                "scheduled_after": NOW.isoformat(),
                "scheduled_before": (NOW + timedelta(seconds=1)).isoformat(),
            },
        ).json()
        assert bounded["pagination"]["total"] == 4
        assert {row["kind"] for row in bounded["items"]} == set(jobs)
        filtered = client.get("/api/jobs", params={"kind": "backup", "state": "failed"}).json()
        assert [row["id"] for row in filtered["items"]] == [str(jobs["backup"].id)]
        sorted_rows = client.get(
            "/api/jobs", params={"sort_by": "scheduled_for", "sort_order": "desc"}
        ).json()["items"]
        assert sorted_rows[0]["id"] == str(pending.id)
        assert sorted_rows[-1]["kind"] == "backup" and sorted_rows[-1]["scheduled_for"] is None


@pytest.mark.parametrize(
    "params",
    (
        {"kind": "future-kind"},
        {"state": "unknown"},
        {"sort_by": "unsafe"},
        {"scheduled_after": "2027-01-01T00:00:00"},
        {"scheduled_after": NOW.isoformat(), "scheduled_before": NOW.isoformat()},
        {"deleted": "include"},
        {"limit": 101},
    ),
)
def test_jobs_invalid_filters_are_422(integration_owner_db: Session, params: dict):
    with _client(
        create_app(), add_user(integration_owner_db, role="admin"), integration_owner_db
    ) as client:
        assert client.get("/api/jobs", params=params).status_code == 422


@pytest.mark.parametrize("role", ("member", "guest"))
def test_non_admin_cannot_list_or_retry_and_leaves_work_unchanged(
    integration_owner_db: Session, role: str
):
    db = integration_owner_db
    jobs = failed_jobs(db)
    actor = add_user(db, role=role)
    db.commit()
    with _client(create_app(), actor, db) as client:
        assert client.get("/api/jobs").status_code == 403
        assert client.post(f"/api/jobs/report-run/{jobs['report-run'].id}/retry").status_code == 403
    db.expire_all()
    assert jobs["report-run"].state == "failed"
    assert (
        list(db.scalars(select(SecurityEvent).where(SecurityEvent.event_type == "job.retry"))) == []
    )


def test_registered_read_only_kind_needs_only_one_entry(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
):
    from sqlalchemy import literal

    from app.systems.manage.jobs import registry

    db = integration_owner_db
    failed_jobs(db)
    original = registry.REGISTRY["report-run"]

    def query(instance):
        source = original.query(instance).subquery()
        return select(
            *(
                literal("read-only-report").label("kind") if column.key == "kind" else column
                for column in source.c
            )
        )

    monkeypatch.setitem(
        registry.REGISTRY,
        "read-only-report",
        registry.JobKind(
            "Read-only report",
            query,
            original.subject,
            None,
            original.states,
        ),
    )
    with _client(create_app(), add_user(db, role="admin"), db) as client:
        response = client.get("/api/jobs", params={"kind": "read-only-report"})
        assert response.status_code == 200
        [row] = response.json()["items"]
        assert row["kind"] == "read-only-report" and row["can_retry"] is False
        assert client.post(f"/api/jobs/read-only-report/{row['id']}/retry").status_code == 409


def test_jobs_require_authentication():
    with TestClient(create_app()) as client:
        assert client.get("/api/jobs").status_code == 401
        assert client.post(f"/api/jobs/report-run/{uuid7()}/retry").status_code == 401


@pytest.mark.parametrize("kind", ("report-run", "post-publish", "event-reminder"))
def test_scheduled_retry_resets_same_occurrence_and_records_one_atomic_event(
    integration_owner_db: Session, kind: str
):
    db = integration_owner_db
    work = failed_jobs(db)[kind]
    prior_start, occurrence = work.last_attempt_started_at, work.scheduled_for
    admin = add_user(db, role="admin")
    with _client(create_app(), admin, db) as client:
        path = f"/api/jobs/{kind}/{work.id}/retry"
        response = client.post(path)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["id"] == str(work.id) and result["state"] == "pending"
        assert result["attempts"] == 0 and result["failure_code"] is None
        assert client.post(path).status_code == 409
    db.expire_all()
    assert work.state == "pending" and work.attempt_count == 0
    assert work.scheduled_for == occurrence and work.last_attempt_started_at == prior_start
    assert work.finished_at is None and work.failure_code is None
    assert work.lease_token is None and work.lease_expires_at is None
    assert work.next_attempt_at >= NOW - timedelta(days=200)
    [event] = list(db.scalars(select(SecurityEvent).where(SecurityEvent.event_type == "job.retry")))
    assert event.actor_id == admin.id and event.subject_id == work.id and event.outcome == "success"
    assert event.event_metadata["kind"] == kind


def test_backup_retry_queues_new_run_with_durable_replay_and_preserves_failed_run(
    integration_owner_db: Session,
):
    db = integration_owner_db
    original = failed_jobs(db)["backup"]
    admin = add_user(db, role="admin")
    with _client(create_app(), admin, db) as client:
        path = f"/api/jobs/backup/{original.id}/retry"
        assert client.post(path).status_code == 422
        first = client.post(path, headers={"Idempotency-Key": "owned-retry"})
        assert first.status_code == 201, first.text
        replay = client.post(path, headers={"Idempotency-Key": "owned-retry"})
        assert replay.status_code == 201 and replay.json() == first.json()
        assert first.json()["id"] != str(original.id) and first.json()["state"] == "queued"
    db.expire_all()
    assert original.state == "failed" and original.failure_code == "backup_failed"
    runs = list(db.scalars(select(BackupRun)))
    assert len(runs) == 2
    assert (
        len(list(db.scalars(select(SecurityEvent).where(SecurityEvent.event_type == "job.retry"))))
        == 1
    )


@pytest.mark.parametrize(
    "state,code",
    (
        ("canceled", "source_unavailable"),
        ("failed", "source_unavailable"),
        ("pending", "run_failed"),
    ),
)
def test_ineligible_work_cannot_retry(integration_owner_db: Session, state: str, code: str):
    db = integration_owner_db
    work = failed_jobs(db)["report-run"]
    work.state, work.failure_code = state, code
    db.flush()
    with _client(create_app(), add_user(db, role="admin"), db) as client:
        row = next(
            row for row in client.get("/api/jobs").json()["items"] if row["id"] == str(work.id)
        )
        assert row["can_retry"] is False
        assert client.post(f"/api/jobs/report-run/{work.id}/retry").status_code == 409


def test_event_failure_rolls_back_retry(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
):
    from sqlalchemy.exc import SQLAlchemyError

    from app.systems.manage.jobs import router

    db = integration_owner_db
    work = failed_jobs(db)["report-run"]
    admin = add_user(db, role="admin")
    db.commit()

    def reject(*args, **kwargs):
        raise SQLAlchemyError("owned event persistence failure")

    monkeypatch.setattr(router, "append_security_event", reject)
    with _client(create_app(), admin, db) as client:
        assert client.post(f"/api/jobs/report-run/{work.id}/retry").status_code == 503
    db.expire_all()
    assert work.state == "failed" and work.attempt_count == 5 and work.finished_at is not None
    assert (
        list(db.scalars(select(SecurityEvent).where(SecurityEvent.event_type == "job.retry"))) == []
    )
