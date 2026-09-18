"""Keep the destructive utility's admission and rollback contracts explicit."""

import os
from secrets import token_urlsafe
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock
from uuid import uuid4

import pytest
from psycopg import connect

from scripts import reset_application_data as reset
from scripts import reset_execution as execution

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")


def test_reset_defaults_to_dry_run_without_database_work() -> None:
    database = Mock()
    assert reset._parser().parse_args([]).execute is False
    reset.apply_reset(database, Mock())
    assert database.mock_calls == []


@pytest.mark.parametrize("tty,confirmation", [(False, "exact"), (True, None), (True, "wrong")])
def test_reset_requires_interactive_exact_confirmation(tty, confirmation) -> None:
    database = Mock()
    plan = SimpleNamespace(impact_digest="exact")
    with pytest.raises(reset.ResetError):
        reset.apply_reset(database, plan, execute=True, stdin_is_tty=tty, confirmation=confirmation)
    assert database.mock_calls == []


def test_reset_execute_requires_the_api_writer_gate(monkeypatch) -> None:
    database = Mock()
    plan = SimpleNamespace(impact_digest="exact")
    monkeypatch.setattr(
        reset,
        "require_api_stopped",
        lambda _: (_ for _ in ()).throw(reset.ResetError("API server running")),
    )

    with pytest.raises(reset.ResetError, match="API server running"):
        reset.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation="exact",
            storage=Mock(),
            backend_port="8000",
        )
    assert database.mock_calls == []


def test_database_commit_precedes_storage_cleanup_and_preserves_a_fresh_retry(monkeypatch) -> None:
    workspace_id = uuid4()
    plan = SimpleNamespace(
        impact_digest="exact",
        sample_email="admin@example.test",
        preserved_admin_id=uuid4(),
        preserved_admin_role_id=uuid4(),
        preserved_member_role_id=uuid4(),
        workspace_snapshot=SimpleNamespace(id=workspace_id),
        storage_object_keys=("orphan",),
    )
    database = Mock()
    storage = Mock(list_object_keys=Mock(return_value=("orphan",)))
    storage.delete_and_verify_empty.side_effect = RuntimeError("unavailable")
    statements: list[str] = []
    monkeypatch.setattr(execution, "_begin_transaction", lambda _: None)
    monkeypatch.setattr(
        execution, "_execute", lambda _, statement, *args: statements.append(statement)
    )
    monkeypatch.setattr(execution, "_single_value", lambda *_: True)
    monkeypatch.setattr(execution, "_validate_postconditions", lambda *_args, **_kwargs: None)

    with pytest.raises(
        execution.ResetError, match=r"reset committed but Storage.*\(1 Storage-visible"
    ):
        execution.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation="exact",
            storage=storage,
            build_plan_fn=lambda *_, **__: plan,
        )

    assert database.commit.call_count == 1
    database.rollback.assert_not_called()
    assert statements.index("DELETE FROM public.files") < statements.index(
        "DELETE FROM public.records"
    )
    assert statements.index("DELETE FROM public.saved_views") < statements.index(
        "DELETE FROM public.modules"
    )


