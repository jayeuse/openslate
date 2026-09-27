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
from operations.reset_models import ACCESS_POLICY_DEFAULTS_ID, ACCESS_POLICY_VERSION_ID
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
    group_id, membership_id = uuid4(), uuid4()
    default_group_id, default_department_id = uuid4(), uuid4()
    service_identity_id, rule_id, user_department_id = uuid4(), uuid4(), uuid4()
    admin_email = f"reset-admin-{admin_id}@example.test"
    member_role_id = None

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
                cursor.execute("DELETE FROM public.access_rules WHERE id = %s", (rule_id,))
                cursor.execute(
                    "DELETE FROM public.access_group_members WHERE id = %s", (membership_id,)
                )
                cursor.execute(
                    "DELETE FROM public.access_default_groups WHERE id = %s", (default_group_id,)
                )
                cursor.execute(
                    "DELETE FROM public.access_default_departments WHERE id = %s",
                    (default_department_id,),
                )
                cursor.execute(
                    "DELETE FROM public.user_departments WHERE id = %s", (user_department_id,)
                )
                cursor.execute(
                    "DELETE FROM public.service_identities WHERE id = %s",
                    (service_identity_id,),
                )
                cursor.execute("DELETE FROM public.access_groups WHERE id = %s", (group_id,))
                if member_role_id is not None:
                    cursor.execute(
                        "UPDATE public.access_policy_defaults SET singleton_key = 'workspace', "
                        "default_role_id = %s, invitation_expiry_days = 7, "
                        "guest_duration_days = 30, "
                        "service_duration_days = 90, default_deny = true, "
                        "require_guest_sponsor = true, require_service_owner = true, revision = 1, "
                        "deleted_at = NULL, is_deleted = false, performed_by = NULL "
                        "WHERE id = %s",
                        (member_role_id, ACCESS_POLICY_DEFAULTS_ID),
                    )
                cursor.execute(
                    "UPDATE public.access_policy_versions SET singleton_key = 'workspace', "
                    "revision = 1, deleted_at = NULL, is_deleted = false, performed_by = NULL "
                    "WHERE id = %s",
                    (ACCESS_POLICY_VERSION_ID,),
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
            cursor.execute("SELECT id FROM public.roles WHERE role = 'admin'")
            (admin_role_id,) = cursor.fetchone()
            cursor.execute("SELECT id FROM public.roles WHERE role = 'member'")
            (member_role_id,) = cursor.fetchone()
            cursor.execute(
                "INSERT INTO public.users "
                "(id, email, supabase_user_id, username, status, role_id, display_name, "
                "identity_kind, "
                "sponsor_user_id, expires_at, job_title, invitation_sent_at, "
                "invitation_accepted_at, tokens_valid_after) "
                "VALUES (%s, %s, %s, %s, 'active', %s, 'Reset Administrator', "
                "'internal', NULL, NULL, "
                "'Operations', now() - interval '1 day', now() - interval '1 day', "
                "now() - interval '1 day'), (%s, %s, %s, %s, 'active', %s, "
                "'Reset Member', 'internal', "
                "NULL, NULL, 'Member', NULL, NULL, NULL), "
                "(%s, %s, %s, %s, 'active', %s, 'Reset Guest', "
                "'guest', %s, now() + interval '30 days', NULL, NULL, NULL, NULL)",
                (
                    admin_id,
                    admin_email,
                    admin_provider_id,
                    f"reset_admin_{admin_id.hex[:12]}",
                    admin_role_id,
                    member_id,
                    f"reset-member-{member_id}@example.test",
                    member_provider_id,
                    f"reset_member_{member_id.hex[:12]}",
                    member_role_id,
                    guest_id,
                    f"reset-guest-{guest_id}@example.test",
                    guest_provider_id,
                    f"reset_guest_{guest_id.hex[:12]}",
                    member_role_id,
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
                "INSERT INTO public.access_groups (id, name, description, performed_by) "
                "VALUES (%s, %s, %s, %s)",
                (group_id, f"Reset Group {group_id}", "temporary fixture", admin_id),
            )
            cursor.execute(
                "INSERT INTO public.access_group_members (id, group_id, user_id, performed_by) "
                "VALUES (%s, %s, %s, %s)",
                (membership_id, group_id, member_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.access_default_groups "
                "(id, policy_defaults_id, group_id, performed_by) VALUES (%s, %s, %s, %s)",
                (default_group_id, ACCESS_POLICY_DEFAULTS_ID, group_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.access_default_departments "
                "(id, policy_defaults_id, department_id, performed_by) "
                "VALUES (%s, %s, %s, %s)",
                (default_department_id, ACCESS_POLICY_DEFAULTS_ID, department_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.service_identities "
                "(id, name, purpose, owner_id, role_id, expires_at, performed_by) "
                "VALUES (%s, 'Reset Service', 'temporary reset fixture', %s, %s, "
                "now() + interval '30 days', %s)",
                (service_identity_id, member_id, member_role_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.access_rules "
                "(id, subject_kind, subject_id, scope_kind, scope_id, permission_id, decision, "
                "policy_version, performed_by) "
                "VALUES (%s, 'user', %s, 'department', %s, 'departments.read', 'allow', 2, %s)",
                (rule_id, member_id, department_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.user_departments "
                "(id, user_id, department_id, is_primary, performed_by) "
                "VALUES (%s, %s, %s, true, %s)",
                (user_department_id, member_id, department_id, admin_id),
            )
            cursor.execute(
                "UPDATE public.access_policy_defaults SET default_role_id = %s, "
                "invitation_expiry_days = 14, guest_duration_days = 45, "
                "service_duration_days = 120, revision = 9, performed_by = %s "
                "WHERE id = %s",
                (admin_role_id, admin_id, ACCESS_POLICY_DEFAULTS_ID),
            )
            cursor.execute(
                "UPDATE public.access_policy_versions SET revision = 9, is_deleted = true, "
                "deleted_at = now(), performed_by = %s WHERE id = %s",
                (admin_id, ACCESS_POLICY_VERSION_ID),
            )
        database.commit()
        plan = reset.build_reset_plan(
            database, admin_email, storage_object_keys=storage.list_object_keys()
        )
        assert all(
            plan.counts[name] == 1
            for name in (
                "access_default_departments",
                "access_default_groups",
                "access_group_members",
                "access_groups",
                "access_rules",
                "service_identities",
                "user_departments",
                "access_policy_defaults",
                "access_policy_versions",
            )
        )
        changed_defaults = replace(
            plan,
            access_policy_defaults_snapshot=replace(
                plan.access_policy_defaults_snapshot,
                invitation_expiry_days=plan.access_policy_defaults_snapshot.invitation_expiry_days
                + 1,
            ),
        )
        assert reset_planning._impact_digest(changed_defaults) != plan.impact_digest
        restore_access_policy = execution._reset_access_policy_singletons

        def fail_after_access_policy_write(connection, locked_plan) -> None:
            restore_access_policy(connection, locked_plan)
            raise RuntimeError("injected Access reset failure")

        with monkeypatch.context() as injected_failure:
            injected_failure.setattr(
                execution, "_reset_access_policy_singletons", fail_after_access_policy_write
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
            for table_name in (
                "access_default_departments",
                "access_default_groups",
                "access_group_members",
                "access_groups",
                "access_rules",
                "service_identities",
                "user_departments",
            ):
                cursor.execute(f"SELECT count(*) FROM public.{table_name}")
                assert cursor.fetchone() == (1,)
            cursor.execute("SELECT count(*) FROM public.files WHERE id = %s", (file_id,))
            assert cursor.fetchone() == (1,)
        assert reset_planning._read_access_policy_defaults(database) == (
            plan.access_policy_defaults_snapshot
        )
        assert reset_planning._read_access_policy_version(database) == (
            plan.access_policy_version_snapshot
        )
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
            for table_name in (
                "access_default_departments",
                "access_default_groups",
                "access_group_members",
                "access_groups",
                "access_rules",
                "service_identities",
                "user_departments",
            ):
                cursor.execute(f"SELECT count(*) FROM public.{table_name}")
                assert cursor.fetchone() == (0,)
            cursor.execute(
                "SELECT id, singleton_key, default_role_id, invitation_expiry_days, "
                "guest_duration_days, service_duration_days, default_deny, "
                "require_guest_sponsor, require_service_owner, revision, deleted_at, is_deleted, "
                "performed_by FROM public.access_policy_defaults"
            )
            assert cursor.fetchone() == (
                ACCESS_POLICY_DEFAULTS_ID,
                "workspace",
                member_role_id,
                7,
                30,
                90,
                True,
                True,
                True,
                1,
                None,
                False,
                None,
            )
            cursor.execute(
                "SELECT id, singleton_key, revision, deleted_at, is_deleted, performed_by "
                "FROM public.access_policy_versions"
            )
            assert cursor.fetchone() == (
                ACCESS_POLICY_VERSION_ID,
                "workspace",
                1,
                None,
                False,
                None,
            )
            cursor.execute(
                "SELECT identity_kind, sponsor_user_id, expires_at, display_name, job_title, "
                "invitation_sent_at, invitation_accepted_at, tokens_valid_after "
                "FROM public.users WHERE id = %s",
                (admin_id,),
            )
            preserved_profile = cursor.fetchone()
            assert preserved_profile[:5] == (
                "internal",
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
            assert cursor.fetchone() == (1, "2", None)
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
