"""Report and announcement work share storage without sharing claim authority."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserStatus
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
from tests.rbac.support import make_group_access

pytestmark = pytest.mark.integration
NOW = datetime(2026, 9, 24, 10, tzinfo=UTC)


def _sources(db):
    role = "member"
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
    )
    db.add_all((board, module))
    db.flush()
    make_group_access(db, [actor], department, module, level=AccessLevel.WRITE)
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
        ) is True
        for role in ("anon", "authenticated", "service_role"):
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege(:role, 'scheduled_work', :privilege)"),
                    {"role": role, "privilege": privilege},
                )
                is False
            )
