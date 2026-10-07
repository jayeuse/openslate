"""People control faults use a closed wire; live Small runs own provider proof."""

import json
import time
from copy import deepcopy
from dataclasses import replace

import pytest

from operations.sample.client import SampleWriteOutcomeUnknown
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.actions import plan_controls
from operations.sample.controls.reads import plan_read_controls
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls.sample_people_security_wire import (
    PASSWORD,
    dataset,
    identifier,
    journey,
    manifest,
    unit,
)

ROUTES = {
    ("GET", "/api/users/summary"),
    ("GET", "/api/users/{user_id}/security"),
    ("POST", "/api/users/{user_id}/recovery"),
    ("GET", "/api/security-events"),
    ("GET", "/api/security-events/{event_id}"),
}


@pytest.mark.parametrize("pack", ("harbor", "school"))
def test_small_plan_contains_owned_people_security_journey(pack):
    source = dataset(pack)
    actions = [
        row
        for row in plan_controls(source)
        if row.values.get("operation") == "review_people_security"
    ]
    assert len(actions) == 1, "Implemented People controls lack a sample journey"
    action = actions[0]
    person = next(p for p in source.organization.actors.people if p.key == action.target_key)
    assert action.kind == "access_controls" and action.actor_key == "admin"
    assert person.role == "member" and person.status == "active"
    assert person.key not in {
        plan_account_controls(source)[0].actor_key,
        plan_read_controls(source)[0].target_key,
    }
    assert action.values["inactive_days"] == 30


@pytest.mark.parametrize("pack", ("harbor", "school"))
def test_people_journey_restores_primary_and_correlates_real_wire_receipts(tmp_path, pack):
    with journey(tmp_path, pack) as (people, verification, source, action, context, server):
        result = people.execute_people_security_control(action, source, context)
        assert result["outcome"] == "completed" and result["primary_session_authenticated"] is True
        assert server.recoveries == [False, True] and server.primary_logins == 2
        assert server.owner_factors == (identifier("owner-factor"),)
        assert people.CONTROL_ROUTES == frozenset(ROUTES)
        assert set(server.details) == {row["id"] for row in server.events}
        assert not any("/mfa" in request.url.path for request in server.requests)
        assert len([r for r in server.requests if r.url.path == "/api/security-events"]) >= 4
        assert len([r for r in server.requests if r.url.path == "/api/users"]) >= 7
        owner_logins = [
            r
            for r in server.requests
            if r.url.path == "/api/auth/login"
            and json.loads(r.content)["email"] == "owner@example.test"
        ]
        assert len(owner_logins) == 1, "An admitted owner session must never need password fallback"
        retained = manifest(action, result, server)
        issues, observed = [], {"control_requests_verified": 0}
        verification.verify_people_security_evidence(
            source,
            retained,
            action,
            result,
            server.admin,
            set(),
            observed,
            issues,
        )
        assert issues == [] and observed["control_requests_verified"] > 0
        counts, issues = verification.verify_people_security_controls(
            context.clients["admin"],
            source,
            retained,
            admin_id=server.admin,
        )
        assert issues == [] and counts["people_recoveries_verified"] == 2
        assert (
            context.clients[action.target_key].request("GET", "/api/auth/me").json()["id"]
            == server.target
        )
    journal = (tmp_path / "requests.jsonl").read_text()
    assert PASSWORD not in journal and server.person.email not in journal


@pytest.mark.parametrize(
    "fault",
    (
        "missing_credential",
        "credential_identity",
        "security_identity",
        "ineligible",
        "smtp_missing",
        "summary_count",
        "summary_cutoff",
        "wrong_page",
        "duplicate_person",
        "unknown_as_without",
        "null_inactive",
        "future_inactive",
    ),
)
def test_people_invalid_admission_or_monitoring_stops_before_recovery(tmp_path, fault):
    with journey(tmp_path, fault=fault) as (people, _, source, action, context, server):
        with pytest.raises(SamplePhaseActionError) as error:
            people.execute_people_security_control(action, source, context)
        assert error.value.step and server.recoveries == []
        if fault in {"missing_credential", "credential_identity"}:
            assert "credential" in str(error.value).lower()
        else:
            assert fault in server.fault_hits, "The intended response boundary was not reached"
        assert (
            context.clients[action.target_key].request("GET", "/api/auth/me").json()["id"]
            == server.target
        )


