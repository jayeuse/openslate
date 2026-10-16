"""Guarded PostgreSQL coverage for combined Boards, OpenView, and Access reset."""

from __future__ import annotations

from uuid import uuid4

import pytest
from psycopg import connect

from app.systems.boards.post_models import publication_content_fingerprint
from operations import reset_application_data as reset
from operations.reset import execution
from operations.reset import planning as reset_planning
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
def test_reset_removes_board_report_dashboard_hierarchy_and_preserves_administrator(
    request, monkeypatch
) -> None:
    reset_database = guarded_reset_database(monkeypatch)
    storage, auth = provider_doubles()
    admin_id, member_id, session_id = uuid4(), uuid4(), uuid4()
    admin_provider_id, member_provider_id = uuid4(), uuid4()
    department_id, group_id = uuid4(), uuid4()
    module_id, title_field_id, file_id = uuid4(), uuid4(), uuid4()
    dashboard_id, widget_id = uuid4(), uuid4()
    board_id, project_board_id, company_board_id, record_id = uuid4(), uuid4(), uuid4(), uuid4()
    event_id, post_id = uuid4(), uuid4()
    report_id, run_id, work_id = uuid4(), uuid4(), uuid4()
    admin_email = f"reset-admin-{admin_id}@example.test"
    auth.list_account_ids.return_value = (member_provider_id,)
    org_id = uuid4()
    second: SecondOrganization | None = None

    def cleanup(cursor) -> None:
        cursor.execute(
            "UPDATE public.organizations SET logo_file_id = NULL WHERE logo_file_id = %s",
            (file_id,),
        )
        for table, column, owned_id in (
            ("in_app_notifications", "work_id", work_id),
            ("scheduled_work", "id", work_id),
            ("report_run_eligible_users", "run_id", run_id),
            ("report_run_rows", "run_id", run_id),
            ("report_runs", "id", run_id),
            ("report_schedules", "report_id", report_id),
            ("reports", "id", report_id),
            ("board_event_reminders", "event_id", event_id),
            ("board_post_revisions", "post_id", post_id),
            ("board_posts", "id", post_id),
            ("board_events", "id", event_id),
            ("dashboard_widgets", "dashboard_id", dashboard_id),
            ("dashboards", "id", dashboard_id),
            ("records", "id", record_id),
        ):
            cursor.execute(f"DELETE FROM public.{table} WHERE {column} = %s", (owned_id,))
        for table in ("board_groups", "group_access", "group_members"):
            cursor.execute(f"DELETE FROM public.{table} WHERE group_id = %s", (group_id,))
        cursor.execute(
            "DELETE FROM public.boards WHERE id IN (%s, %s, %s)",
            (board_id, project_board_id, company_board_id),
        )
        cursor.execute(
            "UPDATE public.modules SET title_field_id = NULL WHERE id = %s", (module_id,)
        )
        cursor.execute("DELETE FROM public.fields WHERE id = %s", (title_field_id,))
        cursor.execute("DELETE FROM public.modules WHERE id = %s", (module_id,))
        cursor.execute("DELETE FROM public.departments WHERE id = %s", (department_id,))
        cursor.execute("DELETE FROM public.files WHERE id = %s", (file_id,))
        cursor.execute("DELETE FROM public.groups WHERE id = %s", (group_id,))
        delete_sessions_and_rate_limits(cursor, (admin_id, member_id))
        cursor.execute("DELETE FROM public.memberships WHERE org_id = %s", (org_id,))
        cursor.execute("DELETE FROM public.platform_operators WHERE user_id = %s", (admin_id,))
        if second is not None:
            delete_second_organization(cursor, second)
        cursor.execute("DELETE FROM public.users WHERE id IN (%s, %s)", (admin_id, member_id))
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
                "INSERT INTO public.users (id, email, supabase_user_id, username, status) "
                "VALUES (%s, %s, %s, %s, 'active'), "
                "(%s, %s, %s, %s, 'active')",
                (
                    admin_id,
                    admin_email,
                    admin_provider_id,
                    f"reset_admin_{admin_id.hex[:12]}",
                    member_id,
                    f"reset-member-{member_id}@example.test",
                    member_provider_id,
                    f"reset_member_{member_id.hex[:12]}",
                ),
            )
            cursor.execute(
                "INSERT INTO public.memberships (id, org_id, user_id, role, status) "
                "VALUES (gen_random_uuid(), %s, %s, 'admin', 'active'), "
                "(gen_random_uuid(), %s, %s, 'member', 'active')",
                (org_id, admin_id, org_id, member_id),
            )
            operator_id = insert_operator(cursor, admin_id)
            second = insert_second_organization(cursor)
            insert_sessions_and_rate_limits(
                cursor, admin_id=admin_id, member_id=member_id, session_id=session_id
            )
            insert_department(cursor, department_id, admin_id)
            cursor.execute(
                "INSERT INTO public.groups (org_id, id, name, performed_by) "
                "VALUES (%s, %s, %s, %s)",
                (org_id, group_id, f"reset-group-{group_id.hex[:12]}", admin_id),
            )
            cursor.execute(
                "INSERT INTO public.group_members (org_id, id, group_id, user_id) "
                "VALUES (%s, %s, %s, %s)",
                (org_id, uuid4(), group_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.group_access (org_id, id, group_id, department_id, level) "
                "VALUES (%s, %s, %s, %s, 'read')",
                (org_id, uuid4(), group_id, department_id),
            )
            cursor.execute(
                "INSERT INTO public.modules (org_id, id, department_id, module_name) "
                "VALUES (%s, %s, %s, %s)",
                (org_id, module_id, department_id, f"reset-module-{module_id.hex[:12]}"),
            )
            cursor.execute(
                "INSERT INTO public.fields (org_id, id, module_id, name, type, required, position) "
                "VALUES (%s, %s, %s, 'Title', 'text', true, 0)",
                (org_id, title_field_id, module_id),
            )
            cursor.execute(
                "UPDATE public.modules SET title_field_id = %s WHERE id = %s",
                (title_field_id, module_id),
            )
            insert_logo_file(cursor, file_id, admin_id)
            cursor.execute(
                "UPDATE public.organizations SET logo_file_id = %s, currency = 'USD', "
                "week_start = 'sunday', business_hours = '10:00–16:00', mark = 'ACME', "
                "theme = 'stockroom' WHERE id = %s",
                (file_id, org_id),
            )
            plan_before_dashboard = reset.build_reset_plan(
                database, admin_email, storage_object_keys=storage.list_object_keys()
            )
            cursor.execute(
                "INSERT INTO public.dashboards (org_id, id, department_id, name) "
                "VALUES (%s, %s, %s, %s)",
                (org_id, dashboard_id, department_id, f"reset-dashboard-{dashboard_id.hex[:12]}"),
            )
            cursor.execute(
                "INSERT INTO public.dashboard_widgets "
                "(org_id, id, dashboard_id, position, widget_type, config) "
                "VALUES (%s, %s, %s, 0, 'chart', '{}'::jsonb)",
                (org_id, widget_id, dashboard_id),
            )
            cursor.execute(
                "INSERT INTO public.boards (org_id, id, scope, department_id, name) "
                "VALUES (%s, %s, 'department', %s, %s), (%s, %s, 'project', NULL, %s), "
                "(%s, %s, 'company', NULL, 'Company Board')",
                (
                    org_id, board_id, department_id, "Reset board",
                    org_id, project_board_id, "Reset project",
                    org_id, company_board_id,
                ),
            )
            cursor.execute(
                "INSERT INTO public.board_groups (org_id, id, board_id, group_id, level) "
                "VALUES (%s, %s, %s, %s, 'write')",
                (org_id, uuid4(), project_board_id, group_id),
            )
            cursor.execute(
                "INSERT INTO public.board_events(org_id,id,board_id,author_id,title,all_day,"
                "start_date,end_date,timezone_name) VALUES "
                "(%s,%s,%s,%s,'R',true,current_date,current_date,'UTC')",
                (org_id, event_id, board_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.board_event_reminders "
                "(org_id, id, board_id, event_id, timing) VALUES (%s, %s, %s, %s, '1d')",
                (org_id, uuid4(), board_id, event_id),
            )
            cursor.execute(
                "INSERT INTO public.board_posts "
                "(org_id, id, board_id, author_id, title, body, status) "
                "VALUES (%s, %s, %s, %s, 'Reset notice', 'Private notice', 'published')",
                (org_id, post_id, board_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.board_post_revisions "
                "(org_id, id, post_id, publication_number, publication_key, "
                "content_fingerprint, author_id, title, body, published_at) VALUES "
                "(%s, %s, %s, 1, %s, %s, %s, 'Reset notice', 'Private notice', now())",
                (
                    org_id,
                    uuid4(),
                    post_id,
                    uuid4(),
                    publication_content_fingerprint(
                        author_id=member_id,
                        title="Reset notice",
                        body="Private notice",
                    ),
                    member_id,
                ),
            )
            cursor.execute(
                "INSERT INTO public.records (org_id, id, module_id) VALUES (%s, %s, %s)",
                (org_id, record_id, module_id),
            )
            cursor.execute(
                "INSERT INTO public.reports (org_id, id, module_id, name, recipe) "
                "VALUES (%s, %s, %s, %s, '{}'::jsonb)",
                (org_id, report_id, module_id, "Reset report"),
            )
            cursor.execute(
                "INSERT INTO public.report_schedules "
                "(org_id, id, report_id, enabled, cadence, timezone_name, local_time, "
                "next_due_at) VALUES (%s, %s, %s, true, 'daily', 'UTC', '09:00', now())",
                (org_id, uuid4(), report_id),
            )
            cursor.execute(
                "INSERT INTO public.report_runs "
                "(org_id, id, report_id, module_id, idempotency_key, recipe_revision, "
                "recipe, headings, row_count, csv_bytes) "
                "VALUES (%s, %s, %s, %s, %s, 1, '{}'::jsonb, '[\"Name\"]'::jsonb, 1, %s)",
                (org_id, run_id, report_id, module_id, uuid4(), b"Name\r\nReady\r\n"),
            )
            cursor.execute(
                "INSERT INTO public.report_run_rows "
                "(org_id, id, run_id, position, record_id, cells) "
                "VALUES (%s, %s, %s, 0, %s, '[\"Ready\"]'::jsonb)",
                (org_id, uuid4(), run_id, record_id),
            )
            cursor.execute(
                "INSERT INTO public.report_run_eligible_users (org_id, run_id, user_id) "
                "VALUES (%s, %s, %s)",
                (org_id, run_id, member_id),
            )
            cursor.execute(
                "INSERT INTO public.scheduled_work "
                "(org_id, id, kind, report_id, scheduled_for, next_attempt_at, state, "
                "attempt_count, run_id, created_at, updated_at) VALUES "
                "(%s, %s, 'report-run', %s, now(), now(), 'succeeded', 1, %s, now(), now())",
                (org_id, work_id, report_id, run_id),
            )
            cursor.execute(
                "INSERT INTO public.in_app_notifications (org_id, id, work_id, recipient_id, "
                "kind, subject_type, subject_id) "
                "VALUES (%s, %s, %s, %s, 'report-run', 'report_run', %s)",
                (org_id, uuid4(), work_id, member_id, run_id),
            )
        database.commit()
        with pytest.raises(reset.ResetError, match="reset plan changed"):
            apply_confirmed(
                database,
                plan_before_dashboard,
                storage=storage,
                auth=auth,
            )
        plan = reset.build_reset_plan(
            database, admin_email, storage_object_keys=storage.list_object_keys()
        )
        for table in (
            "groups group_members group_access board_groups board_event_reminders "
            "board_post_revisions board_posts board_events "
            "dashboard_widgets dashboards reports report_schedules "
            "report_runs report_run_rows report_run_eligible_users "
            "scheduled_work in_app_notifications"
        ).split():
            assert plan.counts[table] == 1
        # Three Boards here and the second organization's company and department Boards.
        assert plan.counts["boards"] == 5
        assert plan.counts["organizations"] == 2
        assert plan.counts["fields"] == 1
        assert plan.counts["modules"] == 1
        assert plan.impact_digest != plan_before_dashboard.impact_digest
        # A look change in either organization after the preview needs a fresh preview.
        for changed_org, column, original, changed in (
            (org_id, "currency", "USD", "EUR"),
            (org_id, "week_start", "sunday", "monday"),
            (org_id, "business_hours", "10:00–16:00", "08:00–17:00"),
            (org_id, "mark", "ACME", "CHANGED"),
            (org_id, "theme", "stockroom", "triplicate"),
            (second.org_id, "theme", "whiteboard", "triplicate"),
        ):
            with database.cursor() as cursor:
                cursor.execute(
                    f"UPDATE public.organizations SET {column} = %s WHERE id = %s",
                    (changed, changed_org),
                )
            database.commit()
            try:
                changed_plan = reset.build_reset_plan(
                    database, admin_email, storage_object_keys=storage.list_object_keys()
                )
                assert changed_plan.impact_digest != plan.impact_digest, column
                with pytest.raises(reset.ResetError, match="reset plan changed"):
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
                    cursor.execute(
                        f"UPDATE public.organizations SET {column} = %s WHERE id = %s",
                        (original, changed_org),
                    )
                database.commit()

        # A look change after preflight must also fail the locked digest check.
        def change_theme_during_provider_cleanup(_account_ids):
            with database.cursor() as cursor:
                cursor.execute(
                    "UPDATE public.organizations SET theme = 'triplicate' WHERE id = %s",
                    (second.org_id,),
                )
            database.commit()

        auth.delete_and_verify_missing.side_effect = change_theme_during_provider_cleanup
        auth.list_account_ids.side_effect = ((member_provider_id,), ())
        with pytest.raises(reset.ResetError, match="Provider accounts.*profiles were retained"):
            apply_confirmed(
                database,
                plan,
                storage=storage,
                auth=auth,
            )
        with database.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM public.users")
            assert cursor.fetchone() == (3,)
            cursor.execute(
                "UPDATE public.organizations SET theme = 'whiteboard' WHERE id = %s",
                (second.org_id,),
            )
        database.commit()
        auth.delete_and_verify_missing.side_effect = None
        storage.delete_and_verify_empty.assert_not_called()
        delete_rows = execution._delete_application_rows
        verified = execution._validate_postconditions

        # Each postcondition refuses a transaction that leaves an organization behind or
        # changes the preserved operator, and the whole transaction rolls back.
        def recreate_organization(connection) -> None:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO public.organizations (id, slug, display_name, timezone, "
                    "locale) VALUES (%s, %s, 'Recreated', 'UTC', 'en-US')",
                    (uuid4(), f"reset-recreated-{uuid4()}"),
                )

        def remove_preserved_operator(connection) -> None:
            with connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM public.platform_operators WHERE user_id = %s", (admin_id,)
                )

        for violation, refusal in (
            (recreate_organization, "An organization remained"),
            (remove_preserved_operator, "postcondition was not met"),
        ):

            def violate_after_deletes(connection, *, violation=violation) -> None:
                delete_rows(connection)
                violation(connection)

            with monkeypatch.context() as injected_failure:
                injected_failure.setattr(
                    execution, "_delete_application_rows", violate_after_deletes
                )
                def checked(connection, locked_plan, *, refusal=refusal, **options) -> None:
                    with pytest.raises(reset.ResetError, match=refusal):
                        verified(connection, locked_plan, **options)
                    raise reset.ResetError(refusal)

                injected_failure.setattr(execution, "_validate_postconditions", checked)
                auth.list_account_ids.side_effect = ((member_provider_id,), ())
                with pytest.raises(
                    reset.ResetError, match="Provider accounts.*profiles were retained"
                ):
                    apply_confirmed(
                        database,
                        plan,
                        storage=storage,
                        auth=auth,
                    )
            assert reset_planning._read_organizations(database) == plan.organization_snapshot
            with database.cursor() as cursor:
                cursor.execute("SELECT id FROM public.platform_operators")
                assert cursor.fetchall() == [(operator_id,)]
            database.rollback()
            storage.delete_and_verify_empty.assert_not_called()
        # Restart the mocked provider fixture for the successful attempt.
        auth.reset_mock()
        auth.list_account_ids.side_effect = ((member_provider_id,), ())
        apply_confirmed(
            database,
            plan,
            storage=storage,
            auth=auth,
        )
        with database.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM public.identity_sessions")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.identity_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            cursor.execute("SELECT count(*) FROM public.lifecycle_rate_limit_buckets")
            assert cursor.fetchone() == (0,)
            for table in ("groups", "group_members", "group_access"):
                cursor.execute(f"SELECT count(*) FROM public.{table}")
                assert cursor.fetchone() == (0,)
            for table in (
                "board_groups board_event_reminders board_post_revisions "
                "board_posts board_events dashboard_widgets "
                "dashboards reports report_schedules report_runs "
                "report_run_rows report_run_eligible_users scheduled_work in_app_notifications "
                "records fields modules files sandbox_test_runs"
            ).split():
                cursor.execute(f"SELECT count(*) FROM public.{table}")
                assert cursor.fetchone() == (0,), table
            # Both organizations are gone and nothing is recreated: no company Board,
            # no Sandbox document, and only the preserved operator account remains.
            assert_only_the_operator_remains(cursor, admin_id, operator_id)
    assert storage.list_object_keys() == ()
    auth.require_present.assert_called_once_with(admin_provider_id)
    auth.delete_and_verify_missing.assert_called_once_with((member_provider_id,))
