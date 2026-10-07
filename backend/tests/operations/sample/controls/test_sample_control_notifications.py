"""Owned recipient controls use real transport receipts and never replay writes."""

from __future__ import annotations

import copy
from dataclasses import replace
from datetime import date
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest

from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.controls import notifications
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.reads import plan_read_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.phases.plan import plan_phases
from operations.sample.scenario import build_dataset

PRIMARY = str(UUID(int=201))
OBSERVER = str(UUID(int=202))
ADMIN = str(UUID(int=999))
STAMP = "2026-10-01T08:00:00Z"
READ_STAMP = "2026-10-01T09:00:00Z"
ROUTES = frozenset(
    {
        ("GET", "/api/notifications"),
        ("GET", "/api/notifications/unread-count"),
        ("POST", "/api/notifications/{notification_id}/read"),
        ("POST", "/api/notifications/read-all"),
    }
)


def _dataset(pack: str = "harbor"):
    return build_dataset(
        "small", seed=42, anchor_date=date(2026, 10, 1), organization=get_pack(pack)
    )


@pytest.mark.parametrize("pack", ("harbor", "school"))
def test_plan_uses_owned_assignment_recipients_and_existing_action_kind(pack: str) -> None:
    dataset = _dataset(pack)
    actions = notifications.plan_notification_controls(dataset)
    assert len(actions) == 1
    action = actions[0]
    assert action.kind == "platform_controls"
    assert action.values["operation"] == "review_notifications"
    assert action.actor_key == action.target_key != "admin"
    observer = action.values["observer_key"]
    assert observer != action.actor_key and observer != "admin"
    excluded = {key for row in plan_phases(dataset) for key in (row.actor_key, row.target_key)} | {
        plan_account_controls(dataset)[0].actor_key,
        plan_read_controls(dataset)[0].target_key,
    }
    for key in (action.actor_key, observer):
        person = next(person for person in dataset.organization.actors.people if person.key == key)
        assert person.role == "member" and person.status == "active" and key not in excluded
        sources = [record for record in dataset.records if record.assignee_key == key]
        assert len(sources) >= 2
        assert all(f"@user:{key}" in record.data.values() for record in sources)
    assert notifications.CONTROL_ROUTES == ROUTES
    renamed = replace(
        dataset,
        organization=replace(
            dataset.organization,
            identity=replace(dataset.organization.identity, key="renamed-owned-pack"),
        ),
    )
    assert notifications.plan_notification_controls(renamed) == actions


def test_plan_stops_without_two_owned_assignment_notice_sources() -> None:
    dataset = _dataset()
    unassigned = tuple(
        replace(
            record,
            data={
                key: value
                for key, value in record.data.items()
                if not isinstance(value, str) or not value.startswith("@user:")
            },
        )
        for record in dataset.records
    )
    with pytest.raises(ValueError, match="notification|assignment|recipient"):
        notifications.plan_notification_controls(replace(dataset, records=unassigned))


