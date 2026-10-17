"""Prepared S24 native cases; execute only on the released, guarded disposable stack."""

import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from threading import Event
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.contracts import InvalidCredentials
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_sessions import admit_provider_session
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.auth.test_provider_email_integration import _email_action
from tests.auth.totp_support import totp
from tests.conftest import create_member, guarded_create_engine, membership_of

pytest_plugins = ("tests.auth.test_provider_email_integration",)
pytestmark = pytest.mark.integration


@pytest.fixture
def email_change_account(provider_account, provider_mail):
    email, password, provider_id, local_id, owner = provider_account
    with Session(owner) as db:
        person = db.get(User, local_id)
        assert person is not None
        person.supabase_user_id = provider_id
        db.commit()
    with ExitStack() as stack:
        # Each journey owns its source budget; keep real anonymous rate limits on.
        source = "2001:db8:" + ":".join(local_id.hex[i : i + 4] for i in range(0, 24, 4))
        primary, landing = (
            stack.enter_context(
                TestClient(
                    create_app(), base_url=get_settings().public_origin, client=(source, 1234)
                )
            )
            for _ in range(2)
        )
        for browser in (primary, landing):
            browser.headers["Origin"] = get_settings().public_origin
        login = primary.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        yield primary, landing, provider_mail, provider_account


def _start_change(primary, mail, email, target, password):
    primary.headers["X-CSRF-Token"] = primary.cookies.get("openslate_csrf")
    response = primary.post(
        "/api/auth/me/email", json={"email": target, "current_password": password}
    )
    assert response.status_code == 200 and response.json() == {"confirmation_required": True}
    current = _email_action(mail, email, "email_change")
    new = _email_action(mail, target, "email_change")
    assert current != new
    return current, new


def _stored_state(owner, local_id):
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        sessions = set(
            db.scalars(select(IdentitySession.id).where(IdentitySession.user_id == local_id))
        )
        confirmations = set(
            db.scalars(
                select(SecurityEvent.id).where(
                    SecurityEvent.subject_id == local_id,
                    SecurityEvent.event_type == "identity.email_change_confirmed",
                )
            )
        )
        return user.email, user.supabase_user_id, sessions, confirmations


@pytest.mark.parametrize("new_first", [False, True])
def test_native_two_recipient_orders_preserve_partial_state_and_accept_new_email_login(
    email_change_account, new_first
):
    primary, landing, mail, account = email_change_account
    email, password, provider_id, local_id, owner = account
    provider = get_supabase_auth_client()
    confirmed_at = provider.get_admin_user(provider_id).email_confirmed_at
    target = f"email-changed-{uuid4().hex}@example.test"
    current, new = _start_change(primary, mail, email, target, password)
    before = _stored_state(owner, local_id)
    first, final = (new, current) if new_first else (current, new)
    refused = primary.post("/api/auth/email/complete", json={"token_hash": first})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "signed_out_required"
    accepted = landing.post("/api/auth/email/complete", json={"token_hash": first})
    assert accepted.status_code == 200
    assert accepted.json() == {"authenticated": False, "confirmation_required": True}
    assert accepted.headers.get_list("set-cookie") == []
    assert _stored_state(owner, local_id) == before
    assert provider.get_admin_user(provider_id).email == email
    replayed = landing.post("/api/auth/email/complete", json={"token_hash": first})
    assert replayed.status_code == 400, f"First-link replay returned HTTP {replayed.status_code}"
    assert replayed.headers.get_list("set-cookie") == []
    completed = landing.post("/api/auth/email/complete", json={"token_hash": final})
    assert completed.status_code == 200
    assert completed.json() == {
        "authenticated": True,
        "confirmation_required": False,
        "setup_required": False,
    }
    after = _stored_state(owner, local_id)
    assert after[:2] == (target, provider_id)
    assert len(after[2] - before[2]) == 1 and len(after[3] - before[3]) == 1
    assert landing.get("/api/auth/me").json()["email"] == target
    assert provider.get_admin_user(provider_id).email_confirmed_at == confirmed_at
    landing.cookies.clear()
    assert landing.post("/api/auth/email/complete", json={"token_hash": final}).status_code == 400
    assert (
        landing.post("/api/auth/login", json={"email": target, "password": password}).status_code
        == 200
    )
    assert landing.get("/api/auth/me").json()["id"] == str(local_id)
    assert _stored_state(owner, local_id)[3] == after[3]


