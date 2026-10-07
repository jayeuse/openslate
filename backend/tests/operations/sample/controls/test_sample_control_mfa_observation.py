"""Synchronous acceptance boundaries never publish private MFA material."""

from copy import deepcopy

import pytest

from operations.sample.controls.mfa import execute_mfa_control
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls.test_sample_control_mfa import (
    OWNER_ID,
    PASSWORD,
    SEED,
)
from tests.operations.sample.controls.test_sample_control_mfa import (
    setup_mfa as setup_mfa,
)


def test_mfa_observer_receives_immutable_owned_ids_at_exact_synchronous_boundaries(setup_mfa):
    dataset, action, context, server = setup_mfa()
    original_groups = deepcopy(server.groups)
    observations = []

    def observe(stage, payload):
        assert set(payload) == {
            "action_key",
            "owner_id",
            "actor_id",
            "target_id",
            "actor_session_ids",
            "target_session_ids",
        }
        assert payload["action_key"] == action.key
        assert (payload["owner_id"], payload["actor_id"], payload["target_id"]) == (
            OWNER_ID,
            server.actor,
            server.target,
        )
        assert isinstance(payload["actor_session_ids"], tuple)
        assert isinstance(payload["target_session_ids"], tuple)
        with pytest.raises(TypeError):
            payload["actor_id"] = OWNER_ID
        with pytest.raises(TypeError):
            payload["target_session_ids"][0] = OWNER_ID
        if stage == "before_reset":
            assert server.reset_receipt is None
            assert all(f["status"] == "verified" for f in server.factors[server.target])
            for key, identifier in (
                ("actor_session_ids", server.actor),
                ("target_session_ids", server.target),
            ):
                assert payload[key] == tuple(
                    sorted(s for s, uid in server.sessions.items() if uid == identifier)
                )
        elif stage == "after_revocation":
            assert server.reset_receipt is not None
            assert server.users[action.actor_key]["role"] == "member"
            assert server.factors[server.actor] == server.factors[server.target] == []
            assert all(
                s not in server.sessions
                for key in ("actor_session_ids", "target_session_ids")
                for s in payload[key]
            )
            assert all(
                set(g["member_ids"]) == set(server.groups[key]["member_ids"])
                for key, g in original_groups.items()
            )
        else:
            pytest.fail("Unexpected observer stage")
        observations.append((stage, payload, len(server.requests)))

    context.private_values["mfa_observer"] = observe
    result = execute_mfa_control(action, dataset, context)
    assert [stage for stage, _, _ in observations] == ["before_reset", "after_revocation"]
    assert observations[0][1] == observations[1][1]
    assert server.requests[observations[0][2]].url.path.endswith("/mfa/reset")
    assert server.requests[observations[1][2]].url.path == "/api/auth/login"
    assert result["status"] == "complete"


@pytest.mark.parametrize("invalid", (None, False, "not-callable", object()))
def test_invalid_mfa_observer_is_refused_before_transport(setup_mfa, invalid):
    dataset, action, context, server = setup_mfa()
    context.private_values["mfa_observer"] = invalid
    before = len(server.requests)
    with pytest.raises(SamplePhaseActionError) as failure:
        execute_mfa_control(action, dataset, context)
    assert failure.value.step == "mfa_observer_setup"
    assert len(server.requests) == before


@pytest.mark.parametrize("boundary", ("before_reset", "after_revocation"))
def test_observer_failure_is_sanitized_and_stops_dependent_requests(setup_mfa, boundary):
    dataset, action, context, server = setup_mfa()
    failed_at = []

    def observe(stage, payload):
        if stage == boundary:
            failed_at.append(len(server.requests))
            raise RuntimeError(f"private callback failure {PASSWORD} {SEED}")

    context.private_values["mfa_observer"] = observe
    with pytest.raises(SamplePhaseActionError) as failure:
        execute_mfa_control(action, dataset, context)
    assert failure.value.step == f"mfa_observer:{boundary}"
    assert failed_at and len(server.requests) == failed_at[0]
    assert failure.value.__cause__ is None and failure.value.__context__ is None
    assert PASSWORD not in str(failure.value) and SEED not in str(failure.value)
    assert (server.reset_receipt is None) == (boundary == "before_reset")
    if boundary == "after_revocation":
        assert server.users[action.actor_key]["role"] == "member"
        assert server.factors[server.actor] == server.factors[server.target] == []


def test_omitted_observer_keeps_offline_results_without_claiming_provider_proof(setup_mfa):
    dataset, action, context, _ = setup_mfa()
    result = execute_mfa_control(action, dataset, context)
    assert result["status"] == "complete"
    assert "provider_sessions_verified" not in result and "mfa_observer_verified" not in result
