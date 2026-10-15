"""Real signed-auth and PostgreSQL session/MFA policy journeys."""

from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_user_cache import forget_provider_user
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile

pytest_plugins = ("tests.auth.session_policy_support",)

pytestmark = pytest.mark.integration


def test_mfa_status_exposes_optional_policy_without_fabricated_episode(policy_world):
    world = policy_world
    result = world.client.get("/api/auth/mfa", headers=world.headers())
    assert result.status_code == 200
    assert result.json() == {
        "user_id": str(world.actor_id),
        "assurance_level": "aal1",
        "required": False,
        "policy_required": False,
        "required_since": None,
        "enrollment_deadline": None,
        "factors": [],
    }


@pytest.mark.parametrize("role", ["admin", "member", "guest"])
def test_role_grace_expires_but_verified_factor_always_requires_aal2(policy_world, role):
    world = policy_world
    since = world.clock - timedelta(days=1) + timedelta(minutes=2)
    world.policy(**{f"mfa_require_{role}": True}, mfa_grace_days=1)
    with Session(world.owner) as db:
        actor = sole_active_membership(db, world.actor_id)
        actor.role = role
        if role == "guest":
            actor.sponsor_user_id, actor.expires_at = (
                world.target_id,
                world.clock + timedelta(days=2),
            )
        actor.mfa_required_since = since
        org_id = actor.org_id
        db.commit()
    status = world.client.get("/api/auth/mfa", headers=world.headers())
    assert status.status_code == 200
    assert status.json()["policy_required"] is True
    assert status.json()["required"] is False
    assert status.json()["required_since"] == since.isoformat().replace("+00:00", "Z")
    assert status.json()["enrollment_deadline"] == (since + timedelta(days=1)).isoformat().replace(
        "+00:00", "Z"
    )
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 200
    world.clock += timedelta(minutes=3)
    account = world.client.get("/api/auth/me", headers=world.headers())
    assert account.status_code == 200 and account.json()["current_organization"] is None
    assert account.json()["default_organization_blocked"] == "mfa_required"
    explicit = world.client.get("/api/auth/me", headers={
        **world.headers(), "X-Org": str(org_id),
    })
    assert explicit.status_code == 403 and explicit.json()["detail"]["code"] == "mfa_required"
    resources = world.client.get("/api/boards", headers=world.headers())
    assert resources.status_code == 403 and resources.json()["detail"]["code"] == "mfa_required"
    assert world.client.get("/api/auth/mfa", headers=world.headers()).json()["required"] is True
    with Session(world.owner) as db:
        sole_active_membership(db, world.actor_id).mfa_required_since = None
        db.commit()
    missing = world.client.get("/api/auth/mfa", headers=world.headers()).json()
    assert missing["required"] is True and missing["enrollment_deadline"] is None
    world.policy(**{f"mfa_require_{role}": False})
    world.factor_status = "verified"
    # A factor added directly in Supabase may wait out the 10 s account reuse.
    forget_provider_user(world.provider_id)
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 403
    assert world.client.get("/api/auth/me", headers=world.headers("aal2")).status_code == 200


def test_policy_patch_preserves_independent_roles_zero_false_and_off_limits(policy_world):
    world = policy_world
    before = world.client.get("/api/workspace/security", headers=world.headers())
    assert before.status_code == 200
    original_sessions = [(row.id, row.revoked_at) for row in world.sessions()]
    result = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(),
        json={
            "revision": before.json()["revision"],
            "mfa_require_member": True,
            "mfa_require_guest": False,
            "mfa_grace_days": 0,
            "session_absolute_lifetime_minutes": 100,
            "session_concurrent_limit": 2,
            "login_failed_attempt_threshold": 1,
            "login_window_minutes": 2,
            "login_cooldown_minutes": 3,
        },
    )
    assert result.status_code == 200
    assert result.json()["mfa_require_admin"] is False
    assert result.json()["mfa_require_member"] is True
    assert result.json()["mfa_require_guest"] is False
    assert result.json()["mfa_grace_days"] == 0
    assert result.json()["session_concurrent_limit"] == 2
    assert [(row.id, row.revoked_at) for row in world.sessions()] == original_sessions
    cleared = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(),
        json={
            "revision": result.json()["revision"],
            "session_absolute_lifetime_minutes": None,
            "session_concurrent_limit": None,
        },
    )
    assert cleared.status_code == 200
    assert cleared.json()["session_absolute_lifetime_minutes"] is None
    assert cleared.json()["session_concurrent_limit"] is None
    assert cleared.json()["mfa_require_member"] is True
    assert cleared.json()["login_failed_attempt_threshold"] == 1
    assert "mfa_policy" not in cleared.json()


