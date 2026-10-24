"""Transactional reset execution and postcondition checks."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from operations.reset.backups import (
    delete_unclaimed_backup_queue,
    require_no_unresolved_backup,
    validate_backup_preservation,
)
from operations.reset.models import (
    _COUNT_STATEMENTS,
    _LOCK_APPLICATION_STATEMENT,
    _RESET_ADVISORY_LOCK_KEY,
    DELETE_ORDER,
    NON_PRESERVED_TABLES,
    ResetError,
    ResetPlan,
    stable_snapshot_payload,
)
from operations.reset.planning import (
    _expected_snapshot_payload,
    _read_alembic_head,
    _read_operator,
    _read_profile,
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


def _delete_application_rows(connection: Any) -> None:
    """Delete every organization and all of its rows; nothing is recreated."""
    # An organization's logo and a module's title field are restrictive references
    # back into rows deleted later, so clear them before the dependency-ordered deletes.
    _execute(
        connection,
        "UPDATE public.organizations SET logo_file_id = NULL WHERE logo_file_id IS NOT NULL",
    )
    _execute(
        connection,
        "UPDATE public.modules SET title_field_id = NULL WHERE title_field_id IS NOT NULL",
    )
    for table_name in DELETE_ORDER:
        _execute(connection, f"DELETE FROM public.{table_name}")


def _validate_postconditions(
    connection: Any,
    plan: ResetPlan,
    *,
    read_profile_fn: Callable[..., Any] | None = None,
) -> None:
    read_profile = read_profile_fn or _read_profile
    count_statements = dict(_COUNT_STATEMENTS)
    if _single_value(connection, count_statements["organizations"]) != 0:
        raise ResetError("An organization remained after the reset")
    for table_name in NON_PRESERVED_TABLES:
        if _single_value(connection, count_statements[table_name]) != 0:
            raise ResetError("The reset postcondition was not met")
    if (
        _single_value(connection, count_statements["users"]) != 1
        or _single_value(connection, count_statements["platform_operators"]) != 1
    ):
        raise ResetError("The reset postcondition was not met")
    if _read_operator(connection, plan.preserved_admin_id) != plan.preserved_operator_id:
        raise ResetError("The preserved installation operator changed")

    profile = read_profile(connection, plan.preserved_admin_id)
    if stable_snapshot_payload(profile) != _expected_snapshot_payload(
        plan.profile_snapshot, plan.preserved_admin_id
    ):
        raise ResetError("The preserved administrator profile changed")

    if _read_alembic_head(connection) != plan.alembic_head:
        raise ResetError("The database migration head changed")
    validate_backup_preservation(connection, plan.backup_snapshot, plan.preserved_admin_id)


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
        require_no_unresolved_backup(connection, plan.backup_snapshot.installation_id)
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
        require_no_unresolved_backup(connection, plan.backup_snapshot.installation_id)

        locked_plan = (build_plan_fn or build_reset_plan)(
            connection,
            plan.sample_email,
            storage_object_keys=final_storage_keys,
            provider_account_ids=plan.provider_account_ids,
        )
        if locked_plan.impact_digest != plan.impact_digest:
            raise ResetError("The reset plan changed; run a fresh dry run and confirmation")

        _delete_application_rows(connection)
        delete_unclaimed_backup_queue(connection, locked_plan.backup_snapshot.installation_id)
        _execute(
            connection,
            "DELETE FROM public.platform_operators WHERE user_id <> %s",
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
    except Exception as error:
        _rollback_safely(connection)
        if sql_commit_started and not committed:
            message = (
                "Provider cleanup finished but the database commit outcome is uncertain; "
                "inspect the installation before retrying"
            )
        elif provider_cleanup_started and not committed:
            message = (
                "Provider accounts may have been deleted but application profiles were retained; "
                "run a fresh dry run before retrying"
            )
        else:
            message = "Unable to apply application-data reset"
        refusal = ResetError(message)
        # The cause stays hidden (it may carry provider details); its type does not.
        refusal.add_note(f"Cause: {type(error).__name__}")
        raise refusal from None
    finally:
        if reset_lock_held:
            _rollback_safely(connection)
            try:
                _execute(connection, "SELECT pg_advisory_unlock(%s)", (_RESET_ADVISORY_LOCK_KEY,))
                connection.commit()
            except Exception:
                _rollback_safely(connection)
