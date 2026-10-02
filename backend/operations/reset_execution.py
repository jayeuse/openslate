"""Transactional reset execution and postcondition checks."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from uuid6 import uuid7

from app.systems.boards.department_boards import COMPANY_BOARD_NAME
from app.systems.sandbox.designs.defaults import empty_document
from app.systems.sandbox.designs.schemas import DOCUMENT_SCHEMA_VERSION
from app.systems.sandbox.designs.service import canonical_document
from operations.reset_models import (
    _COUNT_STATEMENTS,
    _LOCK_APPLICATION_STATEMENT,
    _RESET_ADVISORY_LOCK_KEY,
    _SCANNER_LEADER_LOCK_KEY,
    DELETE_ORDER,
    NON_PRESERVED_TABLES,
    ResetError,
    ResetPlan,
    stable_snapshot_payload,
)
from operations.reset_planning import (
    _expected_snapshot_payload,
    _read_alembic_head,
    _read_profile,
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
              SET singleton_key = true, schema_version = %s, revision = 1,
                  document = %s::jsonb, content_hash = %s, byte_count = %s,
                  deleted_at = NULL, is_deleted = false, updated_at = now(),
                  performed_by = NULL
            WHERE singleton_key = true""",
        (DOCUMENT_SCHEMA_VERSION, encoded, content_hash, byte_count),
    )


def _reset_company_board(connection: Any) -> None:
    """Restore the one company Board after every Board row was deleted."""

    _execute(
        connection,
        """INSERT INTO public.boards (id, scope, department_id, name, status)
           VALUES (%s, 'company', NULL, %s, 'active')""",
        (uuid7(), COMPANY_BOARD_NAME),
    )


def _validate_postconditions(
    connection: Any,
    plan: ResetPlan,
    *,
    read_profile_fn: Callable[..., Any] | None = None,
) -> None:
    read_profile = read_profile_fn or _read_profile
    count_statements = dict(_COUNT_STATEMENTS)
    for table_name in NON_PRESERVED_TABLES:
        if _single_value(connection, count_statements[table_name]) != 0:
            raise ResetError("The reset postcondition was not met")

    if _single_value(connection, count_statements["users"]) != 1:
        raise ResetError("The reset postcondition was not met")
    if (
        _single_value(connection, count_statements["sandbox_documents"]) != 1
        or _single_value(connection, count_statements["sandbox_versions"]) != 0
    ):
        raise ResetError("The Sandbox reset postcondition was not met")
    if (
        _single_value(connection, count_statements["boards"]) != 1
        or _single_value(
            connection,
            "SELECT count(*) FROM public.boards WHERE scope = 'company' AND status = 'active'",
        )
        != 1
    ):
        raise ResetError("The company Board reset postcondition was not met")

    profile = read_profile(connection, plan.preserved_admin_id)
    if (
        stable_snapshot_payload(profile)
        != _expected_snapshot_payload(plan.profile_snapshot, plan.preserved_admin_id)
        or profile.role != "admin"
    ):
        raise ResetError("The preserved administrator profile changed")

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
        or workspace.invitation_expiry_days != 7
        or workspace.guest_duration_days != 30
        or workspace.deleted_at is not None
        or workspace.is_deleted is not False
        or workspace.performed_by is not None
    ):
        raise ResetError("The workspace reset postcondition was not met")

    if _read_alembic_head(connection) != plan.alembic_head:
        raise ResetError("The database migration head changed")


