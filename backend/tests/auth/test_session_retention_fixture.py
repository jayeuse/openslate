"""The retention fixture cleans committed setup rows even when pytest setup fails."""

import subprocess
import sys
import xml.etree.ElementTree as ET
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import User

pytestmark = pytest.mark.integration


def test_world_cleans_committed_setup_failure_without_deleting_unrelated_user(
    integration_owner_db, tmp_path
):
    owner = integration_owner_db.get_bind().engine
    unrelated = uuid4()
    owned_ids = tmp_path / "owned-users.txt"
    report = tmp_path / "setup-failure.xml"
    child = tmp_path / "test_owned_retention_setup.py"
    child.write_text(
        f"""
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from app.systems.access.users.models import User

pytestmark = pytest.mark.integration


@pytest.fixture
def fail_after_owned_commit(monkeypatch):
    commit = Session.commit

    def fail_setup(db):
        users = [str(row.id) for row in db.new if isinstance(row, User)]
        commit(db)
        if users:
            Path({str(owned_ids)!r}).write_text("\\n".join(users))
            raise RuntimeError("owned retention fixture setup failure")

    monkeypatch.setattr(Session, "commit", fail_setup)


def test_owned_fixture_setup(fail_after_owned_commit, world):
    raise AssertionError("Setup fault was not injected")
""",
        encoding="utf-8",
    )
    try:
        with Session(owner) as db:
            db.add(
                User(
                    id=unrelated,
                    username=str(unrelated),
                    email=f"{unrelated}@example.test",
                    status="active",
                    role="member",
                )
            )
            db.commit()
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "--no-cov",
                "-p",
                "tests.conftest",
                "-p",
                "tests.auth.session_retention_support",
                f"--junitxml={report}",
                str(child),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 1, completed.stdout
        (case,) = ET.parse(report).getroot().iter("testcase")
        error = case.find("error")
        assert error is not None and case.find("failure") is None
        assert "RuntimeError: owned retention fixture setup failure" in error.get("message", "")
        created = [UUID(value) for value in owned_ids.read_text().splitlines()]
        assert created, "The failure must follow an actual committed owned User write"
        with Session(owner) as db:
            assert not list(db.scalars(select(User.id).where(User.id.in_(created))))
            assert db.get(User, unrelated) is not None
    finally:
        # Also remove the injected rows if a cleanup regression leaves them committed.
        cleanup_ids = [unrelated]
        if owned_ids.exists():
            cleanup_ids.extend(UUID(value) for value in owned_ids.read_text().splitlines())
        with Session(owner) as db:
            for row in db.scalars(select(User).where(User.id.in_(cleanup_ids))):
                db.delete(row)
            db.commit()