@pytest.mark.parametrize("failure", ["all_row_collision", "post_flush_commit"])
def test_native_failed_final_admission_rolls_back_email_event_and_session_without_provider_fiction(
    email_change_account, failure
):
    primary, landing, mail, account = email_change_account
    email, password, provider_id, local_id, owner = account
    target = f"email-conflict-{uuid4().hex}@example.test"
    current, new = _start_change(primary, mail, email, target, password)
    assert landing.post("/api/auth/email/complete", json={"token_hash": current}).status_code == 200
    before = _stored_state(owner, local_id)
    collision_id = None
    real_commit = AuditSession.commit

    def fail_only_admission(db):
        db.flush()
        # A flushed clean User may leave SQLAlchemy's weak identity map. Observe
        # the real transaction instead of silently missing the injected fault.
        if db.scalar(select(User.email).where(User.id == local_id)) == target:
            raise SQLAlchemyError("owned email transaction failure")
        return real_commit(db)

    try:
        if failure == "all_row_collision":
            with Session(owner) as db:
                organization = db.get(WorkspaceProfile, membership_of(db, local_id).org_id)
                collision, _membership = create_member(db, organization,
                    email=target,
                    username=f"email-collision-{uuid4().hex[:16]}",
                    role="member",
                    status="disabled",
                    is_deleted=True,
                )
                db.commit()
                collision_id = collision.id
        with ExitStack() as stack:
            if failure == "post_flush_commit":
                stack.enter_context(patch.object(AuditSession, "commit", fail_only_admission))
            response = landing.post("/api/auth/email/complete", json={"token_hash": new})
        assert response.status_code == (409 if collision_id is not None else 503)
        assert response.json()["detail"]["code"] == "email_change_incomplete"
        assert response.headers.get_list("set-cookie") == []
        assert _stored_state(owner, local_id) == before
        assert get_supabase_auth_client().get_admin_user(provider_id).email == target
        assert landing.get("/api/auth/me").status_code == 401
    finally:
        if collision_id is not None:
            with Session(owner) as db:
                collision = db.get(User, collision_id)
                assert collision is not None
                db.delete(db.scalar(select(Membership).where(Membership.user_id == collision_id)))
                db.flush()
                db.delete(collision)
                db.commit()
    # This is real normal admission after legitimate conflict removal, not a repair command.
    assert (
        landing.post("/api/auth/login", json={"email": target, "password": password}).status_code
        == 200
    )
    after = _stored_state(owner, local_id)
    assert after[:2] == (target, provider_id)
    assert len(after[3] - before[3]) == 1


def test_native_final_email_session_requires_its_own_mfa_not_old_cookie_aal2(email_change_account):
    primary, landing, mail, account = email_change_account
    email, password, _, local_id, _ = account
    primary.headers["X-CSRF-Token"] = primary.cookies.get("openslate_csrf")
    enrolled = primary.post("/api/auth/mfa/factors", json={"friendly_name": "Owned email proof"})
    assert enrolled.status_code == 201
    factor_id = enrolled.json()["id"]
    secret = enrolled.json()["totp"]["secret"]
    verification = f"/api/auth/mfa/factors/{factor_id}/verification"
    assert primary.post(verification, json={"code": totp(secret)}).status_code == 200
    assert primary.get("/api/auth/mfa").json()["assurance_level"] == "aal2"
    target = f"email-mfa-{uuid4().hex}@example.test"
    current, new = _start_change(primary, mail, email, target, password)
    assert landing.post("/api/auth/email/complete", json={"token_hash": current}).status_code == 200
    completed = landing.post("/api/auth/email/complete", json={"token_hash": new})
    assert completed.status_code == 200 and completed.json()["authenticated"] is True
    assert landing.get("/api/auth/me").status_code == 403
    status = landing.get("/api/auth/mfa")
    assert status.status_code == 200
    assert status.json()["assurance_level"] == "aal1" and status.json()["required"] is True
    landing.headers["X-CSRF-Token"] = landing.cookies.get("openslate_csrf")
    assert landing.post(verification, json={"code": totp(secret)}).status_code == 200
    self = landing.get("/api/auth/me")
    assert self.status_code == 200
    assert self.json()["id"] == str(local_id) and self.json()["email"] == target


