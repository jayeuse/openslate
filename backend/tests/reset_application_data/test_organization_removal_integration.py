"""Guarded PostgreSQL coverage for removing one sample pack's organizations only."""

from __future__ import annotations

from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest
from psycopg import Cursor, connect

from operations.reset.models import ResetError
from operations.reset.organization import AuthAccount, build_organization_removal_plan
from operations.reset.organization_execution import apply_organization_removal
from tests.reset_application_data.reset_integration_support import (
    SecondOrganization,
    delete_second_organization,
    guarded_reset_database,
    insert_operator,
    insert_second_organization,
)

_SECOND_ORG_TABLES = ("memberships", "departments", "boards", "sandbox_documents")


def _insert_user(cursor: Cursor, user_id: UUID, email: str, provider_id: UUID | None) -> None:
    cursor.execute(
        "INSERT INTO public.users (id, email, supabase_user_id, username, status) "
        "VALUES (%s, %s, %s, %s, 'active')",
        (user_id, email, provider_id, f"removal_{user_id.hex[:12]}"),
    )


def _second_org_counts(cursor: Cursor, second: SecondOrganization) -> dict[str, int]:
    counts = {}
    for table in _SECOND_ORG_TABLES:
        cursor.execute(f"SELECT count(*) FROM public.{table} WHERE org_id = %s", (second.org_id,))
        counts[table] = cursor.fetchone()[0]
    return counts


