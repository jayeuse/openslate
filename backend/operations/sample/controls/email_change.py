"""Owned member email round trip through current-password and two recipient confirmations."""

import secrets
from collections.abc import Mapping
from contextlib import ExitStack
from typing import Any

import httpx

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.account import _uuid, plan_account_controls
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _read_json,
    _request_id,
)
from operations.sample.population.invitations import InvitationMailbox, SampleInvitationError
from operations.sample.population.people import SampleActorCredential

EMAIL_WRITES = {
    "email_password_check": ("POST", "/api/auth/login", 200),
    "request_email_change": ("POST", "/api/auth/me/email", 200),
    "confirm_current_email": ("POST", "/api/auth/email/complete", 200),
    "confirm_new_email": ("POST", "/api/auth/email/complete", 200),
    "login_changed_email": ("POST", "/api/auth/login", 200),
    "request_original_email": ("POST", "/api/auth/me/email", 200),
    "confirm_temporary_email": ("POST", "/api/auth/email/complete", 200),
    "confirm_original_email": ("POST", "/api/auth/email/complete", 200),
    "restore_primary_login": ("POST", "/api/auth/login", 200),
}
EMAIL_READS = {
    "email_before": ("GET", "/api/auth/me", 200),
    "email_mfa_before": ("GET", "/api/auth/mfa", 200),
    "email_after_first": ("GET", "/api/auth/me", 200),
    "changed_email": ("GET", "/api/auth/me", 200),
    "new_email_login": ("GET", "/api/auth/me", 200),
    "restored_email": ("GET", "/api/auth/me", 200),
    "primary_restored": ("GET", "/api/auth/me", 200),
    "primary_session": ("GET", "/api/auth/session", 200),
}


def plan_email_change_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    member = plan_account_controls(dataset)[0].actor_key
    return (
        PhaseAction(
            key="control:account-email-change",
            phase="admin",
            kind="account_controls",
            actor_key=member,
            target_key=member,
            values={"operation": "self_email_change"},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "original_email_restored": True,
                "primary_session_authenticated": True,
            },
        ),
    )