def test_native_concurrent_out_of_band_admissions_serialize_fresh_email_and_one_event(
    email_change_account, monkeypatch
):
    primary, _, mail, account = email_change_account
    email, password, provider_id, local_id, owner = account
    provider = get_supabase_auth_client()
    target = f"email-out-of-band-{uuid4().hex}@example.test"
    # Provider-only completion establishes an out-of-band CURRENT email; no local admission.
    access = primary.cookies.get("openslate_access")
    provider.request_email_change(access, target)
    current = _email_action(mail, email, "email_change")
    new = _email_action(mail, target, "email_change")
    assert provider.verify_email_change(current).tokens is None
    completed = provider.verify_email_change(new).tokens
    assert completed is not None
    provider.sign_out(completed.access_token, scope="local")
    before = _stored_state(owner, local_id)
    assert before[0] == email
    first_tokens = provider.password_grant(target, password)
    second_tokens = provider.password_grant(target, password)
    first_entered, second_attempted, second_observed, release = (Event() for _ in range(4))
    real_observe = provider.get_admin_user
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"])

    def observe(identifier):
        assert identifier == provider_id
        if not first_entered.is_set():
            first_entered.set()
            assert release.wait(10), "First admission provider observation was not released"
        else:
            second_observed.set()
        return real_observe(identifier)

    def entering_lock(conn, _cursor, statement, _parameters, _context, _many):
        if (
            conn.info.get("s24_admission") == "second"
            and "FROM users" in statement
            and "FOR UPDATE" in statement
        ):
            second_attempted.set()

    def admit(tokens, name):
        with AuditSession(runtime) as db:
            db.connection().info["s24_admission"] = name
            if name == "second":
                # A stale identity-map entry must be refreshed after the other admission commits.
                assert db.get(User, local_id).email == email
            issued = admit_provider_session(db, tokens, provider, ip_address="127.0.0.1")
            db.commit()
            return issued.session_id

    monkeypatch.setattr(provider, "get_admin_user", observe)
    event.listen(runtime, "before_cursor_execute", entering_lock)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(admit, first_tokens, "first")
            try:
                assert first_entered.wait(10), "First provider observation was not reached"
                second = pool.submit(admit, second_tokens, "second")
                assert second_attempted.wait(10), "Second admission did not attempt the User lock"
                assert not second_observed.is_set(), (
                    "Provider observation escaped admission serialization"
                )
            finally:
                release.set()
            first_session = first.result(timeout=10)
            second_session = second.result(timeout=10)
        after = _stored_state(owner, local_id)
        assert after[:2] == (target, provider_id)
        assert {first_session, second_session} <= after[2]
        assert len(after[3] - before[3]) == 1
        assert second_observed.is_set()
    finally:
        release.set()
        event.remove(runtime, "before_cursor_execute", entering_lock)
        runtime.dispose()


def test_native_wrong_purpose_hash_is_not_consumed_as_email_change(email_change_account):
    _, landing, mail, account = email_change_account
    email, _, _, local_id, owner = account
    assert landing.post("/api/auth/recovery/request", json={"email": email}).status_code == 204
    recovery = _email_action(mail, email, "recovery")
    before = _stored_state(owner, local_id)
    malformed = landing.post(
        "/api/auth/email/complete", json={"token_hash": recovery, "type": "recovery"}
    )
    assert malformed.status_code == 422 and malformed.headers.get_list("set-cookie") == []
    denied = landing.post("/api/auth/email/complete", json={"token_hash": recovery})
    assert denied.status_code == 400 and denied.headers.get_list("set-cookie") == []
    assert _stored_state(owner, local_id) == before
    # A real provider link still works for its actual purpose after the refusal.
    completed = landing.post(
        "/api/auth/recovery/complete",
        json={"token_hash": recovery, "password": token_urlsafe(32)},
    )
    assert completed.status_code == 204 and completed.headers.get_list("set-cookie") == []


