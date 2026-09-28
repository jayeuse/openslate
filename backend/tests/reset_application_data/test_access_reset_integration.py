"""Guarded PostgreSQL coverage for resetting Access-owned state."""

from __future__ import annotations

import os
from dataclasses import replace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from psycopg import connect

from operations import reset_application_data as reset
from operations import reset_execution as execution
from operations import reset_planning
from tests.conftest import _guard_integration_database


@pytest.mark.integration
def test_reset_removes_local_sessions_and_preserves_provider_bound_administrator(
    request, monkeypatch
) -> None:
    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    runtime_url = os.environ.get("TEST_DATABASE_URL")
    owner_url = os.environ.get("MIGRATION_DATABASE_URL")
    if runtime_url is None or owner_url is None:
        raise RuntimeError("Reset integration requires the disposable PostgreSQL runner")
    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    database_url = owner_url.replace("postgresql+psycopg://", "postgresql://", 1)
    storage = Mock()
    storage.list_object_keys.return_value = ()
    auth = Mock()
    admin_id, member_id, guest_id, session_id = uuid4(), uuid4(), uuid4(), uuid4()
    admin_provider_id, member_provider_id, guest_provider_id = uuid4(), uuid4(), uuid4()
    department_id, file_id = uuid4(), uuid4()
    group_id, membership_id, access_id = uuid4(), uuid4(), uuid4()
    admin_email = f"reset-admin-{admin_id}@example.test"

    def cleanup() -> None:
        _guard_integration_database(runtime_url)
        _guard_integration_database(owner_url)
        with connect(database_url) as database:
            with database.cursor() as cursor:
                cursor.execute(
                    "UPDATE public.workspace_profiles SET logo_file_id = NULL "
                    "WHERE logo_file_id = %s",
                    (file_id,),
                )
                cursor.execute("DELETE FROM public.group_access WHERE id = %s", (access_id,))
                cursor.execute("DELETE FROM public.group_members WHERE id = %s", (membership_id,))
                cursor.execute("DELETE FROM public.groups WHERE id = %s", (group_id,))
                cursor.execute(
                    "UPDATE public.workspace_profiles SET invitation_expiry_days = 7, "
                    "guest_duration_days = 30"
                )
                cursor.execute(
                    "DELETE FROM public.identity_sessions WHERE user_id IN (%s, %s, %s)",
                    (admin_id, member_id, guest_id),
                )
                cursor.execute(
                    "DELETE FROM public.lifecycle_rate_limit_buckets "
                    "WHERE actor_id IN (%s, %s, %s)",
                    (admin_id, member_id, guest_id),
                )
                cursor.execute(
                    "DELETE FROM public.identity_rate_limit_buckets WHERE fingerprint IN (%s, %s)",
                    ("1" * 64, "2" * 64),
                )
                cursor.execute("DELETE FROM public.files WHERE id = %s", (file_id,))
                cursor.execute("DELETE FROM public.departments WHERE id = %s", (department_id,))
                cursor.execute(
                    "DELETE FROM public.users WHERE id IN (%s, %s, %s)",
                    (admin_id, member_id, guest_id),
                )
            database.commit()

    request.addfinalizer(cleanup)
    with connect(database_url) as database:
        with database.cursor() as cursor:
            cursor.execute(
                "INSERT INTO public.users "
                "(id, email, supabase_user_id, username, status, role, display_name, "
                "sponsor_user_id, expires_at, job_title, invitation_sent_at, "
                "invitation_accepted_at, tokens_valid_after) "
                "VALUES (%s, %s, %s, %s, 'active', 'admin', 'Reset Administrator', "
                "NULL, NULL, "
                "'Operations', now() - interval '1 day', now() - interval '1 day', "
                "now() - interval '1 day'), (%s, %s, %s, %s, 'active', 'member', "
                "'Reset Member', "
                "NULL, NULL, 'Member', NULL, NULL, NULL), "
                "(%s, %s, %s, %s, 'active', 'guest', 'Reset Guest', "
                "%s, now() + interval '30 days', NULL, NULL, NULL, NULL)",
                (
                    admin_id,
                    admin_email,
                    admin_provider_id,
                    f"reset_admin_{admin_id.hex[:12]}",
                    member_id,
                    f"reset-member-{member_id}@example.test",
                    member_provider_id,
                    f"reset_member_{member_id.hex[:12]}",
                    guest_id,
                    f"reset-guest-{guest_id}@example.test",
                    guest_provider_id,
                    f"reset_guest_{guest_id.hex[:12]}",
                    member_id,
                ),
            )
            cursor.execute(
                "INSERT INTO public.identity_sessions "
                "(id, user_id, refresh_token_digest, csrf_token_digest, created_at, refreshed_at, "
                "expires_at) VALUES (%s, %s, %s, %s, now(), now(), now() + interval '1 day'), "
                "(%s, %s, %s, %s, now(), now(), now() + interval '1 day')",
                (
                    session_id,
                    admin_id,
                    "a" * 64,
                    "b" * 64,
                    uuid4(),
                    member_id,
                    "c" * 64,
                    "d" * 64,
                ),
            )
            cursor.execute(
                "INSERT INTO public.identity_rate_limit_buckets "
                "(fingerprint, attempt_count, window_started_at) "
                "VALUES (%s, 1, now()), (%s, 1, now())",
                ("1" * 64, "2" * 64),
            )
            cursor.execute(
                "INSERT INTO public.lifecycle_rate_limit_buckets "
                "(id, actor_id, attempt_count, window_started_at, window_expires_at) "
                "VALUES (%s, %s, 1, now(), now() + interval '1 minute'), "
                "(%s, %s, 1, now(), now() + interval '1 minute')",
                (uuid4(), admin_id, uuid4(), member_id),
            )
            cursor.execute(
                "INSERT INTO public.departments (id, department_name) VALUES (%s, %s)",
                (department_id, f"reset-{admin_id}"),
            )
            cursor.execute(
                "INSERT INTO public.files "
                "(id, purpose, creator_id, filename, expected_size, object_key, state) "
                "VALUES (%s, 'workspace_logo', %s, 'reset.png', 1, %s, 'awaiting_upload')",
                (file_id, admin_id, uuid4().hex),
            )
            cursor.execute("UPDATE public.workspace_profiles SET logo_file_id = %s", (file_id,))
            cursor.execute(
                "INSERT INTO public.groups (id, name, description, performed_by) "
                "VALUES (%s, %s, %s, %s)",
                (group_id, f"Reset Group {group_id}", "temporary fixture", admin_id),
            )
            cursor.execute(
                "INSERT INTO public.group_members (id, group_id, user_id, performed_by) "
                "VALUES (%s, %s, %s, %s)",
                (membership_id, group_id, member_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.group_access "
                "(id, group_id, department_id, level, performed_by) "
                "VALUES (%s, %s, %s, 'write', %s)",
                (access_id, group_id, department_id, admin_id),
            )
            cursor.execute(
                "UPDATE public.workspace_profiles SET invitation_expiry_days = 14, "
                "guest_duration_days = 45"
            )
        database.commit()
        plan = reset.build_reset_plan(
            database, admin_email, storage_object_keys=storage.list_object_keys()
        )
        assert all(plan.counts[name] == 1 for name in ("groups", "group_members", "group_access"))
        assert (
            plan.workspace_snapshot.invitation_expiry_days,
            plan.workspace_snapshot.guest_duration_days,
        ) == (14, 45)
        changed_settings = replace(
            plan,
            workspace_snapshot=replace(plan.workspace_snapshot, guest_duration_days=46),
        )
        assert reset_planning._impact_digest(changed_settings) != plan.impact_digest
        restore_sandbox = execution._reset_sandbox_workspace

        def fail_after_access_deletes(connection) -> None:
            restore_sandbox(connection)
            raise RuntimeError("injected Access reset failure")

        with monkeypatch.context() as injected_failure:
            injected_failure.setattr(
                execution, "_reset_sandbox_workspace", fail_after_access_deletes
            )
            with pytest.raises(reset.ResetError, match="Provider accounts.*profiles were retained"):
                execution.apply_reset(
                    database,
                    plan,
                    execute=True,
                    stdin_is_tty=True,
                    confirmation=plan.impact_digest,
                    storage=storage,
                    auth=auth,
                )
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.users ORDER BY id")
            assert set(cursor.fetchall()) == {(admin_id,), (member_id,), (guest_id,)}
            for table_name in ("groups", "group_members", "group_access"):
                cursor.execute(f"SELECT count(*) FROM public.{table_name}")
                assert cursor.fetchone() == (1,)
            cursor.execute("SELECT count(*) FROM public.files WHERE id = %s", (file_id,))
            assert cursor.fetchone() == (1,)
        assert reset_planning._read_workspace(database) == plan.workspace_snapshot
        assert storage.list_object_keys() == plan.storage_object_keys
        execution.apply_reset(
            database,
            plan,
            execute=True,
            stdin_is_tty=True,
            confirmation=plan.impact_digest,
            storage=storage,
            auth=auth,
        )
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.users")
            assert cursor.fetchall() == [(admin_id,)]
            cursor.execute("SELECT count(*) FROM public.identity_sessions")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.identity_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.lifecycle_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.departments")
            assert cursor.fetchone() == (0,)
            for table_name in ("groups", "group_members", "group_access"):
                cursor.execute(f"SELECT count(*) FROM public.{table_name}")
                assert cursor.fetchone() == (0,)
            cursor.execute(
                "SELECT invitation_expiry_days, guest_duration_days FROM public.workspace_profiles"
            )
            assert cursor.fetchone() == (7, 30)
            cursor.execute(
                "SELECT role, sponsor_user_id, expires_at, display_name, job_title, "
                "invitation_sent_at, invitation_accepted_at, tokens_valid_after "
                "FROM public.users WHERE id = %s",
                (admin_id,),
            )
            preserved_profile = cursor.fetchone()
            assert preserved_profile[:5] == (
                "admin",
                None,
                None,
                "Reset Administrator",
                "Operations",
            )
            assert preserved_profile[5:] == (
                plan.profile_snapshot.invitation_sent_at,
                plan.profile_snapshot.invitation_accepted_at,
                plan.profile_snapshot.tokens_valid_after,
            )
            cursor.execute("SELECT logo_file_id FROM public.workspace_profiles")
            assert cursor.fetchone() == (None,)
            cursor.execute(
                "SELECT revision, document->>'schemaVersion', performed_by "
                "FROM public.sandbox_documents"
            )
            assert cursor.fetchone() == (1, "4", None)
            cursor.execute(
                "SELECT sequence, kind, label, performed_by FROM public.sandbox_versions"
            )
            assert cursor.fetchall() == []
            cursor.execute("SELECT count(*) FROM public.sandbox_test_runs")
            assert cursor.fetchone() == (0,)
    assert storage.list_object_keys() == ()
    auth.require_present.assert_called_with(admin_provider_id)
    auth.delete_and_verify_missing.assert_called_with(
        (guest_provider_id, member_provider_id)
        if str(guest_id) < str(member_id)
        else (member_provider_id, guest_provider_id)
    )