def apply_reset(
    connection: Any,
    plan: ResetPlan,
    *,
    execute: bool = False,
    stdin_is_tty: bool = False,
    noninteractive_development: bool = False,
    confirmation: str | None = None,
    storage: Any | None = None,
    auth: Any | None = None,
    read_profile_fn: Callable[..., Any] | None = None,
    build_plan_fn: Callable[..., ResetPlan] | None = None,
) -> None:
    """Apply one freshly confirmed plan, or do nothing for the default dry run."""
    if not execute:
        return
    if not stdin_is_tty and not noninteractive_development:
        raise ResetError("Execute mode requires a TTY")
    if confirmation != plan.impact_digest:
        raise ResetError("An exact impact-digest confirmation is required")
    if storage is None:
        raise ResetError("Storage cleanup must be configured for execute mode")
    if auth is None:
        raise ResetError("Auth cleanup must be configured for execute mode")

    committed = False
    sql_commit_started = False
    provider_cleanup_started = False
    provider_cleanup_completed = False
    reset_lock_held = False
    scanner_lock_held = False
    try:
        # The dry run may have left a read transaction open. Session advisory
        # locks survive transaction boundaries, so no table lock spans HTTP.
        connection.rollback()
        reset_lock_held = (
            _single_value(
                connection, "SELECT pg_try_advisory_lock(%s)", (_RESET_ADVISORY_LOCK_KEY,)
            )
            is True
        )
        if not reset_lock_held:
            raise ResetError("Another application reset is running")
        scanner_lock_held = (
            _single_value(
                connection, "SELECT pg_try_advisory_lock(%s)", (_SCANNER_LEADER_LOCK_KEY,)
            )
            is True
        )
        if not scanner_lock_held:
            raise ResetError("The scanner worker must be stopped before reset")
        connection.commit()

        preflight_plan = (build_plan_fn or build_reset_plan)(
            connection,
            plan.sample_email,
            storage_object_keys=storage.list_object_keys(),
            provider_account_ids=auth.list_account_ids(
                plan.preserved_admin_provider_id, plan.sample_email
            ),
        )
        if preflight_plan.impact_digest != plan.impact_digest:
            raise ResetError("The reset plan changed; run a fresh dry run and confirmation")
        connection.commit()
        auth.require_present(plan.preserved_admin_provider_id)
        provider_cleanup_started = True
        try:
            auth.delete_and_verify_missing(plan.provider_account_ids)
        except Exception:
            raise ResetError(
                "Provider account cleanup is incomplete; application profiles were retained; "
                "run a fresh dry run before retrying"
            ) from None
        provider_cleanup_completed = True
        if auth.list_account_ids(plan.preserved_admin_provider_id, plan.sample_email):
            raise ResetError("The provider Auth inventory changed after cleanup")

        # Re-inventory Storage before taking the short application table lock.
        # The final cleanup rechecks the same snapshot after SQL commit.
        final_storage_keys = storage.list_object_keys()

        _begin_transaction(connection)
        _execute(connection, "SET LOCAL lock_timeout = '5s'")
        _execute(connection, "SET LOCAL statement_timeout = '30s'")
        _execute(connection, _LOCK_APPLICATION_STATEMENT)

        locked_plan = (build_plan_fn or build_reset_plan)(
            connection,
            plan.sample_email,
            storage_object_keys=final_storage_keys,
            provider_account_ids=plan.provider_account_ids,
        )
        if locked_plan.impact_digest != plan.impact_digest:
            raise ResetError("The reset plan changed; run a fresh dry run and confirmation")

        _execute(
            connection,
            """UPDATE public.workspace_profiles SET display_name = 'OpenSlate',
               legal_name = NULL, description = NULL, contact_email = NULL,
               contact_phone = NULL, postal_address = NULL,
               logo_file_id = NULL, timezone = 'UTC', locale = 'en-US',
               invitation_expiry_days = 7, guest_duration_days = 30, revision = 1,
               performed_by = NULL WHERE id = %s""",
            (locked_plan.workspace_snapshot.id,),
        )
        # Modules point at their title field while fields point back to the
        # owning module. Break the restrictive title reference before deleting
        # fields, then the module/field rows can be removed in dependency order.
        _execute(
            connection,
            "UPDATE public.modules SET title_field_id = NULL WHERE title_field_id IS NOT NULL",
        )
        for table_name in DELETE_ORDER:
            _execute(connection, f"DELETE FROM public.{table_name}")
        _reset_sandbox_workspace(connection)
        _reset_company_board(connection)
        _execute(
            connection,
            "DELETE FROM public.users WHERE role = 'guest' AND id <> %s",
            (locked_plan.preserved_admin_id,),
        )
        _execute(
            connection,
            "DELETE FROM public.users WHERE id <> %s",
            (locked_plan.preserved_admin_id,),
        )
        _validate_postconditions(
            connection,
            locked_plan,
            read_profile_fn=read_profile_fn,
        )
        sql_commit_started = True
        connection.commit()
        committed = True
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
    except ResetError:
        _rollback_safely(connection)
        if sql_commit_started and not committed:
            raise ResetError(
                "Provider cleanup finished but the database commit outcome is uncertain; "
                "inspect the installation before retrying"
            ) from None
        if provider_cleanup_completed and not committed:
            raise ResetError(
                "Provider accounts were deleted but application profiles were retained; "
                "run a fresh dry run before retrying"
            ) from None
        raise
    except Exception:
        _rollback_safely(connection)
        if sql_commit_started and not committed:
            raise ResetError(
                "Provider cleanup finished but the database commit outcome is uncertain; "
                "inspect the installation before retrying"
            ) from None
        if provider_cleanup_started and not committed:
            raise ResetError(
                "Provider accounts may have been deleted but application profiles were retained; "
                "run a fresh dry run before retrying"
            ) from None
        raise ResetError("Unable to apply application-data reset") from None
    finally:
        if scanner_lock_held or reset_lock_held:
            _rollback_safely(connection)
            try:
                if scanner_lock_held:
                    _execute(
                        connection, "SELECT pg_advisory_unlock(%s)", (_SCANNER_LEADER_LOCK_KEY,)
                    )
                if reset_lock_held:
                    _execute(
                        connection, "SELECT pg_advisory_unlock(%s)", (_RESET_ADVISORY_LOCK_KEY,)
                    )
                connection.commit()
            except Exception:
                _rollback_safely(connection)