@pytest.mark.parametrize(
    "loss", ["disabled", "deleted", "pending", "unbound", "cutoff", "guest_expiry"]
)
def test_native_final_confirmation_rechecks_local_admission_eligibility(email_change_account, loss):
    primary, landing, mail, account = email_change_account
    email, password, provider_id, local_id, owner = account
    target = f"email-ineligible-{uuid4().hex}@example.test"
    current, new = _start_change(primary, mail, email, target, password)
    assert landing.post("/api/auth/email/complete", json={"token_hash": current}).status_code == 200
    sponsor_id = None
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        if loss == "disabled":
            user.status = "disabled"
        elif loss == "deleted":
            user.is_deleted = True
        elif loss == "pending":
            user.status = "pending"
        elif loss == "unbound":
            user.supabase_user_id = None
        elif loss == "guest_expiry":
            membership = membership_of(db, user.id)
            sponsor, _sponsor_membership = create_member(
                db, db.get(WorkspaceProfile, membership.org_id),
                email=f"email-sponsor-{uuid4().hex}@example.test",
                username=f"email-sponsor-{uuid4().hex[:16]}",
                role="member",
                status="active",
            )
            sponsor_id = sponsor.id
            membership.role, membership.sponsor_user_id = "guest", sponsor_id
            membership.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        else:
            user.tokens_valid_after = datetime.now(UTC) + timedelta(minutes=1)
        db.commit()
    before = _stored_state(owner, local_id)
    try:
        completed = landing.post("/api/auth/email/complete", json={"token_hash": new})
        if loss == "guest_expiry":
            assert completed.status_code == 200
            me = landing.get("/api/auth/me")
            assert me.status_code == 200 and me.json()["current_organization"] is None
            assert me.json()["email"] == target
            assert landing.get("/api/boards").status_code == 403
            return
        assert completed.status_code == 409
        assert completed.json()["detail"]["code"] == "email_change_incomplete"
        assert completed.headers.get_list("set-cookie") == []
        assert _stored_state(owner, local_id) == before
        assert get_supabase_auth_client().get_admin_user(provider_id).email == target
    finally:
        if sponsor_id is not None:
            with Session(owner) as db:
                user = membership_of(db, local_id)
                user.role, user.sponsor_user_id, user.expires_at = "member", None, None
                db.flush()
                db.delete(db.scalar(select(Membership).where(Membership.user_id == sponsor_id)))
                db.flush()
                db.delete(db.get(User, sponsor_id))
                db.commit()


@pytest.mark.parametrize("loss", ["expiry", "provider_session"])
def test_native_admission_rechecks_after_provider_latency_without_partial_database_effects(
    email_change_account, monkeypatch, loss
):
    from app.systems.access.identity import provider_sessions

    primary, _, mail, account = email_change_account
    email, _, provider_id, local_id, owner = account
    provider = get_supabase_auth_client()
    target = f"email-latency-{uuid4().hex}@example.test"
    provider.request_email_change(primary.cookies.get("openslate_access"), target)
    assert provider.verify_email_change(_email_action(mail, email, "email_change")).tokens is None
    tokens = provider.verify_email_change(_email_action(mail, target, "email_change")).tokens
    assert tokens is not None
    claims = provider.verify_access_token(tokens.access_token)
    before = _stored_state(owner, local_id)
    real_observe = provider.get_admin_user
    def after_provider_io(identifier):
        observed = real_observe(identifier)
        if loss == "expiry":
            monkeypatch.setattr(provider_sessions, "utc_now", lambda: claims.expires_at)
        elif loss == "provider_session":
            provider.sign_out(tokens.access_token, scope="local")
        return observed

    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
    monkeypatch.setattr(provider, "get_admin_user", after_provider_io)
    try:
        with AuditSession(runtime) as db:
            with pytest.raises(InvalidCredentials):
                admit_provider_session(db, tokens, provider, ip_address="127.0.0.1")
            db.rollback()
        assert _stored_state(owner, local_id) == before
        assert real_observe(provider_id).email == target
    finally:
        if loss != "provider_session":
            provider.sign_out(tokens.access_token, scope="local")
        runtime.dispose()