class NotificationServer:
    def __init__(self, dataset, action, fault: str | None = None) -> None:
        self.action, self.fault = action, fault
        self.other_key = action.values["observer_key"]
        self.identities = {action.actor_key: PRIMARY, self.other_key: OBSERVER}
        self.subjects = {}
        self.modules = {}
        self.profiles = {}
        self.rows = {}
        self.requests = []
        self.writes = []
        self.pages = []
        self.before = {}
        self.fault_used = False
        for actor_index, (key, actor_id) in enumerate(self.identities.items()):
            person = next(
                person for person in dataset.organization.actors.people if person.key == key
            )
            self.profiles[actor_id] = {
                "id": actor_id,
                "email": person.email,
                "username": person.username,
                "role": "member",
                "status": "active",
                "display_name": person.name,
                "job_title": person.title,
                "sponsor_user_id": None,
                "expires_at": None,
                "invitation_sent_at": STAMP,
                "created_at": STAMP,
                "updated_at": STAMP,
                "deleted_at": None,
                "is_deleted": False,
                "performed_by": ADMIN,
                "access": [],
            }
            assigned = [record for record in dataset.records if record.assignee_key == key][:2]
            ids = []
            for index, record in enumerate(assigned):
                identifier = str(UUID(int=301 + actor_index * 10 + index))
                self.subjects[record.logical_id] = identifier
                self.modules.setdefault(record.module_key, str(UUID(int=501 + len(self.modules))))
                ids.append((identifier, self.modules[record.module_key]))
            self.rows[actor_id] = [
                {
                    "id": str(UUID(int=1001 + actor_index * 100 + index)),
                    "kind": "record-assigned",
                    "subject_type": "record",
                    "subject_id": ids[index % 2][0],
                    "module_id": ids[index % 2][1],
                    "status": "read" if actor_id == PRIMARY and index == 27 else "unread",
                    "created_at": STAMP,
                    "scheduled_for": None,
                    "read_at": READ_STAMP if actor_id == PRIMARY and index == 27 else None,
                }
                for index in range(28 if actor_id == PRIMARY else 2)
            ]
        self.before = copy.deepcopy(self.rows)

    def response(self, body, status: int = 200):
        return httpx.Response(status, json=body, headers={"X-Request-ID": str(uuid4())})

    def handle(self, actor_id: str, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.path
        if path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers=[
                    ("Set-Cookie", f"openslate_access=fixture-{actor_id}; Path=/; HttpOnly"),
                    ("Set-Cookie", "openslate_csrf=fixture-csrf; Path=/"),
                ],
            )
        self.requests.append((actor_id, method, path))
        if path == "/api/auth/me":
            identifier = (
                OBSERVER if self.fault == "wrong_identity" and actor_id == PRIMARY else actor_id
            )
            return self.response({**self.profiles[actor_id], "id": identifier})
        if path == "/api/notifications/unread-count":
            count = sum(row["status"] == "unread" for row in self.rows[actor_id])
            if actor_id == PRIMARY:
                if self.fault == "bool_count":
                    count = True
                elif self.fault == "wrong_count":
                    count += 1
                elif self.fault == "one_count_unchanged" and len(self.writes) == 1:
                    count = 27
            return self.response({"unread_count": count})
        if path == "/api/notifications" and method == "GET":
            assert set(request.url.params) <= {"limit", "offset", "sort_order", "status"}
            limit, offset = int(request.url.params["limit"]), int(request.url.params["offset"])
            assert limit == 25
            self.pages.append((actor_id, offset))
            rows = copy.deepcopy(self.rows[actor_id])
            page = {
                "limit": limit,
                "offset": offset,
                "count": len(rows[offset : offset + limit]),
                "total": len(rows),
                "has_more": offset + limit < len(rows),
            }
            items = rows[offset : offset + limit]
            if actor_id == PRIMARY and not self.writes:
                if self.fault == "malformed_page":
                    page["limit"] = True
                elif self.fault == "incomplete_page":
                    items, page["count"] = [], 0
                elif self.fault == "wrong_offset":
                    page["offset"] = offset + 1
                elif self.fault == "changed_total" and offset:
                    page["total"] += 1
                elif self.fault == "duplicate_notice" and offset:
                    items[0] = rows[0]
                elif self.fault == "wrong_subject":
                    items[0]["subject_id"] = str(UUID(int=777))
                elif self.fault == "private_recipient_notice":
                    items[0] = copy.deepcopy(self.rows[OBSERVER][0])
                elif self.fault == "invalid_read_status":
                    items[0]["status"] = "read"
                elif self.fault == "list_unavailable":
                    return self.response({"detail": "Synthetic unavailable"}, 503)
            return self.response({"items": items, "pagination": page})
        assert method == "POST" and actor_id == PRIMARY
        assert request.content == b"" and request.url.query == b""
        assert request.headers["x-csrf-token"] == "fixture-csrf"
        self.writes.append((actor_id, path))
        if path == "/api/notifications/read-all":
            unread = [row for row in self.rows[PRIMARY] if row["status"] == "unread"]
            for row in unread:
                if self.fault != "incomplete_read_all":
                    row.update(status="read", read_at=READ_STAMP)
            if self.fault == "changed_other_recipient":
                self.rows[OBSERVER][0].update(status="read", read_at=READ_STAMP)
            if self.fault == "unknown_read_all":
                raise httpx.ReadError("Synthetic lost read-all response", request=request)
            return self.response(
                {"updated_count": 99 if self.fault == "wrong_updated_count" else 26}
            )
        identifier = path.removeprefix("/api/notifications/").removesuffix("/read")
        row = next(row for row in self.rows[PRIMARY] if row["id"] == identifier)
        assert row["status"] == "unread"
        row.update(status="read", read_at=READ_STAMP)
        if self.fault == "unknown_mark_one":
            raise httpx.ReadError("Synthetic lost mark-read response", request=request)
        result = copy.deepcopy(row)
        if self.fault == "wrong_marked_id":
            result["id"] = str(UUID(int=888))
        elif self.fault == "unconfirmed_read":
            result.update(status="unread", read_at=None)
        return self.response(result)


