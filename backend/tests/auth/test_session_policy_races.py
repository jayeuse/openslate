"""Policy rollback and completion ordering at real PostgreSQL lock boundaries."""

from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_user_cache import forget_provider_user
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile

pytest_plugins = ("tests.auth.session_policy_support",)

pytestmark = pytest.mark.integration


def test_locked_session_refuses_whole_policy_clamp_without_partial_commit(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        before = db.query(WorkspaceProfile).one()
        revision = before.revision
        deadline = db.get(IdentitySession, world.session_ids[0]).expires_at
    with Session(world.owner) as blocker:
        blocker.scalar(
            select(IdentitySession)
            .where(IdentitySession.id == world.session_ids[0])
            .with_for_update()
        )
        result = world.client.patch(
            "/api/workspace/security",
            headers=world.headers(slot=3),
            json={"revision": revision, "session_timeout_minutes": 15},
        )
        assert result.status_code == 503
        blocker.rollback()
    with Session(world.owner) as db:
        profile = db.query(WorkspaceProfile).one()
        assert profile.revision == revision and profile.session_timeout_minutes == 60
        assert db.get(IdentitySession, world.session_ids[0]).expires_at == deadline


def test_locked_user_refuses_entire_episode_change_without_revision_or_deadline_write(policy_world):
    world = policy_world
    with Session(world.owner) as db:
        revision = db.query(WorkspaceProfile).one().revision
    with Session(world.owner) as blocker:
        blocker.scalar(select(User).where(User.id == world.target_id).with_for_update())
        result = world.client.patch(
            "/api/workspace/security",
            headers=world.headers(),
            json={
                "revision": revision,
                "mfa_require_member": True,
                "mfa_grace_days": 1,
                "session_timeout_minutes": 15,
            },
        )
        assert result.status_code == 503
        blocker.rollback()
    with Session(world.owner) as db:
        profile = db.query(WorkspaceProfile).one()
        assert profile.revision == revision and not profile.mfa_require_member
        assert profile.session_timeout_minutes == 60
        assert db.get(User, world.target_id).mfa_required_since is None


@pytest.mark.parametrize("loss, expected", [("role", 403), ("session", 401), ("cutoff", 401)])
def test_all_role_save_rechecks_actor_after_unlocked_provider_evidence(
    policy_world, loss, expected
):
    world = policy_world
    world.factor_status = "verified"
    revision = world.client.get("/api/workspace/security", headers=world.headers("aal2")).json()[
        "revision"
    ]
    calls = [0]

    def actor_changes(request):
        if request.url.path == f"/auth/v1/admin/users/{world.provider_id}":
            calls[0] += 1
            if calls[0] == 2:
                with Session(world.owner) as db:
                    actor = db.get(User, world.actor_id)
                    if loss == "role":
                        actor.role = "member"
                    elif loss == "cutoff":
                        actor.tokens_valid_after = world.clock + timedelta(minutes=1)
                    else:
                        db.get(IdentitySession, world.session_ids[0]).revoked_at = world.clock
                    db.commit()
        return None

    world.hook = actor_changes
    # Admission reads the provider account again instead of reusing the GET's read.
    forget_provider_user(world.provider_id)
    result = world.client.patch(
        "/api/workspace/security",
        headers=world.headers("aal2"),
        json={
            "revision": revision,
            "mfa_require_admin": True,
            "mfa_require_member": True,
            "mfa_require_guest": True,
        },
    )
    assert result.status_code == expected
    with Session(world.owner) as db:
        profile = db.query(WorkspaceProfile).one()
        assert profile.revision == revision and not profile.mfa_require_admin


@pytest.mark.parametrize("qualification", ["required", "optional", "grace"])
def test_cap_reconciles_only_real_blocked_mfa_completion_and_retains_current(
    policy_world, qualification
):
    world = policy_world
    world.policy(
        session_concurrent_limit=2,
        mfa_require_admin=qualification != "optional",
        mfa_grace_days=1 if qualification == "grace" else 0,
    )
    world.factor_status = "unverified"
    with Session(world.owner) as db:
        actor = db.get(User, world.actor_id)
        actor.mfa_required_since = world.clock
        for slot, session_id in enumerate(world.session_ids):
            db.get(IdentitySession, session_id).created_at = world.clock - timedelta(
                minutes=4 - slot
            )
        db.commit()
    assert len([row for row in world.sessions() if row.revoked_at is None]) == 4
    result = world.client.post(
        f"/api/auth/mfa/factors/{world.factor_id}/verification",
        headers=world.headers(slot=2),
        json={"code": "123456"},
    )
    assert result.status_code == 200
    with Session(world.owner) as db:
        active = {row.id for row in world.sessions() if row.revoked_at is None}
        if qualification == "required":
            assert active == {world.session_ids[2], world.session_ids[3]}
            for old in world.session_ids[:2]:
                row = db.get(IdentitySession, old)
                assert row.provider_signout_pending_at is not None
        else:
            assert active == set(world.session_ids)
        assert db.get(User, world.actor_id).tokens_valid_after is None


@pytest.mark.parametrize("pending", [False, True])
def test_cap_applies_at_eligible_admission_but_allows_pending_mfa_excess(policy_world, pending):
    world = policy_world
    world.policy(session_concurrent_limit=2, mfa_require_admin=pending)
    world.login_slot = 4
    with Session(world.owner) as db:
        db.get(User, world.actor_id).mfa_required_since = world.clock
        for slot, session_id in enumerate(world.session_ids):
            db.get(IdentitySession, session_id).created_at = world.clock - timedelta(
                minutes=4 - slot
            )
        db.commit()
    result = world.client.post(
        "/api/auth/token", json={"email": world.email, "password": world.password}
    )
    assert result.status_code == 200
    active = [row for row in world.sessions() if row.revoked_at is None]
    incoming = next(row for row in active if row.provider_session_id == world.provider_sessions[4])
    assert len(active) == (5 if pending else 2)
    if not pending:
        assert {row.id for row in active} == {world.session_ids[3], incoming.id}


def test_stored_aal2_repeated_verification_does_not_evict_new_pending_sessions(policy_world):
    world = policy_world
    world.policy(session_concurrent_limit=2, mfa_require_admin=True)
    world.factor_status = "unverified"
    with Session(world.owner) as db:
        db.get(User, world.actor_id).mfa_required_since = world.clock
        db.commit()
    path = f"/api/auth/mfa/factors/{world.factor_id}/verification"
    assert (
        world.client.post(path, headers=world.headers(slot=2), json={"code": "123456"}).status_code
        == 200
    )
    for slot in (4, 5):
        world.login_slot = slot
        assert (
            world.client.post(
                "/api/auth/token", json={"email": world.email, "password": world.password}
            ).status_code
            == 200
        )
    before = {row.id for row in world.sessions() if row.revoked_at is None}
    assert len(before) == 4
    world.policy(session_concurrent_limit=1)
    # The stale presented AAL1 still points to stored-current AAL2, including a lost response.
    assert (
        world.client.post(path, headers=world.headers(slot=2), json={"code": "123456"}).status_code
        == 200
    )
    assert {row.id for row in world.sessions() if row.revoked_at is None} == before


def test_failed_mfa_cap_commit_rolls_back_other_victims_and_invalidates_current(
    policy_world, monkeypatch
):
    from sqlalchemy.exc import SQLAlchemyError

    from app.core.database.session import AuditSession

    world = policy_world
    world.policy(session_concurrent_limit=2, mfa_require_admin=True)
    world.factor_status = "unverified"
    with Session(world.owner) as db:
        db.get(User, world.actor_id).mfa_required_since = world.clock
        db.commit()
    original = AuditSession.commit
    calls = [0]

    def fail_once(db):
        calls[0] += 1
        if calls[0] == 1:
            raise SQLAlchemyError("owned commit failure")
        return original(db)

    monkeypatch.setattr(AuditSession, "commit", fail_once)
    result = world.client.post(
        f"/api/auth/mfa/factors/{world.factor_id}/verification",
        headers=world.headers(slot=2),
        json={"code": "123456"},
    )
    assert result.status_code == 503
    with Session(world.owner) as db:
        assert db.get(IdentitySession, world.session_ids[2]).revoked_at is not None
        for old in (world.session_ids[0], world.session_ids[1], world.session_ids[3]):
            row = db.get(IdentitySession, old)
            assert row.revoked_at is None and row.provider_signout_pending_at is None


def test_concurrent_mfa_completions_refresh_one_locked_inventory_and_stay_within_cap(policy_world):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from fastapi.testclient import TestClient
    from sqlalchemy import event

    from app.core.config import get_settings
    from app.core.database.session import get_engine

    world = policy_world
    world.policy(session_concurrent_limit=2, mfa_require_admin=True)
    world.factor_status = "unverified"
    with Session(world.owner) as db:
        db.get(User, world.actor_id).mfa_required_since = world.clock
        db.commit()
    entered, second_query, release = Event(), Event(), Event()
    attempted = [0]

    def user_lock_attempt(_connection, _cursor, statement, _parameters, _context, _many):
        if "FROM users" in statement and "FOR UPDATE OF users" in statement:
            attempted[0] += 1
            if attempted[0] == 2:
                second_query.set()

    def held_provider(request):
        if request.url.path.endswith("/challenge") and not entered.is_set():
            entered.set()
            assert release.wait(15), "Owned provider barrier did not release"
        return None

    world.hook = held_provider
    engine = get_engine()
    event.listen(engine, "before_cursor_execute", user_lock_attempt)
    clients = [
        TestClient(world.client.app, base_url=get_settings().public_origin) for _ in range(2)
    ]
    path = f"/api/auth/mfa/factors/{world.factor_id}/verification"
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(
                clients[0].post, path, headers=world.headers(slot=2), json={"code": "123456"}
            )
            assert entered.wait(15), "First completion must reach the real locked provider boundary"
            second = pool.submit(
                clients[1].post, path, headers=world.headers(slot=3), json={"code": "123456"}
            )
            assert second_query.wait(15), "Second completion must attempt its PostgreSQL user lock"
            release.set()
            assert first.result(timeout=20).status_code == 200
            assert second.result(timeout=20).status_code == 200
        active = {row.id for row in world.sessions() if row.revoked_at is None}
        assert active == {world.session_ids[2], world.session_ids[3]}
    finally:
        release.set()
        event.remove(engine, "before_cursor_execute", user_lock_attempt)
        for client in clients:
            client.close()


def test_expired_stored_token_cannot_be_used_as_cap_completion_evidence(policy_world):
    from datetime import UTC, datetime, timedelta

    from cryptography.fernet import Fernet

    from app.core.config import get_settings

    world = policy_world
    world.policy(session_concurrent_limit=1, mfa_require_admin=True)
    world.factor_status = "unverified"
    cipher = Fernet(get_settings().supabase_session_encryption_key.get_secret_value().encode())
    with Session(world.owner) as db:
        row = db.get(IdentitySession, world.session_ids[2])
        row.provider_access_token_encrypted = cipher.encrypt(
            world.access(slot=2, exp=datetime.now(UTC) - timedelta(minutes=1)).encode()
        ).decode()
        db.commit()
    world.calls.clear()
    result = world.client.post(
        f"/api/auth/mfa/factors/{world.factor_id}/verification",
        headers=world.headers(slot=2),
        json={"code": "123456"},
    )
    assert result.status_code == 401
    assert not any(path.endswith("/challenge") for _, path in world.calls)
    assert len([row for row in world.sessions() if row.revoked_at is None]) == 4


@pytest.mark.parametrize("loss", ["role", "expiry", "binding", "token"])
def test_mfa_status_rechecks_current_authority_after_provider_read(policy_world, loss):
    world = policy_world
    world.policy(mfa_require_member=True)

    def changed(request):
        if request.url.path == "/auth/v1/user":
            with Session(world.owner) as db:
                actor = db.get(User, world.actor_id)
                if loss == "role":
                    actor.role, actor.mfa_required_since = "member", world.clock
                elif loss == "expiry":
                    db.get(IdentitySession, world.session_ids[0]).expires_at = (
                        world.clock - timedelta(seconds=1)
                    )
                elif loss == "token":
                    world.clock += timedelta(minutes=20)
                else:
                    actor.supabase_user_id = uuid4()
                db.commit()
        return None

    world.hook = changed
    response = world.client.get("/api/auth/mfa", headers=world.headers())
    if loss == "role":
        assert response.status_code == 200
        assert response.json()["policy_required"] is True
        assert response.json()["required_since"] is not None
    else:
        assert response.status_code == 401


@pytest.mark.parametrize(
    "loss, expected", [("absolute", 401), ("grace", 403), ("factor", 403), ("removed", 403)]
)
def test_person_security_rechecks_actor_deadline_and_mfa_after_target_read(
    policy_world, loss, expected
):
    world = policy_world
    if loss == "absolute":
        world.policy(session_absolute_lifetime_minutes=1)
    elif loss == "grace":
        world.policy(mfa_require_admin=True, mfa_grace_days=1)
    elif loss == "removed":
        world.policy(mfa_require_admin=True)
        world.factor_status = "verified"
    with Session(world.owner) as db:
        target_provider = db.get(User, world.target_id).supabase_user_id
        db.get(User, world.actor_id).mfa_required_since = (
            world.clock - timedelta(days=1) + timedelta(seconds=10)
        )
        db.get(IdentitySession, world.session_ids[0]).created_at = world.clock - timedelta(
            seconds=50
        )
        db.commit()

    def changed(request):
        if request.url.path == f"/auth/v1/admin/users/{target_provider}":
            if loss in {"factor", "removed"}:
                world.factor_status = "verified" if loss == "factor" else None
            else:
                world.clock += timedelta(seconds=20)
        return None

    world.hook = changed
    response = world.client.get(
        f"/api/users/{world.target_id}/security",
        headers=world.headers("aal2" if loss == "removed" else "aal1"),
    )
    assert response.status_code == expected


def test_admin_mfa_reset_cleans_captured_target_after_actor_deadline_without_restarting_grace(
    policy_world,
):
    world = policy_world
    world.factor_status = "verified"
    world.policy(session_absolute_lifetime_minutes=1, mfa_require_member=True, mfa_grace_days=1)
    since, target_session, factor_id = world.clock - timedelta(days=2), uuid4(), uuid4()
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        target.mfa_required_since = since
        target_provider = target.supabase_user_id
        db.get(IdentitySession, world.session_ids[0]).created_at = world.clock - timedelta(
            seconds=50
        )
        db.add(
            IdentitySession(
                id=target_session,
                user_id=target.id,
                provider_user_id=target_provider,
                provider_session_id=uuid4(),
                refresh_token_digest=uuid4().hex * 2,
                csrf_token_digest=uuid4().hex * 2,
                created_at=world.clock,
                refreshed_at=world.clock,
                expires_at=world.clock + timedelta(hours=1),
            )
        )
        db.commit()
    factors = [factor_id]

    def provider(request):
        base = f"/auth/v1/admin/users/{target_provider}/factors"
        if request.url.path == base:
            return httpx.Response(200, json=[{"id": str(item)} for item in factors])
        if request.method == "DELETE" and request.url.path == f"{base}/{factor_id}":
            factors.clear()
            world.clock += timedelta(seconds=20)
            return httpx.Response(200, json={"id": str(factor_id)})
        return None

    world.hook = provider
    response = world.client.post(
        f"/api/users/{world.target_id}/mfa/reset", headers=world.headers("aal2"), json={}
    )
    assert response.status_code == 503
    assert response.json()["detail"]["local_revocation"] == "committed"
    assert response.json()["detail"]["factors_cleared"] is True
    with Session(world.owner) as db:
        assert db.get(IdentitySession, target_session).revoked_at is not None
        assert db.get(User, world.target_id).mfa_required_since == since


def test_cached_refresh_cannot_renew_a_deadline_crossed_during_provider_read(policy_world):
    world = policy_world
    world.policy(session_absolute_lifetime_minutes=1)
    with Session(world.owner) as db:
        db.get(IdentitySession, world.session_ids[0]).created_at = world.clock - timedelta(
            seconds=50
        )
        db.commit()

    def latency(request):
        if request.url.path == f"/auth/v1/admin/users/{world.provider_id}":
            world.clock += timedelta(seconds=20)
        return None

    world.hook = latency
    world.client.cookies.set("openslate_refresh", world.handles[0])
    world.client.cookies.set("openslate_csrf", world.csrf[0])
    response = world.client.post("/api/auth/refresh", headers={"X-CSRF-Token": world.csrf[0]})
    assert response.status_code == 401
    assert world.sessions()[0].revoked_at is not None


def test_console_recovery_refuses_locked_episode_before_reset_or_factor_effect(policy_world):
    from app.core.database.session import AuditSession, get_engine
    from app.systems.access.identity.security_recovery import (
        LocalSecurityRecoveryError,
        recover_workspace_security,
    )

    world = policy_world
    world.policy(mfa_require_member=True)
    with Session(world.owner) as db:
        db.get(User, world.target_id).mfa_required_since = world.clock
        revision = db.query(WorkspaceProfile).one().revision
        db.commit()
    with Session(world.owner) as blocker:
        blocker.scalar(select(User).where(User.id == world.target_id).with_for_update())
        with AuditSession(get_engine()) as db:
            with pytest.raises(LocalSecurityRecoveryError):
                recover_workspace_security(db, world.actor_id, local_invocation=True, elevated=True)
        blocker.rollback()
    with Session(world.owner) as db:
        profile = db.query(WorkspaceProfile).one()
        assert profile.mfa_require_member and profile.revision == revision
        assert db.get(User, world.target_id).mfa_required_since == world.clock
    assert not any("/factors" in path for _, path in world.calls)
