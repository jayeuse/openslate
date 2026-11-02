"""The file and Storage check against real PostgreSQL rows and real Storage objects."""

from __future__ import annotations

import os
from collections.abc import Iterator
from hashlib import sha256
from uuid import uuid4

import httpx
import pytest
from sqlalchemy.orm import Session

from app.systems.platform.files.models import File
from operations import check_file_storage as check
from tests.conftest import create_member
from tests.files.conftest import library_department
from tests.rbac.support import organization

pytestmark = pytest.mark.integration
BUCKET = "openslate-ready"


@pytest.fixture
def storage(integration_db: Session) -> Iterator[httpx.Client]:
    # Depends on integration_db, which skips without the runner-owned stack.
    # The command's own client, admitted against the runner-owned provider.
    with check._storage_client(dict(os.environ)) as client:
        yield client


def test_the_check_reports_each_difference_and_nothing_for_matching_files(
    integration_db: Session, storage: httpx.Client
) -> None:
    db = integration_db
    org = organization(db)
    department_id = library_department(db)
    actor, _ = create_member(db, org)
    clean, missing, resized, extra = (f"org/{org.id}/{uuid4().hex}" for _ in range(4))
    rows = {}
    for key in (clean, missing, resized):
        rows[key] = File(
            org_id=org.id, purpose="library_document", department_id=department_id,
            creator_id=actor.id, filename="check.pdf", expected_size=5, actual_size=5,
            digest=sha256(b"check").hexdigest(), media_type="application/pdf",
            object_key=key, state="ready",
        )
        db.add(rows[key])
    db.flush()
    stored = {clean: b"bytes", resized: b"bytes!", extra: b"left"}
    try:
        for key, content in stored.items():
            response = storage.post(
                f"object/{BUCKET}/{key}", content=content,
                headers={"content-type": "application/pdf"},
            )
            assert response.status_code == 200, response.text

        inventory = check.read_inventory(db.connection())
        objects = check.list_objects(storage)

        found = sorted(
            (item["kind"], item["bucket"], item["file_id"], item["object_key"])
            for item in check.compare(inventory, objects)
            if item["object_key"].startswith(f"org/{org.id}/")
        )
        assert found == sorted([
            ("extra_object", BUCKET, None, extra),
            ("missing_object", BUCKET, str(rows[missing].id), missing),
            ("size_difference", BUCKET, str(rows[resized].id), resized),
        ])
        # The check only lists: a second listing finds the same objects.
        assert check.list_objects(storage) == objects
    finally:
        storage.request("DELETE", f"object/{BUCKET}", json={"prefixes": list(stored)})
