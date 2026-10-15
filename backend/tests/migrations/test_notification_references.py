"""Reference-only notification constraints on the fresh organization root."""

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration
WHEN = datetime(2026, 9, 24, 12, tzinfo=UTC)


def _sources(db):
    ids = {
        name: uuid7()
        for name in (
            "user", "department", "module", "report", "run", "board", "post", "revision",
            "event", "reminder", "report_work", "post_work", "event_work", "report_notice",
            "post_notice", "event_notice",
        )
    }
    organization = create_organization(db)
    ids["org"] = organization.id
    create_member(db, organization, id=ids["user"],
                  email=f"notification-{ids['user']}@example.test", username=str(ids["user"]))
    statements = (
        "INSERT INTO departments(id,org_id,department_name) "
        "VALUES(:department,:org,'Notification migration')",
        "INSERT INTO modules(id,org_id,department_id,module_name) "
        "VALUES(:module,:org,:department,'Reports')",
        "INSERT INTO reports(id,org_id,module_id,name,recipe) "
        "VALUES(:report,:org,:module,'Report','{}'::jsonb)",
        "INSERT INTO report_runs(id,org_id,report_id,module_id,idempotency_key,recipe_revision,"
        "recipe,headings,row_count,csv_bytes) "
        "VALUES(:run,:org,:report,:module,:report_work,1,'{}'::jsonb,'[]'::jsonb,0,:csv)",
        "INSERT INTO boards(id,org_id,scope,name) "
        "VALUES(:board,:org,'project','Notification migration')",
        "INSERT INTO board_posts(id,org_id,board_id,author_id,title,body,status,"
        "displayed_publication_number) "
        "VALUES(:post,:org,:board,:user,'Post','Body','published',1)",
        "INSERT INTO board_post_revisions(id,org_id,post_id,publication_number,publication_key,"
        "content_fingerprint,author_id,title,body,published_at) "
        "VALUES(:revision,:org,:post,1,:revision,:fingerprint,:user,'Post','Body',:when)",
        "INSERT INTO board_events(id,org_id,board_id,author_id,title,all_day,start_date,end_date,"
        "timezone_name) VALUES(:event,:org,:board,:user,'Event',true,:day,:day,'UTC')",
        "INSERT INTO board_event_reminders(id,org_id,board_id,event_id,timing) "
        "VALUES(:reminder,:org,:board,:event,'start')",
        "INSERT INTO scheduled_work(id,org_id,kind,report_id,run_id,scheduled_for,next_attempt_at,"
        "state,attempt_count,created_at,updated_at) "
        "VALUES(:report_work,:org,'report-run',:report,:run,:when,:when,'succeeded',0,:when,:when)",
        "INSERT INTO scheduled_work(id,org_id,kind,post_id,source_revision,scheduling_actor_id,"
        "publication_result_id,scheduled_for,next_attempt_at,state,attempt_count,"
        "created_at,updated_at) "
        "VALUES(:post_work,:org,'post-publish',:post,1,:user,:revision,:when,:when,'succeeded',"
        "0,:when,:when)",
        "INSERT INTO scheduled_work(id,org_id,kind,reminder_id,occurrence_start_at,scheduled_for,"
        "next_attempt_at,state,attempt_count,created_at,updated_at) "
        "VALUES(:event_work,:org,'event-reminder',:reminder,:when,:when,:when,'succeeded',0,:when,:when)",
        "INSERT INTO in_app_notifications(id,org_id,work_id,recipient_id,created_at,read_at,"
        "is_deleted,kind,subject_type,subject_id) VALUES "
        "(:report_notice,:org,:report_work,:user,:when,NULL,true,'report-run','report_run',:run),"
        "(:post_notice,:org,:post_work,:user,:when,:when,false,'post-publish','board_post',:post),"
        "(:event_notice,:org,:event_work,:user,:when,NULL,false,'event-reminder','board_event',:event)",
    )
    parameters = {**ids, "csv": b"", "fingerprint": "a" * 64, "when": WHEN, "day": WHEN.date()}
    for statement in statements:
        db.connection().execute(text(statement), parameters)
    return ids


def test_reference_tuple_rejects_a_work_backed_backup_notice(integration_owner_db):
    connection = integration_owner_db.connection()
    ids = _sources(integration_owner_db)
    connection.execute(
        text("DELETE FROM in_app_notifications WHERE id=:id"), {"id": ids["report_notice"]}
    )
    payload = {
        "id": str(uuid7()),
        "org_id": None,
        "work_id": str(ids["report_work"]),
        "recipient_id": str(ids["user"]),
        "kind": "backup-failed",
        "subject_type": "backup_run",
        "subject_id": str(uuid7()),
        "created_at": WHEN.isoformat(),
        "updated_at": WHEN.isoformat(),
        "is_deleted": False,
    }
    with pytest.raises(IntegrityError) as rejected:
        with integration_owner_db.begin_nested():
            connection.execute(
                text(
                    "INSERT INTO in_app_notifications SELECT * FROM jsonb_populate_record("
                    "NULL::in_app_notifications, CAST(:payload AS jsonb))"
                ),
                {"payload": json.dumps(payload)},
            )
    assert rejected.value.orig.diag.constraint_name == "ck_in_app_notifications_reference"


