"""Offline profile journey uses actual SampleClient HTTP and independent server state."""

import copy
import json
from datetime import date
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.actions import execute_control_action
from operations.sample.controls.mfa import plan_mfa_controls
from operations.sample.packs import get_pack
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.phases.plan import plan_phases
from operations.sample.scenario import build_dataset
from tests.operations.sample.controls.sample_profile_wire import ORIGIN, PASSWORD, ProfileWire


def setup(tmp_path, *, pack="harbor", defect=None):
    dataset = build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack(pack)
    )
    excluded = {
        key
        for action in (
            *plan_phases(dataset),
            *plan_account_controls(dataset),
            *plan_mfa_controls(dataset),
        )
        for key in (action.actor_key, action.target_key)
    }
    person = next(
        person
        for person in dataset.organization.actors.people
        if person.role in {"member", "guest"}
        and person.status == "active"
        and person.key not in excluded
    )
    action = PhaseAction(
        key="control:account-profile",
        phase="admin",
        kind="account_controls",
        actor_key=person.key,
        target_key=person.key,
        values={"operation": "self_profile"},
        expected_status=200,
        expected_detail=None,
        expected_end_state={
            "original_profile_restored": True,
            "original_preferences_restored": True,
            "temporary_avatar_purged": True,
        },
    )
    actor_id, admin_id = str(uuid4()), str(uuid4())
    wire = ProfileWire(actor_id, admin_id, person.role, defect=defect)
    clients = {}
    for key, email in ((person.key, person.email), ("admin", "admin@example.test")):
        client = SampleClient(
            "http://api.example.test",
            ORIGIN,
            tmp_path / f"{key}-requests.jsonl",
            transport=httpx.MockTransport(wire.handle),
        )
        assert client.login(email, PASSWORD).status_code == 200
        clients[key] = client
    context = PhaseExecutionContext(
        clients=clients,
        user_ids={person.key: actor_id, "admin": admin_id},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="unused",
    )
    return dataset, action, context, wire


def close(context):
    for client in context.clients.values():
        client.close()


@pytest.mark.parametrize("pack", ["harbor", "school"])
def test_profile_control_restores_owned_text_preferences_and_null_avatar_through_real_transport(
    tmp_path, pack
):
    dataset, action, context, wire = setup(tmp_path, pack=pack)
    original = copy.deepcopy((wire.profile, wire.preferences, wire.sessions))
    try:
        result = execute_control_action(action, dataset, context)
        assert (wire.profile, wire.preferences, wire.sessions) == original
        assert len(wire.files) == 1 and not wire.objects and wire.bound_reads == 2
        assert next(iter(wire.files.values()))["state"] == "purged"
        receipts = {
            (method, path, status, request_id) for method, path, status, request_id in wire.receipts
        }
        assert all(
            (row["method"], row["path"], row["status_code"], row["request_id"]) in receipts
            for row in result["request_evidence"]
        )
        from operations.sample.controls.profile_verification import verify_profile_controls

        counts, issues = verify_profile_controls(
            context.clients["admin"],
            dataset,
            {"actor_ids": context.user_ids, "control_results": [result]},
            context.user_ids["admin"],
        )
        assert issues == [] and counts["profile_control_actions"] == 1
        assert not any(request.url.path == "/api/audit-logs" for request in wire.requests)
        assert result.get("self_final") == wire.self_body()
    finally:
        close(context)


@pytest.mark.parametrize("defect", ["original_avatar", "missing_private_read"])
def test_profile_control_refuses_unsafe_initial_read_before_any_write(tmp_path, defect):
    dataset, action, context, wire = setup(tmp_path, defect=defect)
    try:
        with pytest.raises(SamplePhaseActionError):
            execute_control_action(action, dataset, context)
        assert wire.writes == [] and (wire.profile, wire.preferences) == wire.initial
    finally:
        close(context)


@pytest.mark.parametrize("defect", ["wrong_creator", "corrupt_avatar", "ignore_restore"])
def test_profile_control_checks_actual_owner_bytes_and_fresh_restoration_not_success_flags(
    tmp_path, defect
):
    dataset, action, context, wire = setup(tmp_path, defect=defect)
    try:
        with pytest.raises(SamplePhaseActionError):
            execute_control_action(action, dataset, context)
        assert len(wire.files) == 1
    finally:
        close(context)