def test_policy_rejects_invalid_partial_input_without_revision_change(policy_world):
    # The other refused bodies are rows of the stack-free WorkspaceSecurityUpdate table in
    # tests/workspace/test_workspace_security_schema.py; this route case owns the 422 status
    # and the unchanged revision.
    world = policy_world
    with Session(world.owner) as db:
        revision = db.query(WorkspaceProfile).one().revision
    result = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(),
        json={"revision": revision, "mfa_policy": "everyone"},
    )
    assert result.status_code == 422
    with Session(world.owner) as db:
        assert db.query(WorkspaceProfile).one().revision == revision


@pytest.mark.parametrize(
    "setting, tightened, loosened, elapsed",
    [
        ("session_timeout_minutes", 15, 60, 20),
        ("session_absolute_lifetime_minutes", 1, None, 2),
    ],
)
@pytest.mark.parametrize("observe_denial", [False, True])
def test_tighten_then_loosen_never_revives_an_unobserved_session(
    policy_world,
    setting,
    tightened,
    loosened,
    elapsed,
    observe_denial,
):
    world = policy_world
    old = world.clock - timedelta(minutes=elapsed)
    with Session(world.owner) as db:
        remote = db.get(IdentitySession, world.session_ids[0])
        remote.created_at = remote.refreshed_at = old
        remote.expires_at = world.clock + timedelta(minutes=60)
        revision = db.query(WorkspaceProfile).one().revision
        db.commit()
    save = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(slot=3),
        json={"revision": revision, setting: tightened},
    )
    assert save.status_code == 200
    expected = old + timedelta(minutes=tightened)
    with Session(world.owner) as db:
        assert db.get(IdentitySession, world.session_ids[0]).expires_at == expected
    if observe_denial:
        assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 401
    loosen = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(slot=3),
        json={"revision": save.json()["revision"], setting: loosened},
    )
    assert loosen.status_code == 200
    assert world.client.get("/api/auth/me", headers=world.headers()).status_code == 401
    with Session(world.owner) as db:
        assert db.get(IdentitySession, world.session_ids[0]).expires_at == expected
        assert db.get(IdentitySession, world.session_ids[0]).revoked_at is None


def test_current_deadline_filters_session_totals_and_returned_expiry(policy_world):
    world = policy_world
    world.policy(session_timeout_minutes=15, session_absolute_lifetime_minutes=30)
    with Session(world.owner) as db:
        expired = db.get(IdentitySession, world.session_ids[0])
        expired.created_at = expired.refreshed_at = world.clock - timedelta(minutes=20)
        expired.expires_at = world.clock + timedelta(minutes=60)
        current = db.get(IdentitySession, world.session_ids[3])
        current.created_at = world.clock - timedelta(minutes=25)
        current.refreshed_at = world.clock
        current.expires_at = world.clock + timedelta(minutes=60)
        db.commit()
    for path in ("/api/auth/admin-sessions", f"/api/users/{world.actor_id}/sessions"):
        result = world.client.get(path, headers=world.headers(slot=3), params={"limit": 1})
        assert result.status_code == 200
        assert result.json()["pagination"]["total"] == 3
        assert str(world.session_ids[0]) not in [row["id"] for row in result.json()["items"]]
    own = world.client.get("/api/auth/sessions", headers=world.headers(slot=3))
    assert own.status_code == 200
    rows = {item["id"]: item for item in own.json()}
    assert str(world.session_ids[0]) not in rows
    assert rows[str(world.session_ids[3])]["expires_at"] == (
        world.clock + timedelta(minutes=5)
    ).isoformat().replace("+00:00", "Z")


