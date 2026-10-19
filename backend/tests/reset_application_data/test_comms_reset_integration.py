"""The guarded reset removes a real Comms graph, retaining owned operator/backup state."""

from datetime import timedelta

import pytest
from psycopg import connect
from sqlalchemy import text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.base import Base
from app.systems.access.users.models import User
from app.systems.manage.backups.models import BackupRun
from operations import reset_application_data as reset
from tests.comms.conftest import NOW
from tests.comms.conftest import comms_world as comms_world
from tests.migrations.test_organization_root import COMMS_TABLES
from tests.reset_application_data.execution_support import apply_confirmed
from tests.reset_application_data.reset_integration_support import (
    assert_only_the_operator_remains,
    guarded_reset_database,
    insert_operator,
    provider_doubles,
)

pytestmark = pytest.mark.integration


def _complete_graph(world, org):
    identities = world.seed_graph(org)
    tables = Base.metadata.tables
    with world.owner.begin() as connection:
        connection.execute(tables["comms_conversations"].update().where(
            tables["comms_conversations"].c.id == org.conversation,
        ).values(category_id=org.category, scope="department", department_id=org.department))
        # Cover both ID13/ID15 ownership variants and a self-referencing reply/quote.
        connection.execute(tables["comms_conversation_groups"].insert().values(
            id=uuid7(), org_id=org.id, conversation_id=org.conversation,
            subject="group", group_id=org.group, level="post",
        ))
        connection.execute(tables["comms_member_preferences"].insert().values(
            id=uuid7(), org_id=org.id, category_id=org.category, user_id=org.author,
            collapsed=True, mute="indefinite",
        ))
        connection.execute(tables["comms_messages"].insert().values(
            id=uuid7(), org_id=org.id, conversation_id=org.conversation,
            seq=2, author_id=org.peer, client_key=uuid7(), body="Owned reply",
            send_fingerprint=uuid7().hex * 2, parent_id=identities["comms_messages"],
            reply_to_id=identities["comms_messages"],
        ))
        connection.execute(tables["comms_conversation_counters"].update().where(
            tables["comms_conversation_counters"].c.id == identities["comms_conversation_counters"],
        ).values(last_seq=2))


def test_reset_removes_all_twenty_comms_tables_and_preserves_operator_and_backup_history(
    comms_world, request, monkeypatch,
):
    target = guarded_reset_database(monkeypatch)
    first, second = comms_world.first, comms_world.second
    provider_ids = {
        user_id: uuid7() for user_id in (first.author, first.peer, second.author, second.peer)
    }
    backup_id = uuid7()

    def clean(cursor):
        # Runs before comms_world cleanup, including on a failed reset. Only our rows.
        cursor.execute("DELETE FROM public.backup_runs WHERE id = %s", (backup_id,))
        cursor.execute("DELETE FROM public.platform_operators WHERE user_id = %s", (first.author,))

    target.clean_up_after(request, clean)
    with connect(target.url) as database:
        with database.cursor() as cursor:
            # Whole-application reset is admitted only in the disposable with exactly
            # this fixture's organizations/accounts, never alongside someone else's rows.
            cursor.execute("SELECT id FROM public.organizations")
            assert {row[0] for row in cursor.fetchall()} == {first.id, second.id}
            cursor.execute("SELECT id FROM public.users")
            assert {row[0] for row in cursor.fetchall()} == set(provider_ids)
            operator_id = insert_operator(cursor, first.author)
        database.commit()
        _complete_graph(comms_world, first)
        _complete_graph(comms_world, second)
        with Session(comms_world.owner) as db:
            for user_id, provider_id in provider_ids.items():
                user = db.get(User, user_id)
                assert user is not None
                user.supabase_user_id = provider_id
            installation = db.scalar(text("SELECT current_setting('cluster_name')"))
            db.add(BackupRun(
                id=backup_id, installation_id=installation, name="Owned Comms reset history",
                provenance="manual", requester_id=first.author, performed_by=first.author,
                idempotency_hash=backup_id.hex * 2, schedule="disabled", retention_days=30,
                requested_at=NOW - timedelta(hours=3), state="succeeded", claim_id=uuid7(),
                claimed_schedule="disabled", claimed_retention_days=30,
                started_at=NOW - timedelta(hours=2), finished_at=NOW - timedelta(hours=1),
                verified_at=NOW - timedelta(minutes=61), reconciled_at=NOW - timedelta(minutes=59),
                snapshot_id="a" * 64, manifest_sha256="b" * 64,
            ))
            db.commit()

        # Independent committed SQL oracles, not the reset inventory/count algorithm.
        with database.cursor() as cursor:
            cursor.execute("SELECT email,to_jsonb(u) FROM public.users u WHERE id = %s", (
                first.author,
            ))
            email, profile_before = cursor.fetchone()
            cursor.execute("SELECT to_jsonb(o) FROM public.platform_operators o WHERE id = %s", (
                operator_id,
            ))
            operator_before = cursor.fetchone()[0]
            cursor.execute("SELECT to_jsonb(b) FROM public.backup_runs b WHERE id = %s", (
                backup_id,
            ))
            backup_before = cursor.fetchone()[0]
            counts = {}
            for table in sorted(COMMS_TABLES):
                cursor.execute(f"SELECT count(*) FROM public.{table}")
                counts[table] = cursor.fetchone()[0]
                assert counts[table] >= 2, table

        storage, auth = provider_doubles()
        removed_provider_ids = tuple(sorted(
            (provider_id for user_id, provider_id in provider_ids.items()
             if user_id != first.author),
            key=str,
        ))
        plan = reset.build_reset_plan(database, email, storage_object_keys=())
        assert plan.preserved_admin_id == first.author
        assert plan.preserved_operator_id == operator_id
        assert plan.provider_account_ids == removed_provider_ids
        assert {table: plan.counts[table] for table in COMMS_TABLES} == counts
        auth.list_account_ids.side_effect = (removed_provider_ids, ())
        apply_confirmed(database, plan, storage=storage, auth=auth)
        auth.require_present.assert_called_once_with(provider_ids[first.author])
        auth.delete_and_verify_missing.assert_called_once_with(removed_provider_ids)
        storage.delete_and_verify_empty.assert_called_once_with(())

    # A new guarded connection proves the deletion and preservation really committed.
    target.guard()
    with connect(target.url) as database, database.cursor() as cursor:
        for table in sorted(COMMS_TABLES | {"groups", "files", "records", "modules", "audit_logs"}):
            cursor.execute(f"SELECT count(*) FROM public.{table}")
            assert cursor.fetchone() == (0,), table
        assert_only_the_operator_remains(cursor, first.author, operator_id)
        for table, identity, expected in (
            ("users", first.author, profile_before),
            ("platform_operators", operator_id, operator_before),
            ("backup_runs", backup_id, backup_before),
        ):
            cursor.execute(f"SELECT to_jsonb(source) FROM public.{table} source WHERE id = %s", (
                identity,
            ))
            assert cursor.fetchone() == (expected,), table
