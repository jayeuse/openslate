"""Board editors can find only bounded, active content-audience targets."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User, UserStatus
from app.systems.boards.models import Board, BoardGrant
from app.systems.sandbox.departments.models import Department
from tests.boards.test_content_audience_user_chooser import _client, _user

pytestmark = pytest.mark.integration


def test_board_editor_can_choose_active_user_and_department_without_manage(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _user(db)
    editor = _user(db)
    outsider = _user(db)
    marker = uuid7().hex[:12]
    target_role = "member"
    target = User(
        email=f"audience-{marker}@example.test",
        username=f"audience_{marker}",
        status=UserStatus.ACTIVE.value,
        role=target_role,
    )
    pending = User(
        email=f"pending-audience-{marker}@example.test",
        username=f"pending_audience_{marker}",
        status=UserStatus.PENDING.value,
        role=target_role,
    )
    department = Department(department_name=f"Audience {marker}")
    deleted_department = Department(
        department_name=f"Audience {marker} deleted", deleted_at=datetime.now(UTC)
    )
    board = Board(owner_id=owner.id, name=f"Audience board {marker}")
    db.add_all((target, pending, department, deleted_department, board))
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=editor.id,
            permission="edit",
            effect="allow",
        )
    )
    db.commit()

    client = _client(db, editor)
    root = f"/api/boards/{board.id}/content-audience-targets"
    for kind, expected in (
        ("user", {"id": str(target.id), "label": target.username}),
        ("department", {"id": str(department.id), "label": department.department_name}),
    ):
        response = client.get(f"{root}?kind={kind}&search={marker}&limit=1")
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json()["items"] == [expected]
        assert response.json()["pagination"]["count"] == 1
    assert _client(db, outsider).get(f"{root}?kind=user&search={marker}").status_code == 404
    assert client.get(f"{root}?kind=role&search={marker}").status_code == 422