@pytest.mark.parametrize("boundary", ["refresh", "mfa"])
def test_expired_effective_session_never_reaches_provider_rotation(policy_world, boundary):
    world = policy_world
    world.policy(session_absolute_lifetime_minutes=1)
    world.factor_status = "unverified"
    with Session(world.owner) as db:
        db.get(IdentitySession, world.session_ids[0]).created_at = world.clock - timedelta(
            minutes=2
        )
        db.commit()
    world.calls.clear()
    if boundary == "mfa":
        result = world.client.post(
            f"/api/auth/mfa/factors/{world.factor_id}/verification",
            headers=world.headers(),
            json={"code": "123456"},
        )
    else:
        world.client.cookies.set("openslate_refresh", world.handles[0])
        result = world.client.post("/api/auth/refresh", headers={"X-CSRF-Token": world.csrf[0]})
        world.client.cookies.clear()
    assert result.status_code == 401
    assert not any(
        path.endswith("/challenge") or path.endswith("/verify") or path == "/auth/v1/token"
        for _, path in world.calls
    )


def test_provider_latency_cannot_renew_beyond_absolute_boundary(policy_world):
    world = policy_world
    world.policy(session_absolute_lifetime_minutes=1)
    world.factor_status = "unverified"
    with Session(world.owner) as db:
        row = db.get(IdentitySession, world.session_ids[0])
        row.created_at = world.clock - timedelta(seconds=50)
        created = row.created_at
        db.commit()

    def delay(request):
        if request.url.path.endswith("/verify"):
            world.clock += timedelta(seconds=20)
        return None

    world.hook = delay
    result = world.client.post(
        f"/api/auth/mfa/factors/{world.factor_id}/verification",
        headers=world.headers(),
        json={"code": "123456"},
    )
    assert result.status_code == 401
    with Session(world.owner) as db:
        row = db.get(IdentitySession, world.session_ids[0])
        assert row.created_at == created
        assert row.revoked_at is not None


def test_policy_episode_survives_role_disable_grace_and_restarts_only_after_optional(policy_world):
    world = policy_world
    revision = world.client.get("/api/workspace/security", headers=world.headers()).json()[
        "revision"
    ]
    saved = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(),
        json={
            "revision": revision,
            "mfa_require_member": True,
            "mfa_grace_days": 1,
        },
    )
    assert saved.status_code == 200
    with Session(world.owner) as db:
        since = sole_active_membership(db, world.target_id).mfa_required_since
        assert since is not None
    enabled = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(),
        json={
            "revision": saved.json()["revision"],
            "mfa_require_admin": True,
            "mfa_grace_days": 2,
        },
    )
    assert enabled.status_code == 200
    promoted = world.client.patch(
        f"/api/users/{world.target_id}", headers=world.headers(), json={"role": "admin"}
    )
    assert promoted.status_code == 200
    for state in ("disabled", "active"):
        result = world.client.patch(
            f"/api/users/{world.target_id}", headers=world.headers(), json={"status": state}
        )
        assert result.status_code == 200
        with Session(world.owner) as db:
            assert sole_active_membership(db, world.target_id).mfa_required_since == since
    off = world.client.patch(
        "/api/workspace/security",
        headers=world.headers(),
        json={
            "revision": enabled.json()["revision"],
            "mfa_require_admin": False,
        },
    )
    assert off.status_code == 200
    with Session(world.owner) as db:
        assert sole_active_membership(db, world.target_id).mfa_required_since is None
    # A role transition into a still-required role starts a new continuous episode.
    result = world.client.patch(
        f"/api/users/{world.target_id}", headers=world.headers(), json={"role": "member"}
    )
    assert result.status_code == 200
    with Session(world.owner) as db:
        assert sole_active_membership(db, world.target_id).mfa_required_since is not None