def execute_email_change_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_email_change_controls(dataset):
        raise SamplePhaseActionError(
            "Email action differs from the owned member plan", step="email_plan"
        )
    private = context.private_values
    credentials = private.get("credentials")
    credential = credentials.get(action.actor_key) if isinstance(credentials, Mapping) else None
    primary = context.clients.get(action.actor_key)
    factory, origin, mailpit_url = (
        private.get(key) for key in ("new_client", "origin", "mailpit_url")
    )
    person = next(
        person for person in dataset.organization.actors.people if person.key == action.actor_key
    )
    actor_id = _uuid(context.user_ids.get(action.actor_key), "email_setup")
    if (
        not isinstance(credential, SampleActorCredential)
        or primary is None
        or not callable(factory)
        or not isinstance(origin, str)
        or not isinstance(mailpit_url, str)
        or credential.user_id != actor_id
        or actor_id == context.user_ids.get("admin")
        or credential.email != person.email
        or not credential.password
    ):
        raise SamplePhaseActionError(
            "Owned email run prerequisites are unavailable", step="email_setup"
        )
    writes: list[dict[str, object]] = []
    reads: list[dict[str, object]] = []
    confirmations: list[dict[str, object]] = []

    def observed(step: str, response: httpx.Response) -> dict[str, Any]:
        if on_substep is not None:
            on_substep(step)
        method, path, status = (EMAIL_WRITES | EMAIL_READS)[step]
        request_id = _request_id(response)
        if response.status_code != status or request_id is None:
            raise SamplePhaseActionError(
                "Email request did not match its result", step=step,
                status_code=response.status_code, request_id=request_id,
            )
        (reads if method == "GET" else writes).append({
            "step": step, "actor_key": action.actor_key, "actor_id": actor_id,
            "method": method, "path": path, "status_code": response.status_code,
            "expected_status": status, "request_id": request_id,
        })
        return _read_json(response, step=step)

    def identity(client: SampleClient, step: str, email: str) -> None:
        body = observed(step, client.request("GET", "/api/auth/me"))
        if (
            body.get("id") != actor_id
            or body.get("email") != email
            or body.get("role") != "member"
            or body.get("status") != "active"
            or body.get("is_deleted") is not False
        ):
            raise SamplePhaseActionError(
                "Email readback differs from the owned active member", step=step
            )

    def login(client: SampleClient, step: str, email: str) -> None:
        body = observed(step, client.login(email, credential.password))
        if body.get("authenticated") is not True or body.get("setup_required") is not False:
            raise SamplePhaseActionError("Email login did not complete", step=step)

    try:
        with ExitStack() as stack:
            mailbox = stack.enter_context(InvitationMailbox(mailpit_url, origin))
            mailbox.snapshot()  # Fail before effects if the owned inbox is unavailable.
            identity(primary, "email_before", credential.email)
            mfa = observed("email_mfa_before", primary.request("GET", "/api/auth/mfa"))
            if (
                mfa.get("user_id") != actor_id
                or mfa.get("required") is not False
                or mfa.get("policy_required") is not False
                or mfa.get("factors") != []
            ):
                raise SamplePhaseActionError(
                    "Email control requires unforced MFA", step="email_mfa_before"
                )
            known = stack.enter_context(factory())
            login(known, "email_password_check", credential.email)
            temporary_email = f"email-change-{secrets.token_hex(12)}@example.test"

            def roundtrip(
                requester: SampleClient,
                current_email: str,
                target_email: str,
                request_step: str,
                first_step: str,
                final_step: str,
            ) -> SampleClient:
                baseline = mailbox.snapshot()
                body = observed(
                    request_step,
                    requester.request_email_change(target_email, credential.password),
                )
                if (
                    set(body) != {"confirmation_required"}
                    or body["confirmation_required"] is not True
                ):
                    raise SamplePhaseActionError(
                        "Email request acknowledgment is invalid", step=request_step
                    )
                current = mailbox.email_change_token(baseline, current_email)
                target = mailbox.email_change_token(baseline, target_email)
                if current == target:
                    raise SamplePhaseActionError(
                        "Recipient email proofs are not distinct", step=first_step
                    )
                completion: SampleClient = stack.enter_context(factory())
                first = completion.complete_email_change(current)
                body = observed(first_step, first)
                if (
                    set(body) != {"authenticated", "confirmation_required"}
                    or body.get("authenticated") is not False
                    or body.get("confirmation_required") is not True
                    or any(name in first.headers for name in ("set-cookie", "authorization"))
                ):
                    raise SamplePhaseActionError(
                        "First confirmation changed session state", step=first_step
                    )
                confirmations.append({"step": first_step, **body})
                if request_step == "request_email_change":
                    identity(primary, "email_after_first", credential.email)
                final = observed(final_step, completion.complete_email_change(target))
                if (
                    set(final) != {"authenticated", "confirmation_required", "setup_required"}
                    or final.get("authenticated") is not True
                    or final.get("confirmation_required") is not False
                    or final.get("setup_required") is not False
                ):
                    raise SamplePhaseActionError(
                        "Final confirmation did not admit the owned member", step=final_step
                    )
                confirmations.append({"step": final_step, **final})
                return completion

            changed = roundtrip(
                known, credential.email, temporary_email,
                "request_email_change", "confirm_current_email", "confirm_new_email",
            )
            try:
                identity(changed, "changed_email", temporary_email)
                new_login = stack.enter_context(factory())
                login(new_login, "login_changed_email", temporary_email)
                identity(new_login, "new_email_login", temporary_email)
            finally:
                # A confirmed transition is reversed even if a subsequent read/login fails.
                # Unknown writes above never reach this block: they are not replayed or guessed.
                restored = roundtrip(
                    changed, temporary_email, credential.email,
                    "request_original_email", "confirm_temporary_email", "confirm_original_email",
                )
                identity(restored, "restored_email", credential.email)
                login(primary, "restore_primary_login", credential.email)
                identity(primary, "primary_restored", credential.email)
                session = observed("primary_session", primary.request("GET", "/api/auth/session"))
                if session.get("authenticated") is not True or session.get("user_id") != actor_id:
                    raise SamplePhaseActionError(
                        "Restored primary session is unavailable", step="primary_session"
                    )
    except SampleInvitationError:
        raise SamplePhaseActionError(
            "Owned email confirmations are unavailable", step="email_delivery"
        ) from None
    return {
        "action_key": action.key, "kind": action.kind, "actor_key": action.actor_key,
        "target_key": action.target_key, "actor_id": actor_id, "status": "complete",
        "original_email_restored": True, "primary_session_authenticated": True,
        "confirmation_results": confirmations, "request_evidence": writes,
        "read_evidence": reads, "mappings": [],
    }
