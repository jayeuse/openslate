"""PostgreSQL-backed admin journeys for real backup metadata, never backup execution."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.systems.access.users.models import UserRole
from tests.rbac.support import _client, add_user
from tests.route_app_support import route_app


def test_unauthenticated_backup_status_is_denied() -> None:
    client = TestClient(route_app())
    response = client.get("/api/backups/status")
    assert response.status_code == 401


@pytest.mark.integration
def test_admin_defaults_save_reload_and_durable_queue_replay(integration_db: Session) -> None:
    admin = add_user(integration_db, role=UserRole.ADMIN)
    with _client(route_app(), admin, integration_db) as client:
        before = client.get("/api/backups/status")
        assert before.status_code == 200
        assert before.headers["cache-control"] == "no-store"
        policy = before.json()["policy"]
        assert policy["schedule"] == "disabled" and policy["retention_days"] == 30
        assert policy["revision"] == 1 and policy["next_due_at"] is None
        assert before.json()["runner"] == {"state": "unknown", "last_seen_at": None}
        assert integration_db.connection().scalar(text("SELECT count(*) FROM backup_policies")) == 0
        saved = client.patch(
            "/api/backups/status", json={"revision": 1, "schedule": "daily", "retention_days": 7}
        )
        assert saved.status_code == 200
        assert saved.json()["policy"]["revision"] == 2
        assert saved.json()["policy"]["next_due_at"] is not None
        assert client.get("/api/backups/status").json() == saved.json()
        stale = client.patch("/api/backups/status", json={"revision": 1, "schedule": "weekly"})
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_revision"
        assert client.get("/api/backups/status").json()["policy"] == saved.json()["policy"]

        first = client.post(
            "/api/backups", json={"name": "Before review"}, headers={"Idempotency-Key": "review-1"}
        )
        assert first.status_code == 201
        run = first.json()
        assert run["state"] == "queued" and run["installation"] == "current"
        assert run["snapshot_id"] is None and run["reconciled_at"] is None
        assert run["schedule"] == "daily" and run["retention_days"] == 7
        replay = client.post(
            "/api/backups", json={"name": "Before review"}, headers={"Idempotency-Key": "review-1"}
        )
        assert replay.status_code == 201 and replay.json() == run
        conflict = client.post(
            "/api/backups", json={"name": "Another name"}, headers={"Idempotency-Key": "review-1"}
        )
        assert conflict.status_code == 409
        listed = client.get(first.headers["location"])
        assert listed.status_code == 200 and listed.json()["items"] == [run]
        assert listed.json()["pagination"]["total"] == 1
        assert client.get("/api/backups/status").json()["queued_count"] == 1
        version = client.get("/api/version")
        assert version.status_code == 200 and version.headers["cache-control"] == "no-store"
        assert version.json()["current_version"] == client.app.version
        assert version.json()["status"] == "unknown" and version.json()["checked_at"] is None


@pytest.mark.integration
@pytest.mark.parametrize("role", (UserRole.MEMBER, UserRole.GUEST))
def test_non_admin_cannot_read_or_write_backup_authority(
    integration_db: Session, role: str
) -> None:
    actor = add_user(integration_db, role=role)
    with _client(route_app(), actor, integration_db) as client:
        responses = [
            client.get("/api/backups/status"),
            client.get("/api/backups"),
            client.get("/api/version"),
            client.patch("/api/backups/status", json={"revision": 1, "schedule": "daily"}),
            client.post(
                "/api/backups", json={"name": "Denied"}, headers={"Idempotency-Key": "denied"}
            ),
        ]
    assert [response.status_code for response in responses] == [403] * 5
    assert integration_db.connection().scalar(text("SELECT count(*) FROM backup_policies")) == 0
    assert integration_db.connection().scalar(text("SELECT count(*) FROM backup_runs")) == 0


@pytest.mark.integration
@pytest.mark.parametrize(
    "payload",
    (
        {"revision": 1},
        {"revision": True, "schedule": "daily"},
        {"revision": "1", "schedule": "daily"},
        {"revision": 1, "schedule": "hourly"},
        {"revision": 1, "retention_days": 14},
        {"revision": 1, "retention_days": "7"},
        {"revision": 1, "schedule": None},
        {"revision": 1, "installation_id": "foreign"},
    ),
)
def test_policy_invalid_inputs_make_no_partial_write(
    integration_db: Session, payload: dict
) -> None:
    admin = add_user(integration_db, role=UserRole.ADMIN)
    with _client(route_app(), admin, integration_db) as client:
        assert client.patch("/api/backups/status", json=payload).status_code == 422
    assert integration_db.connection().scalar(text("SELECT count(*) FROM backup_policies")) == 0


@pytest.mark.integration
def test_admin_can_turn_a_schedule_back_off(integration_db: Session) -> None:
    # Found by a live sample run: disabling a schedule failed with 503.
    admin = add_user(integration_db, role=UserRole.ADMIN)
    with _client(route_app(), admin, integration_db) as client:
        saved = client.patch(
            "/api/backups/status", json={"revision": 1, "schedule": "daily", "retention_days": 7}
        )
        assert saved.status_code == 200
        disabled = client.patch(
            "/api/backups/status",
            json={"revision": 2, "schedule": "disabled", "retention_days": 30},
        )
        assert disabled.status_code == 200
        policy = disabled.json()["policy"]
        assert policy["schedule"] == "disabled" and policy["next_due_at"] is None


@pytest.mark.integration
def test_history_uses_literal_search_pagination_and_safe_filters(integration_db: Session) -> None:
    admin = add_user(integration_db, role=UserRole.ADMIN)
    with _client(route_app(), admin, integration_db) as client:
        for index, name in enumerate(("literal_% one", "literal_% two", "literalXX decoy")):
            assert (
                client.post(
                    "/api/backups",
                    json={"name": name},
                    headers={"Idempotency-Key": f"literal-{index}"},
                ).status_code
                == 201
            )
        pages = [
            client.get(
                "/api/backups",
                params={"search": "literal_%", "limit": 1, "offset": n, "sort_by": "name"},
            ).json()
            for n in range(2)
        ]
        assert [page["pagination"]["total"] for page in pages] == [2, 2]
        assert {page["items"][0]["name"] for page in pages} == {"literal_% one", "literal_% two"}
        assert [page["pagination"]["has_more"] for page in pages] == [True, False]
        assert client.get("/api/backups", params={"state": "succeeded"}).json()["items"] == []
        assert client.get("/api/backups", params={"sort_by": "repository_path"}).status_code == 422
        assert client.get("/api/backups", params={"deleted": "include"}).status_code == 422
        assert client.get("/api/backups", params={"run_id": "invalid"}).status_code == 422
        assert client.post("/api/backups", json={"name": "Missing key"}).status_code == 422
        assert (
            client.post(
                "/api/backups", json={"name": "bad\nname"}, headers={"Idempotency-Key": "bad-name"}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/backups",
                json={"name": "Unsafe key"},
                headers={"Idempotency-Key": "spaces unsafe"},
            ).status_code
            == 422
        )