@pytest.mark.parametrize(
    "fault",
    (
        "receipt_target",
        "false_revocation",
        "missing_event",
        "duplicate_event",
        "event_actor",
        "event_subject",
        "event_request",
        "event_operation",
        "event_outcome",
        "event_detail",
    ),
)
def test_people_receipt_or_event_fault_stops_without_second_recovery(tmp_path, fault):
    with journey(tmp_path, fault=fault) as (people, _, source, action, context, server):
        with pytest.raises(SamplePhaseActionError) as error:
            people.execute_people_security_control(action, source, context)
        assert error.value.step and server.recoveries == [False]
        assert fault in server.fault_hits, "The intended response boundary was not reached"
        if fault.startswith("event") or fault in {"missing_event", "duplicate_event"}:
            assert any(r.url.path == "/api/security-events" for r in server.requests)
        assert (
            context.clients[action.target_key].request("GET", "/api/auth/me").json()["id"]
            == server.target
        )


@pytest.mark.parametrize("fault", ("partial", "unknown_write"))
def test_people_unknown_recovery_is_not_replayed_and_primary_is_reauthenticated(tmp_path, fault):
    with journey(tmp_path, fault=fault) as (people, _, source, action, context, server):
        with pytest.raises(SampleWriteOutcomeUnknown):
            people.execute_people_security_control(action, source, context)
        assert server.recoveries == [False, True] and server.primary_logins == 2
        assert fault in server.fault_hits
        assert (
            context.clients[action.target_key].request("GET", "/api/auth/me").json()["id"]
            == server.target
        )


@pytest.mark.parametrize(
    "fault", ("sessions_remain", "receipt_count", "reauth_denied", "reauth_identity")
)
def test_people_revocation_or_primary_restoration_failure_cannot_complete(tmp_path, fault):
    with journey(tmp_path, fault=fault) as (people, _, source, action, context, server):
        with pytest.raises(SamplePhaseActionError) as error:
            people.execute_people_security_control(action, source, context)
        assert error.value.step and server.recoveries == [False, True]
        assert fault in server.fault_hits, "The intended lifecycle boundary was not reached"
        assert server.owner_factors == (identifier("owner-factor"),)


def test_people_plan_is_pack_neutral_and_refuses_no_owned_member():
    people, _ = unit()
    source = dataset()
    renamed = replace(
        source,
        organization=replace(
            source.organization,
            identity=replace(source.organization.identity, key="renamed-owned-pack"),
        ),
    )
    assert people.plan_people_security_controls(renamed) == people.plan_people_security_controls(
        source
    )
    no_members = replace(
        source,
        organization=replace(
            source.organization,
            actors=replace(
                source.organization.actors,
                people=tuple(p for p in source.organization.actors.people if p.role != "member"),
            ),
        ),
    )
    with pytest.raises(ValueError, match="active|member|person|target"):
        people.plan_people_security_controls(no_members)


@pytest.mark.parametrize(
    "fault", ("retained_status", "retained_path", "retained_pages", "final_identity")
)
def test_people_verification_rejects_corrupted_receipt_or_changed_final_identity(tmp_path, fault):
    with journey(tmp_path) as (people, verification, source, action, context, server):
        result = people.execute_people_security_control(action, source, context)
        retained = manifest(action, result, server)
        if fault == "retained_status":
            retained = deepcopy(retained)
            retained["control_results"][0]["request_evidence"][0]["status_code"] = 503
        elif fault == "retained_path":
            retained = deepcopy(retained)
            retained["control_results"][0]["request_evidence"][0]["path"] = "/api/users/foreign"
        elif fault == "retained_pages":
            retained = deepcopy(retained)
            retained["control_results"][0]["directory_pages"]["without"] = 0
        else:
            server.final_mode, server.fault = True, fault
        _, issues = verification.verify_people_security_controls(
            context.clients["admin"],
            source,
            retained,
            admin_id=server.admin,
        )
        assert issues, "Changed evidence or identity cannot be accepted as complete"


def test_people_revoked_near_expiry_access_is_read_without_refresh(tmp_path, monkeypatch):
    with journey(tmp_path) as (people, _, source, action, context, server):
        primary = context.clients[action.target_key]
        monkeypatch.setattr(
            primary,
            "_access_expires_at",
            lambda: (
                time.time() + 1
                if server.recoveries == [False, True] and server.primary_logins == 1
                else None
            ),
        )
        result = people.execute_people_security_control(action, source, context)
        assert result["primary_session_authenticated"] is True
        assert server.recoveries == [False, True] and server.primary_logins == 2
        assert not any(r.url.path == "/api/auth/refresh" for r in server.requests)
