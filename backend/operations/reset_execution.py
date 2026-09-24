"""Transactional reset execution and postcondition checks."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from app.systems.sandbox.designs.defaults import empty_document
from app.systems.sandbox.designs.service import canonical_document

if __package__:
    from .reset_models import (  # type: ignore[import-not-found]
        _COUNT_STATEMENTS,
        _LOCK_APPLICATION_STATEMENT,
        _RESET_ADVISORY_LOCK_KEY,
        _SCANNER_LEADER_LOCK_KEY,
        ACCESS_POLICY_DEFAULTS_ID,
        ACCESS_POLICY_VERSION_ID,
        DELETE_ORDER,
        NON_PRESERVED_TABLES,
        ResetError,
        ResetPlan,
        stable_snapshot_payload,
    )
    from .reset_planning import (  # type: ignore[import-not-found]
        _expected_snapshot_payload,
        _read_access_policy_defaults,
        _read_access_policy_version,
        _read_alembic_head,
        _read_credential,
        _read_profile,
        _read_roles,
        _read_workspace,
        _single_value,
        build_reset_plan,
    )
else:
    from reset_models import (
        _COUNT_STATEMENTS,
        _LOCK_APPLICATION_STATEMENT,
        _RESET_ADVISORY_LOCK_KEY,
        _SCANNER_LEADER_LOCK_KEY,
        ACCESS_POLICY_DEFAULTS_ID,
        ACCESS_POLICY_VERSION_ID,
        DELETE_ORDER,
        NON_PRESERVED_TABLES,
        ResetError,
        ResetPlan,
        stable_snapshot_payload,
    )
    from reset_planning import (
        _expected_snapshot_payload,
        _read_access_policy_defaults,
        _read_access_policy_version,
        _read_alembic_head,
        _read_credential,
        _read_profile,
        _read_roles,
        _read_workspace,
        _single_value,
        build_reset_plan,
    )


def _begin_transaction(connection: Any) -> None:
    info = getattr(connection, "info", None)
    status = getattr(info, "transaction_status", None)
    if status is not None and getattr(status, "name", str(status)) != "IDLE":
        return
    connection.execute("BEGIN")


def _execute(connection: Any, statement: str, params: tuple[object, ...] | None = None) -> None:
    with connection.cursor() as cursor:
        cursor.execute(statement, params) if params is not None else cursor.execute(statement)


def _rollback_safely(connection: Any) -> None:
    try:
        connection.rollback()
    except Exception:
        pass


def _reset_sandbox_workspace(connection: Any) -> None:
    """Restore the required Sandbox singleton without configured entities or versions."""
    document = empty_document()
    payload, content_hash, byte_count = canonical_document(document)
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    _execute(
        connection,
        """UPDATE public.sandbox_documents
              SET singleton_key = true, schema_version = 2, revision = 1,
                  document = %s::jsonb, content_hash = %s, byte_count = %s,
                  deleted_at = NULL, is_deleted = false, updated_at = now(),
                  performed_by = NULL
            WHERE singleton_key = true""",
        (encoded, content_hash, byte_count),
    )


def _reset_access_policy_singletons(connection: Any, plan: ResetPlan) -> None:
    """Restore seeded Access policy values without replacing either singleton row."""
    _execute(
        connection,
        """UPDATE public.access_policy_defaults
              SET singleton_key = 'workspace', default_role_id = %s,
                  invitation_expiry_days = 7, guest_duration_days = 30,
                  service_duration_days = 90, default_deny = true,
                  require_guest_sponsor = true, require_service_owner = true,
                  revision = 1, deleted_at = NULL, is_deleted = false,
                  updated_at = now(), performed_by = NULL
            WHERE id = %s""",
        (plan.preserved_member_role_id, ACCESS_POLICY_DEFAULTS_ID),
    )
    _execute(
        connection,
        """UPDATE public.access_policy_versions
              SET singleton_key = 'workspace', revision = 1, deleted_at = NULL,
                  is_deleted = false, updated_at = now(), performed_by = NULL
            WHERE id = %s""",
        (ACCESS_POLICY_VERSION_ID,),
    )


def _validate_postconditions(
    connection: Any,
    plan: ResetPlan,
    *,
    read_profile_fn: Callable[..., Any] | None = None,
    read_roles_fn: Callable[..., Any] | None = None,
) -> None:
    read_profile = read_profile_fn or _read_profile
    read_roles = read_roles_fn or _read_roles
    count_statements = dict(_COUNT_STATEMENTS)
    for table_name in NON_PRESERVED_TABLES:
        if _single_value(connection, count_statements[table_name]) != 0:
            raise ResetError("The reset postcondition was not met")

    if _single_value(connection, count_statements["users"]) != 1:
        raise ResetError("The reset postcondition was not met")
    if _single_value(connection, count_statements["roles"]) != 2:
        raise ResetError("The reset postcondition was not met")
    if (
        _single_value(connection, count_statements["access_policy_defaults"]) != 1
        or _single_value(connection, count_statements["access_policy_versions"]) != 1
    ):
        raise ResetError("The Access policy singleton reset postcondition was not met")
    if (
        _single_value(connection, count_statements["sandbox_documents"]) != 1
        or _single_value(connection, count_statements["sandbox_versions"]) != 0
    ):
        raise ResetError("The Sandbox reset postcondition was not met")

    profile = read_profile(connection, plan.preserved_admin_id)
    if (
        stable_snapshot_payload(profile)
        != _expected_snapshot_payload(plan.profile_snapshot, plan.preserved_admin_id)
        or profile.role_id != plan.preserved_admin_role_id
    ):
        raise ResetError("The preserved administrator profile changed")

    roles = read_roles(connection)
    if {role.id for role in roles} != {
        plan.preserved_admin_role_id,
        plan.preserved_member_role_id,
    }:
        raise ResetError("The preserved role set changed")
    role_by_id = {role.id: role for role in roles}
    admin_after = stable_snapshot_payload(role_by_id[plan.preserved_admin_role_id])
    admin_expected = _expected_snapshot_payload(plan.admin_role_snapshot, plan.preserved_admin_id)
    member_after = stable_snapshot_payload(role_by_id[plan.preserved_member_role_id])
    member_expected = _expected_snapshot_payload(plan.member_role_snapshot, plan.preserved_admin_id)
    if admin_after != admin_expected or member_after != member_expected:
        raise ResetError("The preserved roles changed")

    workspace = _read_workspace(connection)
    if (
        workspace.id != plan.workspace_snapshot.id
        or workspace.singleton_key is not True
        or workspace.display_name != "OpenSlate"
        or workspace.legal_name is not None
        or workspace.description is not None
        or workspace.contact_email is not None
        or workspace.contact_phone is not None
        or workspace.postal_address is not None
        or workspace.logo_file_id is not None
        or workspace.timezone != "UTC"
        or workspace.locale != "en-US"
        or workspace.revision != 1
        or workspace.deleted_at is not None
        or workspace.is_deleted is not False
        or workspace.performed_by is not None
    ):
        raise ResetError("The workspace reset postcondition was not met")

    credential = _read_credential(connection, plan.preserved_admin_id)
    if stable_snapshot_payload(credential) != stable_snapshot_payload(plan.credential_snapshot):
        raise ResetError("The preserved administrator credential changed")

    policy_defaults = _read_access_policy_defaults(connection)
    if (
        policy_defaults.id != plan.access_policy_defaults_snapshot.id
        or policy_defaults.singleton_key != "workspace"
        or policy_defaults.created_at != plan.access_policy_defaults_snapshot.created_at
        or policy_defaults.default_role_id != plan.preserved_member_role_id
        or policy_defaults.invitation_expiry_days != 7
        or policy_defaults.guest_duration_days != 30
        or policy_defaults.service_duration_days != 90
        or policy_defaults.default_deny is not True
        or policy_defaults.require_guest_sponsor is not True
        or policy_defaults.require_service_owner is not True
        or policy_defaults.revision != 1
        or policy_defaults.deleted_at is not None
        or policy_defaults.is_deleted is not False
        or policy_defaults.performed_by is not None
    ):
        raise ResetError("The Access policy defaults reset postcondition was not met")

    policy_version = _read_access_policy_version(connection)
    if (
        policy_version.id != plan.access_policy_version_snapshot.id
        or policy_version.singleton_key != "workspace"
        or policy_version.created_at != plan.access_policy_version_snapshot.created_at
        or policy_version.revision != 1
        or policy_version.deleted_at is not None
        or policy_version.is_deleted is not False
        or policy_version.performed_by is not None
    ):
        raise ResetError("The Access policy version reset postcondition was not met")

    if _read_alembic_head(connection) != plan.alembic_head:
        raise ResetError("The database migration head changed")


def apply_reset(
    connection: Any,
    plan: ResetPlan,
    *,
    execute: bool = False,
    stdin_is_tty: bool = False,
    confirmation: str | None = None,
    storage: Any | None = None,
    read_profile_fn: Callable[..., Any] | None = None,
    read_roles_fn: Callable[..., Any] | None = None,
    build_plan_fn: Callable[..., ResetPlan] | None = None,
) -> None:
    """Apply one freshly confirmed plan, or do nothing for the default dry run."""
    if not execute:
        return
    if not stdin_is_tty:
        raise ResetError("Execute mode requires a TTY")
    if confirmation != plan.impact_digest:
        raise ResetError("An exact impact-digest confirmation is required")
    if storage is None:
        raise ResetError("Storage cleanup must be configured for execute mode")

    committed = False
    try:
        _begin_transaction(connection)
        _execute(connection, "SET LOCAL lock_timeout = '5s'")
        _execute(connection, "SET LOCAL statement_timeout = '30s'")
        _execute(connection, "SELECT pg_advisory_xact_lock(%s)", (_RESET_ADVISORY_LOCK_KEY,))
        scanner_stopped = _single_value(
            connection, "SELECT pg_try_advisory_xact_lock(%s)", (_SCANNER_LEADER_LOCK_KEY,)
        )
        if scanner_stopped is not True:
            raise ResetError("The scanner worker must be stopped before reset")
        _execute(connection, _LOCK_APPLICATION_STATEMENT)

        locked_plan = (build_plan_fn or build_reset_plan)(
            connection, plan.sample_email, storage_object_keys=storage.list_object_keys()
        )
        if locked_plan.impact_digest != plan.impact_digest:
            raise ResetError("The reset plan changed; run a fresh dry run and confirmation")

        _execute(
            connection,
            """UPDATE public.workspace_profiles SET display_name = 'OpenSlate',
               legal_name = NULL, description = NULL, contact_email = NULL,
               contact_phone = NULL, postal_address = NULL,
               logo_file_id = NULL, timezone = 'UTC', locale = 'en-US', revision = 1,
               performed_by = NULL WHERE id = %s""",
            (locked_plan.workspace_snapshot.id,),
        )
        for table_name in DELETE_ORDER:
            _execute(connection, f"DELETE FROM public.{table_name}")
        _reset_access_policy_singletons(connection, locked_plan)
        _reset_sandbox_workspace(connection)
        _execute(
            connection,
            "DELETE FROM public.identity_credentials WHERE user_id <> %s",
            (locked_plan.preserved_admin_id,),
        )
        _execute(
            connection,
            "DELETE FROM public.users WHERE identity_kind = 'guest' AND id <> %s",
            (locked_plan.preserved_admin_id,),
        )
        _execute(
            connection,
            "DELETE FROM public.users WHERE id <> %s",
            (locked_plan.preserved_admin_id,),
        )
        _execute(
            connection,
            "DELETE FROM public.roles WHERE id NOT IN (%s, %s)",
            (locked_plan.preserved_admin_role_id, locked_plan.preserved_member_role_id),
        )
        _validate_postconditions(
            connection,
            locked_plan,
            read_profile_fn=read_profile_fn,
            read_roles_fn=read_roles_fn,
        )
        connection.commit()
        committed = True
    except ResetError:
        _rollback_safely(connection)
        raise
    except Exception:
        _rollback_safely(connection)
        raise ResetError("Unable to apply application-data reset") from None
    if committed:
        try:
            storage.delete_and_verify_empty(locked_plan.storage_object_keys)
        except Exception:
            try:
                remaining = str(len(storage.list_object_keys()))
            except Exception:
                remaining = "unknown"
            raise ResetError(
                "Application data reset committed but private storage cleanup is incomplete "
                f"({remaining} private files remain); "
                "run a fresh dry run before retrying"
            ) from None