def _setup(tmp_path: Path, request, fault: str | None = None, pack: str = "harbor"):
    dataset = _dataset(pack)
    action = notifications.plan_notification_controls(dataset)[0]
    server = NotificationServer(dataset, action, fault)
    clients = {}
    for key, actor_id in server.identities.items():
        client = SampleClient(
            "http://sample.test",
            "http://localhost",
            tmp_path / "notifications.jsonl",
            transport=httpx.MockTransport(lambda req, who=actor_id: server.handle(who, req)),
        )
        request.addfinalizer(client.close)
        assert client.login(f"{key}@example.test", "fixture-only").status_code == 200
        clients[key] = client
    context = PhaseExecutionContext(
        clients=clients,
        user_ids={"admin": ADMIN, **server.identities},
        group_ids={},
        department_ids={},
        module_ids=server.modules,
        field_ids={},
        admin_password="fixture-only",
        mappings={"records": server.subjects, "modules": server.modules},
    )
    return dataset, action, context, server


@pytest.mark.parametrize("pack", ("harbor", "school"))
def test_complete_recipient_journey_reads_all_pages_and_preserves_other_recipient(
    tmp_path: Path,
    request,
    pack: str,
) -> None:
    dataset, action, context, server = _setup(tmp_path, request, pack=pack)
    result = notifications.execute_notification_control(action, dataset, context)
    assert result["outcome"] == "completed" and result["actor_id"] == PRIMARY
    assert result["unread_before"] == 27
    assert result["unread_after_one"] == 26
    assert result["unread_after_all"] == 0
    assert len(server.writes) == 2
    marked = server.writes[0][1].split("/")[-2]
    assert marked in {row["id"] for row in server.before[PRIMARY] if row["status"] == "unread"}
    assert server.writes == [
        (PRIMARY, f"/api/notifications/{marked}/read"),
        (PRIMARY, "/api/notifications/read-all"),
    ]
    assert all(row["status"] == "read" for row in server.rows[PRIMARY])
    assert server.rows[OBSERVER] == server.before[OBSERVER]
    assert (PRIMARY, 25) in server.pages
    assert all(actor != ADMIN for actor, _, _ in server.requests)
    evidence = result["request_evidence"]
    assert len({row["request_id"] for row in evidence}) == len(evidence)
    assert all(row["expected_status"] == row["status_code"] == 200 for row in evidence)
    assert {row["actor_id"] for row in evidence} == {PRIMARY, OBSERVER}
    assert (
        result["notification_readback"]["verification_boundary"] == "immediate-recipient-readback"
    )


@pytest.mark.parametrize(
    "fault",
    (
        "wrong_identity",
        "malformed_page",
        "incomplete_page",
        "wrong_offset",
        "changed_total",
        "duplicate_notice",
        "wrong_subject",
        "private_recipient_notice",
        "invalid_read_status",
        "bool_count",
        "wrong_count",
        "list_unavailable",
    ),
)
def test_invalid_recipient_or_complete_list_boundary_stops_before_any_write(
    tmp_path: Path,
    request,
    fault: str,
) -> None:
    dataset, action, context, server = _setup(tmp_path, request, fault)
    with pytest.raises(SamplePhaseActionError):
        notifications.execute_notification_control(action, dataset, context)
    assert server.writes == []


@pytest.mark.parametrize("fault", ("wrong_marked_id", "unconfirmed_read", "one_count_unchanged"))
def test_unconfirmed_single_read_stops_before_read_all(tmp_path: Path, request, fault: str) -> None:
    dataset, action, context, server = _setup(tmp_path, request, fault)
    with pytest.raises(SamplePhaseActionError):
        notifications.execute_notification_control(action, dataset, context)
    assert len(server.writes) == 1


@pytest.mark.parametrize(
    "fault",
    (
        "wrong_updated_count",
        "incomplete_read_all",
        "changed_other_recipient",
    ),
)
def test_incomplete_end_state_or_other_recipient_mutation_is_not_completed(
    tmp_path: Path,
    request,
    fault: str,
) -> None:
    dataset, action, context, server = _setup(tmp_path, request, fault)
    with pytest.raises(SamplePhaseActionError):
        notifications.execute_notification_control(action, dataset, context)
    assert len(server.writes) == 2


