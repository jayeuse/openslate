"""Report and announcement work share storage without sharing claim authority."""

import subprocess
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users.models import Role, User, UserStatus
from app.systems.boards.announcement_models import (
    BoardAnnouncement,
    BoardAnnouncementRevision,
    publication_content_fingerprint,
)
from app.systems.boards.models import Board
from app.systems.openview.reports.models import Report
from app.systems.platform.scheduling.models import ScheduledWork, WorkState
from app.systems.platform.scheduling.service import (
    WorkClaim,
    claim_due_work,
    fail_report_work,
    queue_report_occurrence,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
NOW = datetime(2026, 9, 24, 10, tzinfo=UTC)


def _sources(db):
    role = Role(
        role=f"work-kind-{uuid7().hex}",
        permissions={"records.read": True, "records.write": True},
    )
    actor = User(
        email=f"work-kind-{uuid7().hex}@example.test",
        username=f"work_kind_{uuid7().hex[:16]}",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    department = Department(department_name=f"Work kind {uuid7().hex}")
    db.add_all((actor, department))
    db.flush()
    board = Board(owner_id=actor.id, name="Scheduled announcements")
    module = Module(
        department_id=department.id,
        module_name=f"Work kind {uuid7().hex}",
        is_schema_accepted=True,
    )
    db.add_all((board, module))
    db.flush()
    announcement = BoardAnnouncement(
        board_id=board.id,
        author_id=actor.id,
        title="Upcoming",
        body="Publication body",
        status="scheduled",
        publish_at=NOW,
        audience_kind="author",
        revision=2,
    )
    report = Report(owner_id=actor.id, module_id=module.id, name="Report", recipe={})
    db.add_all((announcement, report))
    db.flush()
    return actor, announcement, report


def test_announcement_work_cannot_be_claimed_or_failed_by_report_worker(integration_owner_db):
    db = integration_owner_db
    actor, announcement, report = _sources(db)
    publication = ScheduledWork(
        kind="announcement-publish",
        announcement_id=announcement.id,
        source_revision=announcement.revision,
        scheduling_actor_id=actor.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
    )
    db.add(publication)
    db.flush()
    report_work = queue_report_occurrence(db, report.id, scheduled_for=NOW)

    assert [claim.id for claim in claim_due_work(db, now=NOW)] == [report_work.id]
    assert publication.state == WorkState.PENDING
    assert publication.attempt_count == 0
    assert publication.report_id is None
    assert report_work.kind == "report-run"

    publication.state = WorkState.RUNNING
    publication.attempt_count = 1
    publication.lease_token = uuid7()
    publication.lease_expires_at = NOW + timedelta(minutes=2)
    db.flush()
    assert not fail_report_work(db, WorkClaim(publication.id, publication.lease_token), now=NOW)
    assert publication.state == WorkState.RUNNING
    assert publication.attempt_count == 1


def test_announcement_work_enforces_disjoint_sources_and_unique_occurrence(integration_owner_db):
    db = integration_owner_db
    actor, announcement, report = _sources(db)
    publication = ScheduledWork(
        kind="announcement-publish",
        announcement_id=announcement.id,
        source_revision=announcement.revision,
        scheduling_actor_id=actor.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
    )
    db.add(publication)
    db.flush()

    with pytest.raises(IntegrityError), db.begin_nested():
        db.add(
            ScheduledWork(
                kind="announcement-publish",
                announcement_id=announcement.id,
                source_revision=announcement.revision,
                scheduling_actor_id=actor.id,
                scheduled_for=NOW + timedelta(hours=1),
                next_attempt_at=NOW + timedelta(hours=1),
            )
        )
        db.flush()
    with pytest.raises(IntegrityError), db.begin_nested():
        db.add(
            ScheduledWork(
                kind="announcement-publish",
                report_id=report.id,
                announcement_id=announcement.id,
                source_revision=announcement.revision + 1,
                scheduling_actor_id=actor.id,
                scheduled_for=NOW + timedelta(hours=2),
                next_attempt_at=NOW + timedelta(hours=2),
            )
        )
        db.flush()
    with pytest.raises(IntegrityError), db.begin_nested():
        db.add(
            ScheduledWork(
                kind="announcement-publish",
                announcement_id=announcement.id,
                source_revision=0,
                scheduling_actor_id=actor.id,
                scheduled_for=NOW + timedelta(hours=3),
                next_attempt_at=NOW + timedelta(hours=3),
            )
        )
        db.flush()
    assert db.scalar(select(ScheduledWork).where(ScheduledWork.id == publication.id)) is publication


def test_announcement_success_requires_its_publication_result(integration_owner_db):
    db = integration_owner_db
    actor, announcement, _report = _sources(db)
    work = ScheduledWork(
        kind="announcement-publish",
        announcement_id=announcement.id,
        source_revision=announcement.revision,
        scheduling_actor_id=actor.id,
        scheduled_for=NOW,
        next_attempt_at=NOW,
    )
    db.add(work)
    db.flush()
    with pytest.raises(IntegrityError), db.begin_nested():
        work.state = WorkState.SUCCEEDED
        db.flush()
    db.refresh(work)
    revision = BoardAnnouncementRevision(
        announcement_id=announcement.id,
        publication_number=1,
        publication_key=work.id,
        content_fingerprint=publication_content_fingerprint(
            author_id=actor.id,
            title=announcement.title,
            body=announcement.body,
            audience_kind="author",
        ),
        author_id=actor.id,
        title=announcement.title,
        body=announcement.body,
        audience_kind="author",
        published_at=NOW,
    )
    db.add(revision)
    db.flush()
    work.state = WorkState.SUCCEEDED
    work.publication_result_id = revision.id
    db.flush()
    assert work.run_id is None
    assert work.publication_result_id == revision.id


def test_typed_work_constraints_fks_and_runtime_privileges_are_installed(integration_owner_db):
    connection = integration_owner_db.connection()
    constraints = {
        row.conname: (row.contype, row.confdeltype)
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = 'public.scheduled_work'::regclass"
            )
        )
    }
    assert constraints["ck_scheduled_work_kind"][0] == "c"
    assert constraints["ck_scheduled_work_source"][0] == "c"
    assert constraints["ck_scheduled_work_run"][0] == "c"
    assert constraints["uq_scheduled_work_announcement_occurrence"][0] == "u"
    assert constraints["fk_scheduled_work_announcement_id_board_announcements"] == ("f", "r")
    publication_result_fks = [
        value
        for name, value in constraints.items()
        if name.startswith("fk_scheduled_work_publication_result_id_")
    ]
    assert publication_result_fks == [("f", "r")]
    assert constraints["fk_scheduled_work_scheduling_actor_id_users"] == ("f", "r")
    default = connection.scalar(
        text(
            "SELECT column_default FROM information_schema.columns "
            "WHERE table_name = 'scheduled_work' AND column_name = 'kind'"
        )
    )
    assert default == "'report-run'::character varying"
    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert connection.scalar(
            text("SELECT has_table_privilege('openslate_runtime', 'scheduled_work', :privilege)"),
            {"privilege": privilege},
        )
        assert connection.scalar(
            text("SELECT has_table_privilege('openslate_inspector', 'scheduled_work', :privilege)"),
            {"privilege": privilege},
        ) is (privilege == "SELECT")