@pytest.mark.integration
def test_removal_deletes_only_the_pack_organizations_and_their_own_accounts(
    request, monkeypatch
) -> None:
    database_target = guarded_reset_database(monkeypatch)
    pack = uuid4().hex[:10]
    slug, partner_slug, domain = f"sample-rm{pack}", f"sample-rm{pack}-partner", f"rm{pack}.example"
    org_id, partner_id = uuid4(), uuid4()
    operator_id, shared_id, lapsed_id, solo_id, stray_id, sponsored_id = (uuid4() for _ in range(6))
    operator_provider, shared_provider, solo_provider, stray_provider, orphan_provider = (
        uuid4() for _ in range(5)
    )
    logo_id, avatar_id, notification_id, pack_audit_id, installation_audit_id = (
        uuid4() for _ in range(5)
    )
    operator_email = f"operator-{operator_id}@example.test"
    users = [operator_id, shared_id, lapsed_id, solo_id, stray_id, sponsored_id]
    second: SecondOrganization | None = None

    def cleanup(cursor: Cursor) -> None:
        cursor.execute("DELETE FROM public.in_app_notifications WHERE id = %s", (notification_id,))
        cursor.execute("UPDATE public.users SET avatar_file_id = NULL WHERE id = ANY(%s)", (users,))
        cursor.execute(
            "UPDATE public.organizations SET logo_file_id = NULL WHERE id = ANY(%s)",
            ([org_id, partner_id],),
        )
        cursor.execute("DELETE FROM public.files WHERE id = ANY(%s)", ([logo_id, avatar_id],))
        cursor.execute(
            "DELETE FROM public.audit_logs WHERE id = ANY(%s)",
            ([pack_audit_id, installation_audit_id],),
        )
        for table in ("departments", "memberships"):
            cursor.execute(
                f"DELETE FROM public.{table} WHERE org_id = ANY(%s)", ([org_id, partner_id],)
            )
        if second is not None:
            delete_second_organization(cursor, second)
        cursor.execute("DELETE FROM public.platform_operators WHERE user_id = %s", (operator_id,))
        cursor.execute("DELETE FROM public.users WHERE id = ANY(%s)", (users,))
        cursor.execute(
            "DELETE FROM public.organizations WHERE id = ANY(%s)", ([org_id, partner_id],)
        )

    database_target.clean_up_after(request, cleanup)
    with connect(database_target.url) as database:
        with database.cursor() as cursor:
            for organization, organization_slug in ((org_id, slug), (partner_id, partner_slug)):
                cursor.execute(
                    "INSERT INTO public.organizations (id, slug, display_name, timezone, locale) "
                    "VALUES (%s, %s, 'Removal pack', 'UTC', 'en-US')",
                    (organization, organization_slug),
                )
            _insert_user(cursor, operator_id, operator_email, operator_provider)
            _insert_user(cursor, shared_id, f"shared-{shared_id}@example.test", shared_provider)
            _insert_user(cursor, lapsed_id, f"lapsed-{lapsed_id}@example.test", None)
            _insert_user(cursor, solo_id, f"solo@{domain}", solo_provider)
            _insert_user(cursor, stray_id, f"stray@{domain}", stray_provider)
            _insert_user(cursor, sponsored_id, f"sponsored-{sponsored_id}@example.test", None)
            insert_operator(cursor, operator_id)
            second = insert_second_organization(cursor)
            for organization, user_id, deleted in (
                (org_id, operator_id, False),
                (partner_id, operator_id, False),
                (second.org_id, operator_id, False),
                (org_id, shared_id, False),
                (second.org_id, shared_id, False),
                (org_id, lapsed_id, False),
                # A soft-deleted membership still restricts the account, so it stays.
                (second.org_id, lapsed_id, True),
                (org_id, solo_id, False),
                (partner_id, solo_id, False),
            ):
                cursor.execute(
                    "INSERT INTO public.memberships "
                    "(id, org_id, user_id, role, status, is_deleted, deleted_at) "
                    "VALUES (%s, %s, %s, 'member', 'active', %s, "
                    "CASE WHEN %s THEN now() END)",
                    (uuid4(), organization, user_id, deleted, deleted),
                )
            for organization in (org_id, partner_id):
                cursor.execute(
                    "INSERT INTO public.departments (org_id, id, department_name) "
                    "VALUES (%s, %s, 'Removal department')",
                    (organization, uuid4()),
                )
            cursor.execute(
                "INSERT INTO public.files (org_id, id, purpose, creator_id, filename, "
                "expected_size, object_key, state) VALUES "
                "(%s, %s, 'workspace_logo', %s, 'logo.png', 1, %s, 'awaiting_upload'), "
                "(NULL, %s, 'user_avatar', %s, 'avatar.png', 1, %s, 'awaiting_upload')",
                (org_id, logo_id, solo_id, uuid4().hex, avatar_id, solo_id, uuid4().hex),
            )
            cursor.execute(
                "UPDATE public.organizations SET logo_file_id = %s WHERE id = %s", (logo_id, org_id)
            )
            cursor.execute(
                "UPDATE public.users SET avatar_file_id = %s WHERE id = %s", (avatar_id, solo_id)
            )
            cursor.execute(
                "INSERT INTO public.in_app_notifications "
                "(id, org_id, kind, subject_type, subject_id, recipient_id) "
                "VALUES (%s, NULL, 'backup-failed', 'backup_run', %s, %s)",
                (notification_id, uuid4(), solo_id),
            )
            cursor.execute(
                "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type, "
                "entity_id) VALUES (%s, %s, now(), 'create', 'departments', %s), "
                "(%s, NULL, now(), 'update', 'users', %s)",
                (pack_audit_id, org_id, uuid4(), installation_audit_id, solo_id),
            )
            second_before = _second_org_counts(cursor, second)
        database.commit()

        storage_keys = {
            f"openslate-ready/org/{org_id}/logo",
            f"openslate-ready/org/{second.org_id}/kept",
            f"openslate-avatars/user/{solo_id}/avatar",
            f"openslate-avatars/user/{shared_id}/avatar",
        }
        storage = Mock()
        storage.list_prefixed_keys.side_effect = lambda prefixes: tuple(
            sorted(key for key in storage_keys if any(key.startswith(f"{p}/") for p in prefixes))
        )
        auth = Mock()
        accounts = (
            AuthAccount(orphan_provider, f"orphan@{domain}"),
            AuthAccount(solo_provider, f"solo@{domain}", solo_id),
        )

        def plan(slugs: tuple[str, ...] = (slug, partner_slug)):
            return build_organization_removal_plan(
                database,
                slugs=slugs,
                operator_email=operator_email,
                domains={domain},
                auth_accounts=accounts,
                list_storage_keys=storage.list_prefixed_keys,
            )

        def apply(confirmed) -> object:
            return apply_organization_removal(
                database,
                confirmed,
                confirmation=confirmed.impact_digest,
                auth=auth,
                storage=storage,
                list_auth_accounts=lambda: accounts,
            )

        confirmed = plan()
        database.rollback()
        assert set(confirmed.organization_ids) == {org_id, partner_id}
        assert confirmed.removable_user_ids == tuple(sorted((solo_id, stray_id)))
        assert {operator_id, shared_id, lapsed_id} <= set(confirmed.kept_member_ids)
        assert set(confirmed.provider_account_ids) == {
            solo_provider,
            stray_provider,
            orphan_provider,
        }
        assert dict(confirmed.null_organization_deletions) == {
            "files": 1,
            "in_app_notifications": 1,
        }
        assert (
            confirmed.target_counts["organizations"],
            confirmed.target_counts["memberships"],
            confirmed.target_counts["departments"],
            confirmed.target_counts["files"],
            confirmed.target_counts["audit_logs"],
        ) == (2, 6, 2, 1, 1)
        assert confirmed.retained["memberships"][str(second.org_id)] == 4
        assert confirmed.storage_object_keys == (
            f"openslate-avatars/user/{solo_id}/avatar",
            f"openslate-ready/org/{org_id}/logo",
        )

        # An account that sponsors a guest in another organization is not the pack's alone.
        with database.cursor() as cursor:
            cursor.execute(
                "INSERT INTO public.memberships "
                "(id, org_id, user_id, role, status, sponsor_user_id, expires_at) "
                "VALUES (%s, %s, %s, 'guest', 'active', %s, now() + interval '30 days')",
                (uuid4(), second.org_id, sponsored_id, solo_id),
            )
        with pytest.raises(ResetError, match="referenced outside its organizations: memberships"):
            plan()
        database.rollback()

        # A change in another organization after the preview needs a fresh preview.
        changed_department = uuid4()
        with database.cursor() as cursor:
            cursor.execute(
                "INSERT INTO public.departments (org_id, id, department_name) "
                "VALUES (%s, %s, 'Added after preview')",
                (second.org_id, changed_department),
            )
        database.commit()
        with pytest.raises(ResetError, match="plan changed"):
            apply(confirmed)
        auth.delete_and_verify_missing.assert_not_called()
        with database.cursor() as cursor:
            cursor.execute("DELETE FROM public.departments WHERE id = %s", (changed_department,))
        database.commit()

        # A row delete that fails (for example on the statement timeout) rolls back before any
        # provider account is touched, so a fresh dry run can still finish the removal.
        from operations.reset import organization_execution

        def timed_out(*_args: object) -> None:
            raise RuntimeError("canceling statement due to statement timeout")

        with monkeypatch.context() as patched:
            patched.setattr(organization_execution, "_delete_rows", timed_out)
            with pytest.raises(ResetError, match="Unable to remove the organizations"):
                apply(confirmed)
        auth.delete_and_verify_missing.assert_not_called()
        with database.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM public.organizations WHERE id = ANY(%s)",
                ([org_id, partner_id],),
            )
            assert cursor.fetchone() == (2,)
        database.rollback()
        auth.reset_mock()

        timings = apply(confirmed)

        assert "delete_users" in timings
        auth.require_present.assert_called_once_with(operator_provider)
        auth.delete_and_verify_missing.assert_called_once_with(confirmed.provider_account_ids)
        storage.delete_prefixed_and_verify_empty.assert_called_once_with(
            confirmed.storage_object_keys, confirmed.storage_prefixes
        )
        with database.cursor() as cursor:
            cursor.execute(
                "SELECT count(*) FROM public.organizations WHERE id = ANY(%s)",
                ([org_id, partner_id],),
            )
            assert cursor.fetchone() == (0,)
            assert _second_org_counts(cursor, second) == second_before
            cursor.execute("SELECT id FROM public.users WHERE id = ANY(%s) ORDER BY id", (users,))
            assert {row[0] for row in cursor.fetchall()} == {
                operator_id,
                shared_id,
                lapsed_id,
                sponsored_id,
            }
            cursor.execute(
                "SELECT user_id, org_id FROM public.memberships WHERE user_id = ANY(%s)",
                ([shared_id, lapsed_id],),
            )
            assert set(cursor.fetchall()) == {
                (shared_id, second.org_id),
                (lapsed_id, second.org_id),
            }
            cursor.execute("SELECT supabase_user_id FROM public.users WHERE id = %s", (shared_id,))
            assert cursor.fetchone() == (shared_provider,)
            cursor.execute(
                "SELECT count(*) FROM public.platform_operators WHERE user_id = %s",
                (operator_id,),
            )
            assert cursor.fetchone() == (1,)
            cursor.execute(
                "SELECT count(*) FROM public.files WHERE id = ANY(%s)", ([logo_id, avatar_id],)
            )
            assert cursor.fetchone() == (0,)
            cursor.execute(
                "SELECT count(*) FROM public.in_app_notifications WHERE id = %s",
                (notification_id,),
            )
            assert cursor.fetchone() == (0,)
            cursor.execute(
                "SELECT id FROM public.audit_logs WHERE id = ANY(%s)",
                ([pack_audit_id, installation_audit_id],),
            )
            assert cursor.fetchall() == [(installation_audit_id,)]