@pytest.mark.integration
@pytest.mark.skipif(
    TEST_DATABASE_URL is None, reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests"
)
def test_reset_current_head_deletes_related_rows_and_restores_workspace_defaults() -> None:
    class Storage:
        def __init__(self) -> None:
            self.keys = ("managed-file", "orphan-file")

        def list_object_keys(self) -> tuple[str, ...]:
            return self.keys

        def delete_and_verify_empty(self, keys: tuple[str, ...]) -> None:
            assert keys == self.keys
            self.keys = ()

    owner_url = os.environ["MIGRATION_DATABASE_URL"]
    storage = Storage()
    seeded_admin_id = uuid4()
    seeded_admin_email = f"reset-admin-{seeded_admin_id}@example.test"
    department_id, module_id, record_id, view_id, file_id = (uuid4() for _ in range(5))
    psycopg_url = owner_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with connect(psycopg_url) as database:
        with database.cursor() as cursor:
            cursor.execute(
                "SELECT id FROM public.roles WHERE role = 'admin' AND is_deleted = false"
            )
            (admin_role_id,) = cursor.fetchone()
            cursor.execute(
                """INSERT INTO auth.users (id, email, email_confirmed_at)
                   VALUES (%s, %s, now())""",
                (seeded_admin_id, seeded_admin_email),
            )
            cursor.execute(
                """UPDATE public.users SET username = %s, status = 'active',
                   is_deleted = false, deleted_at = NULL, role_id = %s
                   WHERE id = %s""",
                (f"reset_{seeded_admin_id.hex[:12]}", admin_role_id, seeded_admin_id),
            )
            cursor.execute(
                """SELECT profile.id, profile.email FROM public.users AS profile
                   JOIN public.roles AS role ON role.id = profile.role_id
                   JOIN auth.users AS identity ON identity.id = profile.id
                   WHERE profile.status = 'active' AND profile.is_deleted = false
                     AND role.role = 'admin' AND role.is_deleted = false
                     AND identity.email_confirmed_at IS NOT NULL
                     AND identity.banned_until IS NULL AND identity.deleted_at IS NULL"""
            )
            admin_id, admin_email = cursor.fetchone()
            cursor.execute(
                "INSERT INTO public.departments (id, department_name) VALUES (%s, %s)",
                (department_id, "reset department"),
            )
            cursor.execute(
                "INSERT INTO public.modules (id, department_id, module_name) VALUES (%s, %s, %s)",
                (module_id, department_id, "reset module"),
            )
            cursor.execute(
                "INSERT INTO public.records (id, module_id, data) VALUES (%s, %s, '{}'::jsonb)",
                (record_id, module_id),
            )
            cursor.execute(
                """INSERT INTO public.saved_views
                   (id, module_id, owner_id, name, visibility, definition)
                   VALUES (%s, %s, %s, %s, %s, '{}'::jsonb)""",
                (view_id, module_id, admin_id, "reset view", "private"),
            )
            cursor.execute(
                """INSERT INTO public.files
                   (id, purpose, creator_id, filename, expected_size, object_key, state)
                   VALUES (%s, 'library_document', %s, 'reset.txt', 1,
                   'managed-file', 'awaiting_upload')""",
                (file_id, admin_id),
            )
            cursor.execute(
                """UPDATE public.workspace_profiles SET display_name = 'Changed',
                   legal_name = 'Changed', description = 'Changed',
                   contact_email = 'changed@example.test', logo_file_id = %s,
                   timezone = 'Asia/Manila', locale = 'fil-PH', revision = 9""",
                (file_id,),
            )
        database.commit()
        plan = reset.build_reset_plan(database, admin_email, storage_object_keys=storage.keys)
        execution.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=plan.impact_digest,
            storage=storage,
        )
        with database.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM public.files UNION ALL "
                "SELECT count(*) FROM public.saved_views UNION ALL "
                "SELECT count(*) FROM public.records UNION ALL "
                "SELECT count(*) FROM public.modules UNION ALL "
                "SELECT count(*) FROM public.departments"
            )
            assert [row[0] for row in cursor.fetchall()] == [0, 0, 0, 0, 0]
            cursor.execute(
                """SELECT display_name, legal_name, logo_file_id, timezone, locale, revision
                   FROM public.workspace_profiles WHERE id = %s""",
                (plan.workspace_snapshot.id,),
            )
            assert cursor.fetchone() == ("OpenSlate", None, None, "UTC", "en-US", 1)
            cursor.execute("SELECT id FROM auth.users ORDER BY id")
            assert tuple(row[0] for row in cursor.fetchall()) == tuple(
                identity.id for identity in plan.auth_identities
            )
    assert storage.keys == ()


@pytest.mark.parametrize("failure", ["lock", "changed_plan"])
def test_reset_rolls_back_before_deleting_when_locked_plan_cannot_be_verified(
    monkeypatch, failure
) -> None:
    canary = token_urlsafe(32)
    database = MagicMock()
    database.info = None
    storage = Mock(list_object_keys=Mock(return_value=()))
    monkeypatch.setattr(reset, "require_api_stopped", lambda _: None)
    plan = SimpleNamespace(impact_digest="confirmed", sample_email="admin@example.test")
    if failure == "lock":
        database.execute.side_effect = RuntimeError(canary)
    else:
        monkeypatch.setattr(
            reset, "build_reset_plan", lambda *_, **__: SimpleNamespace(impact_digest="changed")
        )
    with pytest.raises(reset.ResetError) as error:
        reset.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=plan.impact_digest,
            storage=storage,
            backend_port="8000",
        )
    database.rollback.assert_called_once()
    database.commit.assert_not_called()
    assert canary not in str(error.value)
    assert all("DELETE" not in str(call) for call in database.execute.call_args_list)


def test_reset_rejects_remote_or_mismatched_database_and_missing_owner_environment() -> None:
    password = token_urlsafe(32)
    local = f"postgresql://postgres:{password}@127.0.0.1:54322/postgres"
    assert reset.validate_local_database_url(local) is None
    for url in (local.replace("127.0.0.1", "remote.example"), local.replace("54322", "55322")):
        with pytest.raises(reset.ResetError) as error:
            reset.validate_local_database_url(url)
        assert password not in str(error.value)
    with pytest.raises(reset.ResetError):
        reset.validate_local_database_url(
            local, expected_url=local.replace(password, token_urlsafe(32))
        )
    with pytest.raises(reset.ResetError):
        reset.required_environment({"DATABASE_URL": local, "ADMIN_EMAIL": "admin@example.test"})
