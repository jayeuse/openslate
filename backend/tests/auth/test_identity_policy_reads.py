"""One workspace-policy read per authenticated request."""

from types import SimpleNamespace
from typing import Annotated
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserRole, UserStatus


def test_an_authenticated_request_reads_the_workspace_policy_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Each request read the policy twice, once for MFA and once for the address check.
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient

    from app.common.dependencies import auth as dependency
    from app.core.database import get_db
    from app.systems.manage.workspace.models import WorkspaceProfile

    policy = WorkspaceProfile(ip_allow_list=[])
    reads: list[object] = []
    passed: list[object] = []
    user = User(id=uuid4(), status=UserStatus.ACTIVE.value, role=UserRole.MEMBER)
    session = IdentitySession(id=uuid4(), user_id=user.id)

    def read_policy(_db: object) -> WorkspaceProfile:
        reads.append(policy)
        return policy

    def resolve(*_args: object, **kwargs: object) -> tuple[User, IdentitySession]:
        passed.append(kwargs.get("policy"))
        return user, session

    provider = SimpleNamespace(verify_access_token=lambda _token: SimpleNamespace())
    monkeypatch.setattr(dependency, "get_supabase_auth_client", lambda: provider)
    monkeypatch.setattr(dependency, "load_workspace_policy", read_policy)
    monkeypatch.setattr(dependency, "resolve_provider_session", resolve)
    db = Mock(spec=Session)
    db.info = {}
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db

    @app.get("/protected")
    def protected(
        identity: Annotated[dependency.CurrentIdentity, Depends(dependency.get_current_identity)],
    ) -> dict[str, str]:
        return {"user_id": str(identity.user.id)}

    with TestClient(app) as browser:
        response = browser.get("/protected", headers={"Authorization": "Bearer token"})
    assert response.status_code == 200
    assert reads == [policy]
    assert passed == [policy]