@pytest.mark.parametrize("fault, writes", (("unknown_mark_one", 1), ("unknown_read_all", 2)))
def test_unknown_notification_write_is_not_replayed(
    tmp_path: Path, request, fault: str, writes: int
) -> None:
    dataset, action, context, server = _setup(tmp_path, request, fault)
    with pytest.raises(SampleWriteOutcomeUnknown):
        notifications.execute_notification_control(action, dataset, context)
    assert len(server.writes) == writes


def test_modified_plan_or_human_owner_binding_never_marks_notifications(
    tmp_path: Path, request
) -> None:
    dataset, action, context, server = _setup(tmp_path, request)
    with pytest.raises(SamplePhaseActionError):
        notifications.execute_notification_control(
            replace(action, actor_key="admin"), dataset, context
        )
    context.user_ids = {**context.user_ids, action.actor_key: ADMIN}
    with pytest.raises(SamplePhaseActionError):
        notifications.execute_notification_control(action, dataset, context)
    assert server.writes == []


def test_independent_readback_observes_live_failure_instead_of_trusting_completed_result(
    tmp_path: Path,
    request,
) -> None:
    dataset, action, context, server = _setup(tmp_path, request)
    result = notifications.execute_notification_control(action, dataset, context)
    before_reads = len(server.requests)
    server.rows[PRIMARY][0].update(status="unread", read_at=None)
    with pytest.raises(SamplePhaseActionError):
        notifications.verify_notification_controls(dataset, context, action, result)
    assert len(server.requests) > before_reads
    assert len(server.writes) == 2


def test_global_receipt_validation_is_historical_not_a_new_recipient_read(
    tmp_path: Path,
    request,
) -> None:
    dataset, action, context, server = _setup(tmp_path, request)
    result = notifications.execute_notification_control(action, dataset, context)
    # Later source work may create notices after the separately verified control boundary.
    server.rows[PRIMARY].append({**server.before[PRIMARY][0], "id": str(UUID(int=9001))})
    prior_requests = list(server.requests)
    manifest = {
        "actor_ids": dict(context.user_ids),
        "mappings": dict(context.runtime_mappings),
        "people": {
            key: {"user_id": identifier, "role": "member", "status": "active"}
            for key, identifier in context.user_ids.items()
            if key != "admin"
        },
    }
    observed, issues = {"control_requests_verified": 0}, []
    notifications.verify_notification_evidence(
        dataset,
        manifest,
        action,
        result,
        ADMIN,
        set(),
        observed,
        issues,
    )
    assert issues == [] and observed["notification_receipt_actions_verified"] == 1
    assert server.requests == prior_requests


@pytest.mark.parametrize(
    "fault", ("actor", "request_id", "missing_page", "readback", "count", "shared_recipient_notice")
)
def test_historical_receipt_verifier_rejects_tampering_without_claiming_fresh_inbox_state(
    tmp_path: Path,
    request,
    fault: str,
) -> None:
    dataset, action, context, _ = _setup(tmp_path, request)
    result = notifications.execute_notification_control(action, dataset, context)
    bad = copy.deepcopy(result)
    if fault == "actor":
        bad["request_evidence"][0]["actor_id"] = ADMIN
    elif fault == "request_id":
        bad["request_evidence"][1]["request_id"] = bad["request_evidence"][0]["request_id"]
    elif fault == "missing_page":
        bad["request_evidence"].pop()
    elif fault == "readback":
        bad.pop("notification_readback")
    elif fault == "shared_recipient_notice":
        primary_id = bad["notification_before"]["primary"][0]["id"]
        bad["notification_before"]["observer"][0]["id"] = primary_id
        bad["notification_readback"]["observer"][0]["id"] = primary_id
    else:
        bad["unread_after_all"] = 1
    manifest = {
        "actor_ids": dict(context.user_ids),
        "mappings": dict(context.runtime_mappings),
        "people": {
            key: {"user_id": identifier, "role": "member", "status": "active"}
            for key, identifier in context.user_ids.items()
            if key != "admin"
        },
    }
    observed, issues = {"control_requests_verified": 0}, []
    notifications.verify_notification_evidence(
        dataset, manifest, action, bad, ADMIN, set(), observed, issues
    )
    assert issues and observed["control_requests_verified"] == 0