@pytest.mark.parametrize(
    "provider_state, expected", [("none", 409), ("offline", 503), ("verified", 200)]
)
def test_all_role_requirement_requires_savers_live_verified_factor_before_any_write(
    policy_world, provider_state, expected
):
    import httpx

    world = policy_world
    world.factor_status = "verified" if provider_state == "verified" else None
    headers = world.headers("aal2" if provider_state == "verified" else "aal1")
    before = world.client.get("/api/workspace/security", headers=headers).json()
    if provider_state == "offline":
        calls = [0]

        def fail_after_admission(request):
            if request.url.path == f"/auth/v1/admin/users/{world.provider_id}":
                calls[0] += 1
                if calls[0] > 1:
                    return httpx.Response(503)
            return None

        world.hook = fail_after_admission
        # Admission reads the provider account again instead of reusing the GET's read.
        forget_provider_user(world.provider_id)
    result = world.client.patch(
        "/api/workspace/security",
        headers=headers,
        json={
            "revision": before["revision"],
            "mfa_require_admin": True,
            "mfa_require_member": True,
            "mfa_require_guest": True,
            "mfa_grace_days": 30,
        },
    )
    assert result.status_code == expected
    with Session(world.owner) as db:
        profile = db.query(WorkspaceProfile).one()
        if expected != 200:
            assert profile.revision == before["revision"]
            assert (
                not profile.mfa_require_admin
                and not profile.mfa_require_member
                and not profile.mfa_require_guest
            )
        else:
            assert (
                profile.mfa_require_admin
                and profile.mfa_require_member
                and profile.mfa_require_guest
            )
    if expected == 409:
        assert result.json()["detail"]["code"] == "mfa_enrollment_required"


def test_role_transition_clears_optional_and_starts_new_required_episode(policy_world):
    world = policy_world
    world.policy(mfa_require_member=True, mfa_grace_days=1)
    old = world.clock - timedelta(hours=12)
    with Session(world.owner) as db:
        sole_active_membership(db, world.target_id).mfa_required_since = old
        db.commit()
    promoted = world.client.patch(
        f"/api/users/{world.target_id}", headers=world.headers(), json={"role": "admin"}
    )
    assert promoted.status_code == 200
    with Session(world.owner) as db:
        assert sole_active_membership(db, world.target_id).mfa_required_since is None
    returned = world.client.patch(
        f"/api/users/{world.target_id}", headers=world.headers(), json={"role": "member"}
    )
    assert returned.status_code == 200
    with Session(world.owner) as db:
        since = sole_active_membership(db, world.target_id).mfa_required_since
        assert since is not None and since > old


def test_invitation_completion_starts_current_role_episode_and_replay_preserves_it(
    policy_world, monkeypatch
):
    from uuid import uuid4

    import httpx

    from app.core.config import get_settings
    from app.systems.access.users.acceptance import accept_verified_invitation
    from tests.auth.provider_jwt_support import signed_access

    world = policy_world
    world.policy(mfa_require_member=True, mfa_grace_days=1)
    operation = uuid4()
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        membership = sole_active_membership(db, target.id)
        target.status = membership.status = "pending"
        membership.invitation_accepted_at = None
        membership.invitation_sent_at = world.clock - timedelta(days=1)
        membership.provider_invitation_operation_id = operation
        provider_id, email = target.supabase_user_id, target.email
        db.commit()
    settings = get_settings()
    token = signed_access(
        world.key,
        user_id=str(provider_id),
        session_id=str(uuid4()),
        issuer=settings.supabase_auth_issuer,
        audience=settings.supabase_auth_audience,
    )
    user = {
        "id": str(provider_id),
        "email": email,
        "email_confirmed_at": "2026-01-01T00:00:00Z",
        "app_metadata": {
            "openslate_user_id": str(world.target_id),
            "openslate_invitation_operation_id": str(operation),
        },
    }

    def invitation_provider(request):
        if request.url.path == "/auth/v1/verify":
            return httpx.Response(
                200,
                json={
                    "access_token": token,
                    "refresh_token": "owned-invite-refresh",
                    "expires_in": 600,
                    "user": user,
                },
            )
        if request.url.path == "/auth/v1/user":
            return httpx.Response(200, json=user)
        return None

    world.hook = invitation_provider
    monkeypatch.setattr("app.systems.access.users.acceptance.utc_now", lambda: world.clock)
    result = world.client.post(
        "/api/auth/invitations/complete",
        json={
            "token_hash": "a" * 56,
            "password": world.password + "Aa9",
        },
    )
    assert result.status_code == 204
    with Session(world.owner) as db:
        target = db.get(User, world.target_id)
        membership = sole_active_membership(db, target.id)
        assert target.status == "active" and membership.mfa_required_since == world.clock
        since = membership.mfa_required_since
    world.clock += timedelta(minutes=1)
    with Session(world.owner) as db:
        replay = accept_verified_invitation(
            db, world.target_id, verified_email=email, verified_identity=world.target_id
        )
        assert sole_active_membership(db, replay.id).mfa_required_since == since
