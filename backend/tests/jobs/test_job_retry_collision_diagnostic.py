"""Public backup keys cannot replace the intended Jobs retry and its event linkage."""

import hashlib
import json
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import create_app
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.backups.models import BackupRun
from tests.jobs.job_route_support import failed_jobs
from tests.jobs.test_job_routes import _client
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("same_name", (False, True), ids=("different-name", "same-name"))
def test_backup_retry_isolates_public_preoccupation_and_replays_the_intended_run(
    integration_owner_db: Session,
    same_name: bool,
) -> None:
    db = integration_owner_db
    original = failed_jobs(db)["backup"]
    assert isinstance(original, BackupRun)
    admin = add_user(db, role="admin")
    external_key = "owned-retry-linkage"
    ordinary_key = hashlib.sha256(
        f"job.retry:backup:{original.id}:{external_key}".encode("ascii")
    ).hexdigest()

    with _client(create_app(), admin, db) as client:
        occupied = client.post(
            "/api/backups",
            json={"name": original.name if same_name else "Unrelated ordinary API backup"},
            headers={"Idempotency-Key": ordinary_key},
        )
        assert occupied.status_code == 201
        unrelated_id = UUID(occupied.json()["id"])
        assert unrelated_id != original.id

        retried = client.post(
            f"/api/jobs/backup/{original.id}/retry",
            headers={"Idempotency-Key": external_key},
        )
        body = retried.json()
        replayed = client.post(
            f"/api/jobs/backup/{original.id}/retry",
            headers={"Idempotency-Key": external_key},
        )
        replay_body = replayed.json()

    events = list(
        db.scalars(
            select(SecurityEvent).where(
                SecurityEvent.event_type == "job.retry",
                SecurityEvent.actor_id == admin.id,
            )
        )
    )
    evidence = {
        "original_failed_run_id": str(original.id),
        "ordinary_api_run_id": str(unrelated_id),
        "jobs_retry_status": retried.status_code,
        "jobs_retry_returned_id": body.get("id") if isinstance(body, dict) else None,
        "jobs_replay_status": replayed.status_code,
        "jobs_replay_returned_id": replay_body.get("id") if isinstance(replay_body, dict) else None,
        "ordinary_name_matches_original": same_name,
        "job_retry_events": [
            {
                "id": str(event.id),
                "subject_id": str(event.subject_id),
                "result_id": event.event_metadata.get("result_id"),
            }
            for event in events
        ],
    }
    safe_evidence = json.dumps(evidence, sort_keys=True)
    print("SAFE_JOB_RETRY_LINKAGE=" + safe_evidence)

    assert retried.status_code == replayed.status_code == 201, safe_evidence
    new_id = UUID(body["id"])
    assert new_id not in {original.id, unrelated_id}, safe_evidence
    assert body["subject_label"] == original.name and body["state"] == "queued"
    assert replay_body["id"] == str(new_id), safe_evidence
    assert len(events) == 1, safe_evidence
    event = events[0]
    assert event.actor_id == admin.id and event.subject_id == original.id
    assert event.outcome == "success" and event.event_metadata == {
        "kind": "backup",
        "result_id": str(new_id),
    }
    queued = db.get(BackupRun, new_id)
    assert queued is not None and queued.name == original.name
    assert queued.provenance == "manual" and queued.requester_id == admin.id
    admitted = list(db.scalars(select(BackupRun).where(BackupRun.requester_id == admin.id)))
    assert {run.id for run in admitted} == {unrelated_id, new_id}, safe_evidence
    db.refresh(original)
    assert original.state == "failed" and original.failure_code == "backup_failed"