def test_native_confirmed_email_keeps_current_password_and_recovery_equalities(
    email_change_account,
):
    primary, landing, mail, account = email_change_account
    email, password, _, local_id, owner = account
    target = f"email-equalities-{uuid4().hex}@example.test"
    current, new = _start_change(primary, mail, email, target, password)
    assert landing.post("/api/auth/email/complete", json={"token_hash": current}).status_code == 200
    assert landing.post("/api/auth/email/complete", json={"token_hash": new}).status_code == 200
    confirmations = _stored_state(owner, local_id)[3]
    replacement = token_urlsafe(32)
    landing.headers["X-CSRF-Token"] = landing.cookies.get("openslate_csrf")
    changed = landing.post(
        "/api/auth/password/change", json={"current_password": password, "password": replacement}
    )
    assert changed.status_code == 200
    assert changed.json() == {"authenticated": True, "setup_required": False}
    assert landing.get("/api/auth/me").json()["email"] == target
    landing.cookies.clear()
    assert landing.post("/api/auth/recovery/request", json={"email": target}).status_code == 204
    recovered_password = token_urlsafe(32)
    recovered = landing.post(
        "/api/auth/recovery/complete",
        json={
            "token_hash": _email_action(mail, target, "recovery"),
            "password": recovered_password,
        },
    )
    assert recovered.status_code == 204 and recovered.headers.get_list("set-cookie") == []
    assert (
        landing.post(
            "/api/auth/login", json={"email": target, "password": recovered_password}
        ).status_code
        == 200
    )
    assert landing.get("/api/auth/me").json()["id"] == str(local_id)
    assert _stored_state(owner, local_id)[3] == confirmations


def test_native_confirmed_email_preserves_admin_actor_and_old_target_binding_refusal(
    email_change_account,
):
    from fastapi import HTTPException

    from app.systems.access.identity.admin_recovery import recover_local_admin
    from app.systems.access.identity.security_recovery import (
        LocalSecurityRecoveryError,
        _same_binding,
    )
    from app.systems.access.users.security import Binding, provider_user

    primary, landing, mail, account = email_change_account
    email, password, provider_id, local_id, owner = account
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        membership_of(db, user.id).role = "admin"
        db.commit()
    target = f"email-admin-binding-{uuid4().hex}@example.test"
    current, new = _start_change(primary, mail, email, target, password)
    assert landing.post("/api/auth/email/complete", json={"token_hash": current}).status_code == 200
    assert landing.post("/api/auth/email/complete", json={"token_hash": new}).status_code == 200
    # This endpoint exercises the exact administrative actor checkpoint and
    # target provider binding with the freshly synchronized email, not a bypass.
    security = landing.get(f"/api/users/{local_id}/security")
    assert security.status_code == 200 and security.json()["user_id"] == str(local_id)
    provider = get_supabase_auth_client()
    assert provider_user(provider, Binding(local_id, provider_id, target)).email == target
    with pytest.raises(HTTPException) as denied:
        provider_user(provider, Binding(local_id, provider_id, email))
    assert denied.value.status_code == 409
    assert denied.value.detail["code"] == "security_binding_changed"
    with Session(owner) as db:
        user = db.get(User, local_id)
        assert user is not None
        _same_binding(user, provider_id, target)
        with pytest.raises(LocalSecurityRecoveryError, match="binding changed"):
            _same_binding(user, provider_id, email)
    with AuditSession(owner) as db:
        recovered = recover_local_admin(db, local_id, local_invocation=True, elevated=True)
        assert recovered.user_id == local_id
    assert _email_action(mail, target, "recovery")