def test_typed_work_migration_preserves_a_legacy_report_occurrence():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    actor_id, department_id, module_id, report_id, work_id = (uuid7() for _ in range(5))
    board_id, announcement_id, publication_work_id = (uuid7() for _ in range(3))
    try:
        run_alembic(environment, "downgrade", "e84debb45901")
        with engine.begin() as connection:
            role_id = connection.scalar(text("SELECT id FROM roles WHERE role = 'member'"))
            assert isinstance(role_id, UUID)
            connection.execute(
                text(
                    "INSERT INTO users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": actor_id,
                    "email": f"legacy-work-{actor_id.hex}@example.test",
                    "username": f"legacy_work_{actor_id.hex[:10]}",
                    "role_id": role_id,
                },
            )
            connection.execute(
                text("INSERT INTO departments (id, department_name) VALUES (:id, :name)"),
                {"id": department_id, "name": "Legacy work department"},
            )
            connection.execute(
                text(
                    "INSERT INTO modules (id, department_id, module_name, is_schema_accepted) "
                    "VALUES (:id, :department_id, :name, true)"
                ),
                {"id": module_id, "department_id": department_id, "name": "Legacy work module"},
            )
            connection.execute(
                text(
                    "INSERT INTO reports (id, owner_id, module_id, name, recipe) "
                    "VALUES (:id, :owner_id, :module_id, 'Legacy', CAST(:recipe AS jsonb))"
                ),
                {"id": report_id, "owner_id": actor_id, "module_id": module_id, "recipe": "{}"},
            )
            connection.execute(
                text(
                    "INSERT INTO scheduled_work "
                    "(id, kind, report_id, scheduled_for, next_attempt_at, state, "
                    "attempt_count, created_at, updated_at) "
                    "VALUES (:id, 'report-run', :report_id, :instant, :instant, "
                    "'pending', 0, :instant, :instant)"
                ),
                {"id": work_id, "report_id": report_id, "instant": NOW},
            )
        run_alembic(environment, "upgrade", "head")
        with engine.connect() as connection:
            head_before_failed_downgrade = connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )
            assert isinstance(head_before_failed_downgrade, str)
            row = connection.execute(
                text(
                    "SELECT kind, report_id, announcement_id, source_revision, "
                    "scheduling_actor_id, publication_result_id "
                    "FROM scheduled_work WHERE id = :id"
                ),
                {"id": work_id},
            ).one()
            assert row == ("report-run", report_id, None, None, None, None)
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO boards (id, owner_id, name) VALUES (:id, :owner_id, 'Board')"),
                {"id": board_id, "owner_id": actor_id},
            )
            connection.execute(
                text(
                    "INSERT INTO board_announcements "
                    "(id, board_id, author_id, title, body, status, publish_at, audience_kind) "
                    "VALUES (:id, :board_id, :author_id, 'Draft', 'Body', 'scheduled', "
                    ":publish_at, 'author')"
                ),
                {
                    "id": announcement_id,
                    "board_id": board_id,
                    "author_id": actor_id,
                    "publish_at": NOW,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO scheduled_work "
                    "(id, kind, announcement_id, source_revision, scheduling_actor_id, "
                    "scheduled_for, next_attempt_at, state, attempt_count, created_at, updated_at) "
                    "VALUES (:id, 'announcement-publish', :announcement_id, 1, :actor_id, "
                    ":instant, :instant, 'pending', 0, :instant, :instant)"
                ),
                {
                    "id": publication_work_id,
                    "announcement_id": announcement_id,
                    "actor_id": actor_id,
                    "instant": NOW,
                },
            )
        with pytest.raises(subprocess.CalledProcessError):
            run_alembic(environment, "downgrade", "e84debb45901")
        with engine.connect() as connection:
            assert (
                connection.scalar(text("SELECT version_num FROM alembic_version"))
                == head_before_failed_downgrade
            )
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
            with engine.begin() as connection:
                for table, row_id in (
                    ("scheduled_work", publication_work_id),
                    ("scheduled_work", work_id),
                    ("board_announcements", announcement_id),
                    ("boards", board_id),
                    ("reports", report_id),
                    ("modules", module_id),
                    ("departments", department_id),
                    ("users", actor_id),
                ):
                    connection.execute(text(f"DELETE FROM {table} WHERE id = :id"), {"id": row_id})
        finally:
            engine.dispose()
