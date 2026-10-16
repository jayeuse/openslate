"""S10: files stay inside their organization, and uploads stop at 10 MiB (D17, D18)."""

from hashlib import sha256
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database.organization_scope import scope_session
from app.core.database.session import get_db
from app.main import create_app
from app.systems.platform.files.models import File
from app.systems.platform.files.service import object_key
from app.systems.platform.files.validation import MAX_BYTES
from tests.conftest import create_member, create_organization
from tests.organization_scope_support import scoped_override

pytestmark = pytest.mark.integration


def _client(db, actor, organization) -> TestClient:
    application = create_app()
    application.dependency_overrides[get_db] = lambda: db
    application.dependency_overrides[get_current_user] = scoped_override(
        lambda: actor, org_id=organization.id
    )
    return TestClient(application)


def test_an_organization_file_is_invisible_to_an_administrator_of_another(
    integration_db: Session,
) -> None:
    db = integration_db
    home, visited = create_organization(db), create_organization(db)
    outsider, _ = create_member(db, home, "admin")
    insider, _ = create_member(db, visited, "admin")
    scope_session(db, visited.id)
    content = b"\x89PNG logo"
    file = File(
        org_id=visited.id, purpose="workspace_logo", creator_id=insider.id,
        filename="logo.png", expected_size=len(content), actual_size=len(content),
        media_type="image/png", digest=sha256(content).hexdigest(),
        object_key=object_key(org_id=visited.id, user_id=insider.id), state="ready",
    )
    db.add(file)
    db.commit()
    assert file.object_key.startswith(f"org/{visited.id}/")

    assert _client(db, insider, visited).get(f"/api/files/{file.id}").status_code == 200
    outside = _client(db, outsider, home)
    assert outside.get(f"/api/files/{file.id}").status_code == 404
    assert outside.get(f"/api/files/{file.id}/content").status_code == 404


def test_an_upload_above_ten_mebibytes_is_refused_before_it_is_read() -> None:
    client = TestClient(create_app())
    response = client.put(
        f"/api/files/{uuid4()}/content",
        content=b"x" * (MAX_BYTES + MAX_BYTES // 20),
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 413


def test_avatar_keys_belong_to_the_account_not_an_organization() -> None:
    account = uuid4()
    assert object_key(org_id=None, user_id=account).startswith(f"user/{account}/")
