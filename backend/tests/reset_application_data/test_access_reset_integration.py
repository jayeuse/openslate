"""Guarded PostgreSQL coverage for resetting Access-owned state."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest
from psycopg import connect

from operations import reset_application_data as reset
from operations.reset import execution
from operations.reset import planning as reset_planning
from operations.reset.backups import read_backup_snapshot, validate_backup_preservation
from tests.reset_application_data.execution_support import apply_confirmed
from tests.reset_application_data.reset_integration_support import (
    SecondOrganization,
    assert_only_the_operator_remains,
    delete_second_organization,
    delete_sessions_and_rate_limits,
    guarded_reset_database,
    insert_department,
    insert_logo_file,
    insert_operator,
    insert_second_organization,
    insert_sessions_and_rate_limits,
    provider_doubles,
)


@pytest.mark.integration
def test_reset_removes_local_sessions_and_preserves_provider_bound_administrator(
    request, monkeypatch
) -> None:
    reset_database = guarded_reset_database(monkeypatch)
    storage, auth = provider_doubles()
    admin_id, member_id, guest_id, session_id = uuid4(), uuid4(), uuid4(), uuid4()
    admin_provider_id, member_provider_id, guest_provider_id = uuid4(), uuid4(), uuid4()
    provider_account_ids = tuple(sorted((member_provider_id, guest_provider_id), key=str))
    department_id, file_id = uuid4(), uuid4()
    group_id, membership_id, access_id = uuid4(), uuid4(), uuid4()
    backup_ids = tuple(uuid4() for _ in range(6))
    admin_email = f"reset-admin-{admin_id}@example.test"
    org_id = uuid4()
    second: SecondOrganization | None = None

    def cleanup(cursor) -> None:
        cursor.execute("DELETE FROM public.backup_runs WHERE id = ANY(%s)", (list(backup_ids),))
        cursor.execute("DELETE FROM public.backup_policies WHERE id = %s", (backup_ids[0],))
        cursor.execute("DELETE FROM public.update_statuses WHERE id = %s", (backup_ids[1],))
        cursor.execute(
            "UPDATE public.organizations SET logo_file_id = NULL WHERE logo_file_id = %s",
            (file_id,),
        )
        cursor.execute("DELETE FROM public.group_access WHERE id = %s", (access_id,))
        cursor.execute("DELETE FROM public.group_members WHERE id = %s", (membership_id,))
        cursor.execute("DELETE FROM public.groups WHERE id = %s", (group_id,))
        delete_sessions_and_rate_limits(cursor, (admin_id, member_id, guest_id))
        cursor.execute("DELETE FROM public.files WHERE id = %s", (file_id,))
        cursor.execute("DELETE FROM public.departments WHERE id = %s", (department_id,))
        cursor.execute("DELETE FROM public.memberships WHERE org_id = %s", (org_id,))
        cursor.execute("DELETE FROM public.platform_operators WHERE user_id = %s", (admin_id,))
        if second is not None:
            delete_second_organization(cursor, second)
        cursor.execute(
            "DELETE FROM public.users WHERE id IN (%s, %s, %s)",
            (admin_id, member_id, guest_id),
        )
        cursor.execute("DELETE FROM public.audit_logs WHERE org_id = %s", (org_id,))
        cursor.execute("DELETE FROM public.organizations WHERE id = %s", (org_id,))

    reset_database.clean_up_after(request, cleanup)
    with connect(reset_database.url) as database:
        with database.cursor() as cursor:
            cursor.execute(
                "INSERT INTO public.organizations (id, slug, display_name, timezone, locale) "
                "VALUES (%s, %s, 'Reset organization', 'UTC', 'en-US')",
                (org_id, f"reset-{org_id}"),
            )
            cursor.execute(
                "INSERT INTO public.users "
                "(id, email, supabase_user_id, username, status, display_name, "
                "job_title, tokens_valid_after) "
                "VALUES (%s, %s, %s, %s, 'active', 'Reset Administrator', "
                "'Operations', now() - interval '1 day'), "
                "(%s, %s, %s, %s, 'active', 'Reset Member', 'Member', NULL), "
                "(%s, %s, %s, %s, 'active', 'Reset Guest', NULL, NULL)",
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
                ),
            )
            cursor.execute(
                "INSERT INTO public.memberships "
                "(id, org_id, user_id, role, status, sponsor_user_id, expires_at, "
                "invitation_sent_at, invitation_accepted_at) "
                "VALUES (gen_random_uuid(), %s, %s, 'admin', 'active', NULL, NULL, "
                "now() - interval '1 day', now() - interval '1 day'), "
                "(gen_random_uuid(), %s, %s, 'member', 'active', NULL, NULL, NULL, NULL), "
                "(gen_random_uuid(), %s, %s, 'guest', 'active', %s, "
                "now() + interval '30 days', NULL, NULL)",
                (org_id, admin_id, org_id, member_id, org_id, guest_id, member_id),
            )
            operator_id = insert_operator(cursor, admin_id)
            second = insert_second_organization(cursor)
            insert_sessions_and_rate_limits(
                cursor, admin_id=admin_id, member_id=member_id, session_id=session_id
            )
            cursor.execute(
                "INSERT INTO public.identity_mfa_observations "
                "(user_id, observed_provider_user_id, verified_totp, observed_at) "
                "VALUES (%s, %s, true, now()), (%s, %s, false, now())",
                (admin_id, admin_provider_id, member_id, member_provider_id),
            )
            insert_department(cursor, department_id, admin_id)
            insert_logo_file(cursor, file_id, admin_id)
            cursor.execute("UPDATE public.organizations SET logo_file_id = %s WHERE id = %s",
                           (file_id, org_id))
            cursor.execute(
                "INSERT INTO public.groups (org_id, id, name, description, performed_by) "
                "VALUES (%s, %s, %s, %s, %s)",
                (org_id, group_id, f"Reset Group {group_id}", "temporary fixture", admin_id),
            )
            cursor.execute(
                "INSERT INTO public.group_members (org_id, id, group_id, user_id, performed_by) "
                "VALUES (%s, %s, %s, %s, %s)",
                (org_id, membership_id, group_id, member_id, admin_id),
            )
            cursor.execute(
                "INSERT INTO public.group_access "
                "(org_id, id, group_id, department_id, level, performed_by) "
                "VALUES (%s, %s, %s, %s, 'write', %s)",
                (org_id, access_id, group_id, department_id, admin_id),
            )
            cursor.execute(
                "UPDATE public.organizations SET invitation_expiry_days = 14, "
                "guest_duration_days = 45 WHERE id = %s", (org_id,)
            )
            cursor.execute("SELECT current_setting('cluster_name', true)")
            instance = cursor.fetchone()[0]
            cursor.execute(
                "INSERT INTO public.backup_policies (id, installation_id, timezone, schedule, "
                "retention_days, revision, next_due_at, runner_last_seen_at, performed_by) "
                "VALUES (%s, %s, 'Asia/Manila', 'weekly', 90, 3, now() + interval '1 week', "
                "now(), %s)",
                (backup_ids[0], instance, member_id),
            )
            cursor.execute(
                "INSERT INTO public.update_statuses "
                "(id, latest_version, release_url, observed_at, checked_at, performed_by) "
                "VALUES (%s, '0.2.0', 'https://github.com/example/project/releases/tag/v0.2.0', "
                "now(), now(), %s)",
                (backup_ids[1], member_id),
            )
            for run_id, owner, state in (
                (backup_ids[2], instance, "queued"),
                (backup_ids[3], instance, "succeeded"),
                (backup_ids[4], "previous-installation", "running"),
                (backup_ids[5], "another-installation", "queued"),
            ):
                started = state != "queued"
                complete = state == "succeeded"
                cursor.execute(
                    "INSERT INTO public.backup_runs (id, installation_id, name, provenance, "
                    "requester_id, idempotency_hash, schedule, retention_days, requested_at, "
                    "claim_id, claimed_schedule, claimed_retention_days, state, started_at, "
                    "finished_at, reconciled_at, snapshot_id, manifest_sha256, verified_at, "
                    "performed_by) VALUES (%s, %s, 'Reset backup', 'manual', %s, %s, 'weekly', 90, "
                    "now() - interval '2 hours', %s, %s, %s, %s, "
                    "CASE WHEN %s THEN now() - interval '1 hour' END, "
                    "CASE WHEN %s THEN now() END, CASE WHEN %s THEN now() END, %s, %s, "
                    "CASE WHEN %s THEN now() END, %s)",
                    (
                        run_id,
                        owner,
                        member_id,
                        run_id.hex * 2,
                        uuid4() if started else None,
                        "weekly" if started else None,
                        90 if started else None,
                        state,
                        started,
                        complete,
                        complete,
                        "a" * 64 if complete else None,
                        "b" * 64 if complete else None,
                        complete,
                        member_id,
                    ),
                )
        database.commit()
        plan = reset.build_reset_plan(
            database, admin_email, storage_object_keys=storage.list_object_keys()
        )
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.users")
            original_profile_ids = set(cursor.fetchall())
        assert {(admin_id,), (member_id,), (guest_id,), (second.user_id,)} <= (
            original_profile_ids
        )
        assert plan.counts["organizations"] == 2
        assert plan.counts["memberships"] == 4
        assert plan.preserved_operator_id == operator_id
        assert plan.backup_snapshot == read_backup_snapshot(database)
        assert plan.counts["identity_mfa_observations"] >= 2
        assert plan.counts["backup_runs"] == 4
        # Commit an unresolved claim after preview, then prove both preview and the
        # post-advisory-lock guard refuse before any provider deletion for all states.
        for state in ("running", "failed", "interrupted"):
            unresolved_id = uuid4()
            with database.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO public.backup_runs (id, installation_id, name, provenance, "
                    "idempotency_hash, schedule, retention_days, requested_at, claim_id, "
                    "claimed_schedule, claimed_retention_days, state, started_at, finished_at, "
                    "failure_code) VALUES (%s, %s, 'Unresolved reset blocker', 'manual', %s, "
                    "'disabled', 30, now() - interval '2 hours', %s, 'disabled', 30, %s, "
                    "now() - interval '1 hour', CASE WHEN %s <> 'running' THEN now() END, %s)",
                    (
                        unresolved_id,
                        instance,
                        unresolved_id.hex * 2,
                        uuid4(),
                        state,
                        state,
                        None if state == "running" else "restart_failed",
                    ),
                )
            database.commit()
            try:
                with pytest.raises(reset.ResetError, match="reconciliation"):
                    reset.build_reset_plan(database, admin_email)
                with pytest.raises(reset.ResetError, match="reconciliation"):
                    apply_confirmed(
                        database,
                        plan,
                        storage=storage,
                        auth=auth,
                    )
                auth.delete_and_verify_missing.assert_not_called()
            finally:
                database.rollback()
                with database.cursor() as cursor:
                    cursor.execute("DELETE FROM public.backup_runs WHERE id = %s", (unresolved_id,))
                database.commit()
        assert all(plan.counts[name] == 1 for name in ("groups", "group_members", "group_access"))
        frozen = {row["id"]: row for row in map(json.loads, plan.organization_snapshot)}
        assert set(frozen) == {str(org_id), str(second.org_id)}
        assert (
            frozen[str(org_id)]["invitation_expiry_days"],
            frozen[str(org_id)]["guest_duration_days"],
        ) == (14, 45)
        # A settings change in either organization after the preview needs a fresh preview.
        for changed_org in (org_id, second.org_id):
            with database.cursor() as cursor:
                cursor.execute(
                    "UPDATE public.organizations SET guest_duration_days = 46 WHERE id = %s",
                    (changed_org,),
                )
            assert reset.build_reset_plan(
                database, admin_email, storage_object_keys=storage.list_object_keys()
            ).impact_digest != plan.impact_digest
            database.rollback()
        delete_rows = execution._delete_application_rows

        def fail_after_access_deletes(connection) -> None:
            delete_rows(connection)
            raise RuntimeError("injected Access reset failure")

        with monkeypatch.context() as injected_failure:
            injected_failure.setattr(
                execution, "_delete_application_rows", fail_after_access_deletes
            )
            auth.list_account_ids.side_effect = (provider_account_ids, ())
            with pytest.raises(reset.ResetError, match="Provider accounts.*profiles were retained"):
                apply_confirmed(
                    database,
                    plan,
                    storage=storage,
                    auth=auth,
                )
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.users ORDER BY id")
            assert set(cursor.fetchall()) == original_profile_ids
            for table_name in ("groups", "group_members", "group_access"):
                cursor.execute(f"SELECT count(*) FROM public.{table_name}")
                assert cursor.fetchone() == (1,)
            cursor.execute("SELECT count(*) FROM public.files WHERE id = %s", (file_id,))
            assert cursor.fetchone() == (1,)
            cursor.execute("SELECT count(*) FROM public.memberships")
            assert cursor.fetchone() == (4,)
        assert reset_planning._read_organizations(database) == plan.organization_snapshot
        assert read_backup_snapshot(database) == plan.backup_snapshot
        assert storage.list_object_keys() == plan.storage_object_keys
        # Restart the mocked provider fixture for the independent successful attempt.
        auth.list_account_ids.side_effect = (provider_account_ids, ())
        apply_confirmed(
            database,
            plan,
            storage=storage,
            auth=auth,
        )
        validate_backup_preservation(database, plan.backup_snapshot, admin_id)
        with database.cursor() as cursor:
            cursor.execute("SELECT id, requester_id, performed_by FROM public.backup_runs")
            assert set(cursor.fetchall()) == {(value, None, None) for value in backup_ids[3:]}
        with database.cursor() as cursor:
            cursor.execute("SELECT id FROM public.users")
            assert cursor.fetchall() == [(admin_id,)]
            cursor.execute("SELECT count(*) FROM public.identity_sessions")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.identity_mfa_observations")
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
                "SELECT display_name, job_title, tokens_valid_after, supabase_user_id, "
                "status, is_deleted FROM public.users WHERE id = %s",
                (admin_id,),
            )
            assert cursor.fetchone() == (
                "Reset Administrator",
                "Operations",
                plan.profile_snapshot.tokens_valid_after,
                admin_provider_id,
                "active",
                False,
            )
            assert_only_the_operator_remains(cursor, admin_id, operator_id)
            cursor.execute("SELECT count(*) FROM public.files")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.sandbox_test_runs")
            assert cursor.fetchone() == (0,)
    assert storage.list_object_keys() == ()
    auth.require_present.assert_called_with(admin_provider_id)
    auth.delete_and_verify_missing.assert_called_with(provider_account_ids)
