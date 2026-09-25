"""Workspace authorization snapshot contracts."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError

from app.systems.access.policy.authorization import (
    WorkspaceRoleChanged,
    authorize_workspace_capabilities,
)
from app.systems.access.policy.models import (
    AccessGroup,
    AccessGroupMember,
    AccessPolicyVersion,
    AccessRule,
)
from app.systems.access.users.models import IdentityKind, Role, User, UserRole
from app.systems.access.users.permissions import Capability

NOW = datetime(2026, 9, 23, 9, 0, tzinfo=UTC)


def _persisted(row: Any, *, deleted: bool = False) -> Any:
    row.id = uuid4()
    row.is_deleted = deleted
    row.deleted_at = NOW if deleted else None
    row.created_at = NOW
    row.updated_at = NOW
    row.performed_by = None
    return row


def _role(
    name: str = "member", permissions: dict[str, bool] | None = None, *, deleted: bool = False
) -> Role:
    return _persisted(Role(role=name, permissions=permissions or {}), deleted=deleted)


def _user(
    role: Role,
    *,
    identity_kind: str = IdentityKind.INTERNAL.value,
    status: str = "active",
    expires_at: datetime | None = None,
    deleted: bool = False,
) -> User:
    return _persisted(
        User(
            email=f"{uuid4()}@example.com",
            username=f"user-{uuid4()}",
            identity_kind=identity_kind,
            status=status,
            expires_at=expires_at,
            role_id=role.id,
        ),
        deleted=deleted,
    )


def _version(revision: int = 4) -> AccessPolicyVersion:
    return _persisted(AccessPolicyVersion(singleton_key="workspace", revision=revision))


def _rule(
    capability: Capability,
    *,
    subject_kind: str = "everyone",
    subject_id: UUID | None = None,
    decision: str = "allow",
    policy_version: int = 4,
    scope_id: UUID | None = None,
) -> AccessRule:
    return _persisted(
        AccessRule(
            subject_kind=subject_kind,
            subject_id=subject_id,
            scope_kind="workspace",
            scope_id=scope_id,
            permission_id=capability.value,
            decision=decision,
            starts_at=None,
            ends_at=None,
            locked=False,
            policy_version=policy_version,
        )
    )


class _SnapshotDatabase:
    def __init__(
        self,
        *,
        actor: User,
        role: Role,
        rules: tuple[AccessRule, ...] = (),
        groups: tuple[tuple[AccessGroupMember, AccessGroup], ...] = (),
        version: AccessPolicyVersion | None = None,
        session: object | None = None,
    ) -> None:
        self.actor = actor
        self.role = role
        self.rules = rules
        self.groups = groups
        self.version = version or _version()
        self.session = session
        self.events: list[str] = []
        self.statements: list[object] = []
        self.session_lock_kwargs: dict[str, object] = {}
        self.rollback_calls = 0

    def scalar(self, statement: object) -> object:
        self.statements.append(statement)
        if len(self.events) == 0:
            self.events.append("version")
            return self.version
        if self.events[-1] == "session":
            self.events.append("role")
            return self.role
        if "role" not in self.events:
            self.events.append("role")
            return self.role
        self.events.append("user")
        return self.actor

    def get(self, _model: object, _identity: object, **_kwargs: object) -> object | None:
        self.session_lock_kwargs = _kwargs
        self.events.append("session")
        return self.session

    def execute(self, statement: object) -> object:
        self.events.append("groups")
        self.statements.append(statement)
        return SimpleNamespace(all=lambda: list(self.groups))

    def scalars(self, statement: object) -> object:
        self.events.append("rules")
        self.statements.append(statement)
        return SimpleNamespace(all=lambda: list(self.rules))

    def rollback(self) -> None:
        self.rollback_calls += 1


def _authorize(
    database: _SnapshotDatabase,
    *capabilities: Capability,
    session_id: UUID | None = None,
) -> User:
    return authorize_workspace_capabilities(
        database,
        actor_id=database.actor.id,
        expected_role_id=database.role.id,
        capabilities=capabilities,
        session_id=session_id,
        now=NOW,
    )


def test_workspace_authorizer_uses_one_version_locked_snapshot_for_every_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = _role(
        permissions={Capability.RECORDS_READ.value: True, Capability.MODULES_READ.value: True}
    )
    actor = _user(role)
    database = _SnapshotDatabase(actor=actor, role=role)
    seen: list[tuple[str, int, object]] = []

    from app.systems.access.policy import authorization
    from app.systems.access.policy.evaluator import AccessDecision, PolicyEvaluation

    def evaluate(**kwargs: object) -> PolicyEvaluation:
        seen.append((str(kwargs["capability"]), int(kwargs["policy_version"]), kwargs["rules"]))
        return PolicyEvaluation(
            decision=AccessDecision.ALLOW,
            reason="legacy_role_allow",  # type: ignore[arg-type]
            policy_version=4,
            source_rule_id=None,
            invalid=False,
            trace=(),
        )

    monkeypatch.setattr(authorization, "evaluate_access", evaluate)

    assert _authorize(database, Capability.RECORDS_READ, Capability.MODULES_READ) is actor
    assert database.events == ["version", "role", "groups", "user", "rules"]
    assert [item[:2] for item in seen] == [("modules.read", 4), ("records.read", 4)]
    assert seen[0][2] is seen[1][2]
    assert all(
        statement._for_update_arg.read is True
        for statement in (database.statements[0], *database.statements[1:])
    )


def test_internal_literal_administrator_is_protected_but_guest_administrator_is_denied() -> None:
    admin_role = _role(UserRole.ADMIN.value)
    internal = _user(admin_role)
    allowed = _SnapshotDatabase(
        actor=internal,
        role=admin_role,
        rules=(_rule(Capability.RECORDS_READ, decision="deny"),),
    )

    assert _authorize(allowed, Capability.RECORDS_READ) is internal

    guest = _user(
        admin_role,
        identity_kind=IdentityKind.GUEST.value,
        expires_at=NOW + timedelta(days=1),
    )
    denied = _SnapshotDatabase(actor=guest, role=admin_role)
    with pytest.raises(HTTPException) as raised:
        _authorize(denied, Capability.RECORDS_READ)
    assert raised.value.status_code == 403


def test_workspace_rules_preserve_everyone_group_and_user_precedence() -> None:
    role = _role(permissions={})
    actor = _user(role)
    group = _persisted(AccessGroup(name="Readers", description=""))
    membership = _persisted(AccessGroupMember(group_id=group.id, user_id=actor.id))
    database = _SnapshotDatabase(
        actor=actor,
        role=role,
        groups=((membership, group),),
        rules=(
            _rule(Capability.RECORDS_READ, decision="deny"),
            _rule(
                Capability.RECORDS_READ,
                subject_kind="group",
                subject_id=group.id,
                decision="deny",
            ),
            _rule(
                Capability.RECORDS_READ,
                subject_kind="user",
                subject_id=actor.id,
                decision="allow",
            ),
        ),
    )

    assert _authorize(database, Capability.RECORDS_READ) is actor


def test_legacy_role_grant_remains_the_baseline_without_rules() -> None:
    role = _role(permissions={Capability.RECORDS_READ.value: True})
    actor = _user(role)

    assert _authorize(_SnapshotDatabase(actor=actor, role=role), Capability.RECORDS_READ) is actor


def test_all_capabilities_must_allow_and_session_is_rechecked_after_policy_lock() -> None:
    role = _role(permissions={Capability.RECORDS_READ.value: True})
    actor = _user(role)
    session_id = uuid4()
    session = SimpleNamespace(
        user_id=actor.id,
        revoked_at=None,
        expires_at=NOW + timedelta(hours=1),
    )
    database = _SnapshotDatabase(actor=actor, role=role, session=session)

    with pytest.raises(HTTPException) as denied:
        _authorize(
            database,
            Capability.RECORDS_READ,
            Capability.RECORDS_WRITE,
            session_id=session_id,
        )
    assert denied.value.status_code == 403
    assert database.events == ["version", "session", "role", "groups", "user", "rules"]
    assert database.session_lock_kwargs["with_for_update"] is True


def test_session_failure_is_forbidden_before_loading_the_actor() -> None:
    role = _role()
    actor = _user(role)
    session = SimpleNamespace(user_id=actor.id, revoked_at=NOW, expires_at=NOW + timedelta(hours=1))
    database = _SnapshotDatabase(actor=actor, role=role, session=session)

    with pytest.raises(HTTPException) as denied:
        _authorize(database, Capability.RECORDS_READ, session_id=uuid4())
    assert denied.value.status_code == 403
    assert database.events == ["version", "session"]


@pytest.mark.parametrize(
    "failure", ["malformed", "database"], ids=["malformed-rule", "database-error"]
)
def test_malformed_policy_or_database_failure_is_unavailable(failure: str) -> None:
    role = _role()
    actor = _user(role)
    if failure == "malformed":
        database: Any = _SnapshotDatabase(
            actor=actor,
            role=role,
            rules=(_rule(Capability.RECORDS_READ, scope_id=uuid4()),),
        )
    else:
        database = _SnapshotDatabase(actor=actor, role=role)
        database.scalar = lambda _statement: (_ for _ in ()).throw(SQLAlchemyError("offline"))

    with pytest.raises(HTTPException) as unavailable:
        _authorize(database, Capability.RECORDS_READ)
    assert unavailable.value.status_code == 503
    assert database.rollback_calls == 1


def test_ordinary_policy_denial_is_forbidden() -> None:
    role = _role()
    actor = _user(role)
    database = _SnapshotDatabase(actor=actor, role=role)

    with pytest.raises(HTTPException) as denied:
        _authorize(database, Capability.RECORDS_READ)
    assert denied.value.status_code == 403
    assert database.rollback_calls == 1


@pytest.mark.parametrize(
    ("role_name", "permissions"),
    [
        ("member", {"not.a.capability": True}),
        (UserRole.ADMIN.value, {"records.read": "yes"}),
    ],
    ids=["direct-rule-allow", "administrator-bypass"],
)
def test_malformed_persisted_role_permissions_fail_closed_even_when_access_would_allow(
    role_name: str, permissions: dict[str, object]
) -> None:
    role = _role(role_name, permissions=permissions)  # type: ignore[arg-type]
    actor = _user(role)
    database = _SnapshotDatabase(
        actor=actor,
        role=role,
        rules=(_rule(Capability.RECORDS_READ, decision="allow"),),
    )

    with pytest.raises(HTTPException) as unavailable:
        _authorize(database, Capability.RECORDS_READ)

    assert unavailable.value.status_code == 503
    assert database.rollback_calls == 1


def test_workspace_authorizer_requires_the_authenticated_role_to_still_match() -> None:
    expected_role = _role(permissions={Capability.RECORDS_READ.value: True})
    changed_role = _role(permissions={Capability.RECORDS_READ.value: True})
    actor = _user(changed_role)
    database = _SnapshotDatabase(actor=actor, role=expected_role)

    with pytest.raises(HTTPException) as denied:
        authorize_workspace_capabilities(
            database,
            actor_id=actor.id,
            expected_role_id=expected_role.id,
            capabilities=(Capability.RECORDS_READ,),
            now=NOW,
        )

    assert denied.value.status_code == 403
    assert isinstance(denied.value, WorkspaceRoleChanged)


def test_openview_reader_keeps_the_explicit_legacy_role_guard() -> None:
    from typing import get_args

    from app.systems.openview.views.router import Reader

    role = _role(permissions={Capability.RECORDS_READ.value: True})
    actor = _user(role)
    actor.role = role
    dependency = get_args(Reader)[1].dependency

    assert dependency is not None
    assert dependency(actor) is actor