@pytest.mark.parametrize(
    "kind,subject_type,source,work_name",
    (
        ("report-run", "report_run", "run", "report_work"),
        ("post-publish", "board_post", "post", "post_work"),
        ("event-reminder", "board_event", "event", "event_work"),
        ("report-run-failed", "scheduled_work", "report_work", "report_work"),
        ("backup-failed", "backup_run", "run", None),
        ("record-assigned", "record", "run", None),
        ("invitation-accepted", "user", "user", None),
        ("sandbox-published", "sandbox_version", "run", None),
        ("access-changed", "user", "user", None),
    ),
)
def test_accepted_reference_tuples_and_non_work_repeatability(
    integration_owner_db, kind, subject_type, source, work_name
):
    db = integration_owner_db
    connection = db.connection()
    ids = _sources(db)
    connection.execute(text("DELETE FROM in_app_notifications WHERE recipient_id=:user"), ids)
    payload = {
        "id": str(uuid7()),
        "org_id": None if kind == "backup-failed" else str(ids["org"]),
        "work_id": str(ids[work_name]) if work_name else None,
        "recipient_id": str(ids["user"]),
        "kind": kind,
        "subject_type": subject_type,
        "subject_id": str(ids[source]),
        "created_at": WHEN.isoformat(),
        "updated_at": WHEN.isoformat(),
        "is_deleted": False,
    }
    for _ in range(1 if work_name else 2):
        payload["id"] = str(uuid7())
        connection.execute(
            text(
                "INSERT INTO in_app_notifications SELECT * FROM jsonb_populate_record("
                "NULL::in_app_notifications, CAST(:payload AS jsonb))"
            ),
            {"payload": json.dumps(payload)},
        )
    row = connection.execute(
        text(
            "SELECT to_jsonb(n)->>'kind',to_jsonb(n)->>'subject_type',"
            "to_jsonb(n)->>'subject_id',work_id FROM in_app_notifications n WHERE id=:id"
        ),
        {"id": payload["id"]},
    ).one()
    assert tuple(row) == (
        kind,
        subject_type,
        str(ids[source]),
        ids[work_name] if work_name else None,
    )
    if work_name:
        payload["id"] = str(uuid7())
        with pytest.raises(IntegrityError) as duplicate:
            with db.begin_nested():
                connection.execute(
                    text(
                        "INSERT INTO in_app_notifications SELECT * FROM jsonb_populate_record("
                        "NULL::in_app_notifications, CAST(:payload AS jsonb))"
                    ),
                    {"payload": json.dumps(payload)},
                )
        assert duplicate.value.orig.diag.constraint_name == "uq_in_app_notifications_work_recipient"


@pytest.mark.parametrize(
    "changes",
    (
        {"kind": "unknown"},
        {"subject_type": "board_event"},
        {"subject_id": None},
        {"work_id": None},
        {"kind": "backup-failed", "subject_type": "backup_run"},
        {"kind": "report-run-failed", "subject_type": "scheduled_work"},
        {"kind": "access-changed", "subject_type": "user", "work_id": None},
    ),
)
def test_invalid_reference_combinations_are_rejected_by_named_check(integration_owner_db, changes):
    db = integration_owner_db
    connection = db.connection()
    ids = _sources(db)
    connection.execute(text("DELETE FROM in_app_notifications WHERE recipient_id=:user"), ids)
    payload = {
        "id": str(uuid7()),
        "org_id": None if changes.get("kind") == "backup-failed" else str(ids["org"]),
        "work_id": str(ids["report_work"]),
        "recipient_id": str(ids["user"]),
        "kind": "report-run",
        "subject_type": "report_run",
        "subject_id": str(ids["run"]),
        "created_at": WHEN.isoformat(),
        "updated_at": WHEN.isoformat(),
        "is_deleted": False,
        **changes,
    }
    with pytest.raises(IntegrityError) as rejected:
        with db.begin_nested():
            connection.execute(
                text(
                    "INSERT INTO in_app_notifications SELECT * FROM jsonb_populate_record("
                    "NULL::in_app_notifications, CAST(:payload AS jsonb))"
                ),
                {"payload": json.dumps(payload)},
            )
    if changes.get("subject_id", "present") is None:
        assert rejected.value.orig.diag.column_name == "subject_id"
    else:
        assert rejected.value.orig.diag.constraint_name == "ck_in_app_notifications_reference"


def test_unread_index_and_nullable_work_do_not_remove_existing_recipient_index(
    integration_owner_db,
):
    connection = integration_owner_db.connection()
    columns = {
        name: nullable
        for name, nullable in connection.execute(
            text(
                "SELECT column_name,is_nullable FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='in_app_notifications'"
            )
        ).tuples()
    }
    foreign_keys = {
        name: (kind, deletion)
        for name, kind, deletion in connection.execute(
            text(
                "SELECT conname,contype,confdeltype FROM pg_constraint "
                "WHERE conrelid='public.in_app_notifications'::regclass AND contype='f'"
            )
        ).tuples()
    }
    for name in (
        "fk_in_app_notifications_work_id_scheduled_work",
        "fk_in_app_notifications_recipient_id_users",
    ):
        assert foreign_keys[name] == ("f", "r")
    assert columns["work_id"] == "YES"
    assert all(columns[name] == "NO" for name in ("kind", "subject_type", "subject_id"))
    indexes = {
        name: definition
        for name, definition in connection.execute(
            text(
                "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' "
                "AND tablename='in_app_notifications'"
            )
        ).tuples()
    }
    assert "ix_in_app_notifications_recipient_created" in indexes
    unread = indexes["ix_in_app_notifications_recipient_unread"]
    assert "(recipient_id, created_at, id)" in unread
    assert "read_at IS NULL" in unread and "is_deleted = false" in unread
