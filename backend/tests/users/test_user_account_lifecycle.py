from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.account_operations as users_router
from app.core.integrations.supabase import SupabaseAdminClient
from app.systems.access.users.models import UserRole, UserStatus
from app.systems.access.users.schemas import UserUpdate
from tests.users.user_invitations_support import profile, role


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_local_first_disable_commit_failure_remains_failure_without_auth_call(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.ACTIVE.value)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, user]
    database.commit.side_effect = SQLAlchemyError("local failure")
    event_writer = Mock()
    monkeypatch.setattr(users_router, "_record_security_event", event_writer)

    with pytest.raises(users_router.HTTPException) as error:
        if operation == "disable":
            users_router.update_user(
                user.id,
                UserUpdate(status=UserStatus.DISABLED),
                admin,
                database,
            )
        else:
            users_router.delete_user(user.id, admin, database)

    assert error.value.status_code == 503
    client.disable_user.assert_not_called()
    client.enable_user.assert_not_called()
    outcomes = [call.kwargs["outcome"].value for call in event_writer.call_args_list]
    operation_ids = {call.kwargs["operation_id"] for call in event_writer.call_args_list}
    assert outcomes == ["attempt", "failure"]
    assert len(operation_ids) == 1
