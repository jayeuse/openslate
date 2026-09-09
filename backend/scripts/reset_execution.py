"""Transactional reset execution and postcondition checks."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

if __package__:
    from .reset_models import (  # type: ignore[import-not-found]
        _COUNT_STATEMENTS,
        _LOCK_APPLICATION_STATEMENT,
        _LOCK_AUTH_STATEMENT,
        _RESET_ADVISORY_LOCK_KEY,
        NON_PRESERVED_TABLES,
        ResetError,
        ResetPlan,
    )
    from .reset_planning import (  # type: ignore[import-not-found]
        _execute,
        _expected_snapshot_payload,
        _read_alembic_head,
        _read_auth_users,
        _read_profile,
        _read_roles,
        _single_value,
        _snapshot_payload,
        build_reset_plan,
    )
else:
    from reset_models import (
        _COUNT_STATEMENTS,
        _LOCK_APPLICATION_STATEMENT,
        _LOCK_AUTH_STATEMENT,
        _RESET_ADVISORY_LOCK_KEY,
        NON_PRESERVED_TABLES,
        ResetError,
        ResetPlan,
    )
    from reset_planning import (
        _execute,
        _expected_snapshot_payload,
        _read_alembic_head,
        _read_auth_users,
        _read_profile,
        _read_roles,
        _single_value,
        _snapshot_payload,
        build_reset_plan,
    )


def _begin_transaction(connection: Any) -> None:
    info = getattr(connection, "info", None)
    status = getattr(info, "transaction_status", None)
    if status is not None and getattr(status, "name", str(status)) != "IDLE":
        return
    connection.execute("BEGIN")


def _rollback_safely(connection: Any) -> None:
    try:
        connection.rollback()
    except Exception:
        pass


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

    profile = read_profile(connection, plan.preserved_admin_id)
    if (
        _snapshot_payload(profile)
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
    if _snapshot_payload(role_by_id[plan.preserved_admin_role_id]) != _expected_snapshot_payload(
        plan.admin_role_snapshot, plan.preserved_admin_id
    ) or _snapshot_payload(role_by_id[plan.preserved_member_role_id]) != _expected_snapshot_payload(
        plan.member_role_snapshot, plan.preserved_admin_id
    ):
        raise ResetError("The preserved roles changed")

    auth_count, auth_identities = _read_auth_users(connection)
    if auth_count != plan.auth_user_count or auth_identities != plan.auth_identities:
        raise ResetError("The Auth identities changed")

    if _read_alembic_head(connection) != plan.alembic_head:
        raise ResetError("The database migration head changed")


def apply_reset(
    connection: Any,
    plan: ResetPlan,
    *,
    execute: bool = False,
    stdin_is_tty: bool = False,
    confirmation: str | None = None,
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

    try:
        _begin_transaction(connection)
        _execute(connection, "SET LOCAL lock_timeout = '5s'")
        _execute(connection, "SET LOCAL statement_timeout = '30s'")
        _execute(connection, "SELECT pg_advisory_xact_lock(%s)", (_RESET_ADVISORY_LOCK_KEY,))
        _execute(connection, _LOCK_AUTH_STATEMENT)
        _execute(connection, _LOCK_APPLICATION_STATEMENT)

        locked_plan = (build_plan_fn or build_reset_plan)(connection, plan.sample_email)
        if locked_plan.impact_digest != plan.impact_digest:
            raise ResetError("The reset plan changed; run a fresh dry run and confirmation")

        _execute(connection, "DELETE FROM public.lifecycle_confirmation_challenges")
        _execute(connection, "DELETE FROM public.lifecycle_rate_limit_failures")
        _execute(connection, "DELETE FROM public.lifecycle_rate_limit_buckets")
        _execute(connection, "DELETE FROM public.relationship_edges")
        _execute(connection, "DELETE FROM public.audit_logs")
        _execute(connection, "DELETE FROM public.security_events")
        _execute(connection, "DELETE FROM public.records")
        _execute(connection, "DELETE FROM public.fields")
        _execute(connection, "DELETE FROM public.modules")
        _execute(connection, "DELETE FROM public.departments")
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
    except ResetError:
        _rollback_safely(connection)
        raise
    except Exception:
        _rollback_safely(connection)
        raise ResetError("Unable to apply application-data reset") from None