def test_profile_cleanup_partial_stops_without_retry_or_claiming_restoration(tmp_path):
    dataset, action, context, wire = setup(tmp_path, defect="partial_cleanup")
    try:
        with pytest.raises(SampleWriteOutcomeUnknown):
            execute_control_action(action, dataset, context)
        assert wire.profile["avatar_file_id"] is None
        assert next(iter(wire.files.values()))["state"] == "deleting" and wire.objects
        assert wire.writes.count(("PATCH", "/api/auth/me/profile")) == 3
    finally:
        close(context)


def test_profile_verifier_accepts_restored_nullable_text_with_username_card_fallback(tmp_path):
    from operations.sample.controls.profile_verification import verify_profile_controls

    dataset, action, context, wire = setup(tmp_path, defect="nullable_text")
    try:
        result = execute_control_action(action, dataset, context)
        assert (wire.profile, wire.preferences) == wire.initial
        _, issues = verify_profile_controls(
            context.clients["admin"],
            dataset,
            {"actor_ids": context.user_ids, "control_results": [result]},
            context.user_ids["admin"],
        )
        assert issues == []
    finally:
        close(context)


@pytest.mark.parametrize("mapping", ["malformed", "shared_admin"])
def test_profile_invalid_owned_mapping_is_safe_precondition_refusal_without_writes(
    tmp_path, mapping
):
    dataset, action, context, wire = setup(tmp_path)
    context.user_ids[action.actor_key] = (
        "not-an-id" if mapping == "malformed" else context.user_ids["admin"]
    )
    try:
        with pytest.raises(SamplePhaseActionError):
            execute_control_action(action, dataset, context)
        assert wire.writes == [] and (wire.profile, wire.preferences) == wire.initial
    finally:
        close(context)


def test_profile_verifier_refuses_changed_live_state_and_reused_request_receipts(tmp_path):
    from operations.sample.controls.profile_verification import verify_profile_controls

    dataset, action, context, wire = setup(tmp_path)
    try:
        result = execute_control_action(action, dataset, context)
        manifest = {"actor_ids": context.user_ids, "control_results": [result]}
        wire.profile["phone"] = "Changed after the successful run"
        _, issues = verify_profile_controls(
            context.clients["admin"], dataset, manifest, context.user_ids["admin"]
        )
        assert issues
        wire.profile["phone"] = wire.initial[0]["phone"]
        result["read_evidence"][0]["request_id"] = result["request_evidence"][0]["request_id"]
        _, issues = verify_profile_controls(
            context.clients["admin"], dataset, manifest, context.user_ids["admin"]
        )
        assert issues
    finally:
        close(context)


def test_profile_verifier_refuses_a_final_self_read_that_differs_from_restored_private_values(
    tmp_path,
):
    from operations.sample.controls.profile_verification import verify_profile_controls

    dataset, action, context, wire = setup(tmp_path)
    try:
        result = execute_control_action(action, dataset, context)
        result["self_final"] = {**wire.self_body(), "phone": "Unrestored private value"}
        _, issues = verify_profile_controls(
            context.clients["admin"],
            dataset,
            {"actor_ids": context.user_ids, "control_results": [result]},
            context.user_ids["admin"],
        )
        assert issues
    finally:
        close(context)


def test_profile_control_exercises_an_actual_edit_even_when_original_text_matches_sample(tmp_path):
    dataset, action, context, wire = setup(tmp_path)
    wire.profile.update(
        display_name="Sample profile round trip",
        job_title="Profile control",
        phone="+1 sample",
        bio="Owned temporary profile proof",
    )
    wire.initial = copy.deepcopy((wire.profile, wire.preferences))
    try:
        execute_control_action(action, dataset, context)
        text_request = next(
            request
            for request in wire.requests
            if request.method == "PATCH" and request.url.path == "/api/auth/me/profile"
        )
        assert json.loads(text_request.content)["display_name"] != wire.initial[0]["display_name"]
        assert (wire.profile, wire.preferences) == wire.initial
    finally:
        close(context)
