"""Scheduling admission/lifetime and canonical durable sends on real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import UUID

import pytest
from sqlalchemy import func, select
from uuid6 import uuid7

from app.systems.access.users.models import Membership
from app.systems.comms.messages.models import CommsMessage
from tests.comms.routes.message_support import _ok

pytestmark = pytest.mark.integration
ROOT = "/api/comms/scheduled-messages"
FUTURE = datetime(2100, 1, 1, tzinfo=UTC)


def payload(org, body="Scheduled content"):
    return {
        "conversation_id": str(org.conversation),
        "client_key": str(uuid7()),
        "body": body,
        "send_at": FUTURE.isoformat(),
    }


def test_schedule_edit_cancel_claim_and_canonical_send_are_author_scoped(job_routes):
    case, org = job_routes, job_routes.world.first
    api, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    request = payload(org)
    created = api.post(ROOT, json=request)
    row = _ok(created, 201)
    assert created.headers["location"] == ROOT + "/" + row["id"]
    assert row["status"] == "pending" and row["message_id"] is None
    path = ROOT + "/" + row["id"]
    assert peer.get(path).status_code == 404
    assert api.put(path, json=request).status_code == 428
    edited = api.put(
        path,
        json={**request, "body": "Edited pending content"},
        headers={"If-Match": created.headers["etag"]},
    )
    assert edited.status_code == 200
    assert (
        api.post(path + "/send", headers={"If-Match": created.headers["etag"]}).status_code == 412
    )
    sent = _ok(api.post(path + "/send", headers={"If-Match": edited.headers["etag"]}))
    assert sent["status"] == "succeeded" and sent["failure_code"] is None
    assert sent["request"]["client_key"] == request["client_key"]
    assert (
        _ok(api.get(f"/api/comms/conversations/{org.conversation}/messages/{sent['message_id']}"))[
            "body"
        ]
        == "Edited pending content"
    )
    terminal = api.get(path)
    assert (
        api.post(path + "/cancellation", headers={"If-Match": terminal.headers["etag"]}).status_code
        == 409
    )
    with case.world.session(org) as db:
        assert db.scalar(select(func.count()).select_from(CommsMessage)) == 1
    another = api.post(ROOT, json=payload(org, "Canceled before claim"))
    pending = _ok(another, 201)
    assert (
        _ok(
            api.post(
                ROOT + "/" + pending["id"] + "/cancellation",
                headers={"If-Match": another.headers["etag"]},
            )
        )["status"]
        == "cancelled"
    )


def test_pending_cap_is_100_per_author_org_and_edit_does_not_count_itself(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    first_request = payload(org)
    first = api.post(ROOT, json=first_request)
    source = _ok(first, 201)
    from app.systems.comms.jobs.models import CommsSchedule
    from app.systems.platform.scheduling.models import ScheduledWork, WorkKind

    with case.world.session(org) as db:
        for _ in range(98):
            request = payload(org)
            row = CommsSchedule(
                org_id=org.id,
                author_id=org.author,
                conversation_id=org.conversation,
                client_key=UUID(request["client_key"]),
                request=request,
            )
            db.add(row)
            db.flush()
            db.add(
                ScheduledWork(
                    org_id=org.id,
                    kind=WorkKind.COMMS_SCHEDULED_MESSAGE,
                    comms_schedule_id=row.id,
                    scheduling_actor_id=org.author,
                    source_revision=1,
                    scheduled_for=FUTURE,
                    next_attempt_at=FUTURE,
                )
            )
        db.commit()
    gate = Barrier(2)
    contenders = [case.client(org.author, org.id, request_gate=gate) for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, ROOT, json=payload(org)) for client in contenders]
        responses = [future.result(timeout=30) for future in futures]
    assert sorted(response.status_code for response in responses) == [201, 409]
    refused = next(response for response in responses if response.status_code == 409)
    assert refused.json()["detail"]["code"] == "comms_capacity_reached"
    assert "100" in refused.json()["detail"]["message"]
    assert (
        api.put(
            ROOT + "/" + source["id"],
            json=first_request,
            headers={"If-Match": first.headers["etag"]},
        ).status_code
        == 200
    )
    assert case.client(org.peer, org.id).post(ROOT, json=payload(org)).status_code == 201
    assert (
        case.client(case.world.second.author, case.world.second.id)
        .post(ROOT, json=payload(case.world.second))
        .status_code
        == 201
    )
    from app.systems.comms.jobs.schedule_worker import claim_schedule

    with case.world.session(org) as db:
        claim_schedule(db, UUID(source["id"]), now=datetime.now(UTC), manual=True)
        db.commit()
    assert api.post(ROOT, json=payload(org)).status_code == 201  # RUNNING is not PENDING.


def test_committed_claim_survives_caller_and_refuses_edit_cancel_then_finishes_once(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    request = payload(org)
    created = api.post(ROOT, json=request)
    row = _ok(created, 201)
    from app.systems.comms.jobs.schedule_worker import claim_schedule, execute_schedule_claim

    with case.world.session(org) as db:
        claim = claim_schedule(db, UUID(row["id"]), now=datetime.now(UTC), manual=True)
        db.commit()
    path = ROOT + "/" + row["id"]
    current = api.get(path)
    assert _ok(current)["status"] == "running"
    for method, endpoint, kwargs in (
        ("PUT", path, {"json": request}),
        ("POST", path + "/cancellation", {}),
    ):
        assert (
            api.request(
                method, endpoint, headers={"If-Match": current.headers["etag"]}, **kwargs
            ).status_code
            == 409
        )
    api.close()  # No request/client object is supplied to the committed job.
    events = []
    execute_schedule_claim(case.world.runtime, org.id, claim, publish=events.extend)
    execute_schedule_claim(case.world.runtime, org.id, claim, publish=events.extend)
    result = _ok(case.client(org.author, org.id).get(path))
    assert result["status"] == "succeeded"
    with case.world.session(org) as db:
        assert db.scalar(select(func.count()).select_from(CommsMessage)) == 1
    assert len([row for row in events if row["event"] == "message"]) == 1


def test_schedule_rechecks_author_membership_at_execution(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.peer, org.id)
    created = _ok(api.post(ROOT, json=payload(org)), 201)
    from app.systems.comms.jobs.schedule_worker import claim_schedule, execute_schedule_claim

    with case.world.session(org) as db:
        claim = claim_schedule(db, UUID(created["id"]), now=datetime.now(UTC), manual=True)
        db.commit()
    with case.world.session(org) as db:
        membership = db.scalars(
            select(Membership).where(Membership.org_id == org.id, Membership.user_id == org.peer)
        ).one()
        membership.status = "disabled"
        db.commit()
    execute_schedule_claim(case.world.runtime, org.id, claim, publish=lambda _rows: None)
    from app.systems.platform.scheduling.models import ScheduledWork

    with case.world.session(org) as db:
        work = db.scalars(
            select(ScheduledWork).where(ScheduledWork.comms_schedule_id == UUID(created["id"]))
        ).one()
        assert work.state == "failed" and work.failure_code == "access_lost"
        assert db.scalar(select(func.count()).select_from(CommsMessage)) == 0


def test_expired_claim_recovery_fences_old_worker_and_concurrent_duplicate_execution(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    created = _ok(api.post(ROOT, json=payload(org)), 201)
    from app.systems.comms.jobs.schedule_worker import claim_schedule, execute_schedule_claim
    from app.systems.platform.scheduling.models import ScheduledWork

    with case.world.session(org) as db:
        stale = claim_schedule(db, UUID(created["id"]), now=datetime.now(UTC), manual=True)
        db.commit()
    with case.world.session(org) as db:
        db.get(ScheduledWork, stale.id).lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    with case.world.session(org) as db:
        recovered = claim_schedule(db, UUID(created["id"]), now=datetime.now(UTC))
        db.commit()
    assert execute_schedule_claim(case.world.runtime, org.id, stale, publish=lambda _: None) is None
    gate, events = Barrier(2), []

    def complete():
        gate.wait(timeout=10)
        return execute_schedule_claim(case.world.runtime, org.id, recovered, publish=events.extend)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(complete) for _ in range(2)]
        results = [future.result(timeout=30) for future in futures]
    assert len([value for value in results if value is not None]) == 1
    assert len([row for row in events if row["event"] == "message"]) == 1
    with case.world.session(org) as db:
        assert db.scalar(select(func.count()).select_from(CommsMessage)) == 1
        assert db.get(ScheduledWork, recovered.id).state == "succeeded"


def test_send_result_finalization_failure_rolls_back_the_message_and_counter(job_routes):
    case, org = job_routes, job_routes.world.first
    api = case.client(org.author, org.id)
    created = api.post(ROOT, json=payload(org))
    source = _ok(created, 201)
    from sqlalchemy import event

    from app.core.database.session import AuditSession
    from app.systems.comms.messages.models import CommsConversationCounter
    from app.systems.platform.scheduling.models import ScheduledWork

    def unavailable(db, _context, _instances):
        if any(isinstance(row, ScheduledWork) and row.state == "succeeded" for row in db.dirty):
            raise RuntimeError("Controlled finalization failure before the shared commit")

    event.listen(AuditSession, "before_flush", unavailable)
    try:
        result = _ok(
            api.post(
                ROOT + "/" + source["id"] + "/send", headers={"If-Match": created.headers["etag"]}
            )
        )
    finally:
        event.remove(AuditSession, "before_flush", unavailable)
    assert result["status"] == "failed" and result["message_id"] is None
    with case.world.session(org) as db:
        assert db.scalar(select(func.count()).select_from(CommsMessage)) == 0
        assert (
            db.scalar(
                select(CommsConversationCounter.last_seq).where(
                    CommsConversationCounter.conversation_id == org.conversation,
                )
            )
            == 0
        )
