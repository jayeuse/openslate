"""Execute one confirmed sample-organization removal and prove the other organizations stayed."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any

from psycopg import sql

from operations.reset.backups import require_no_unresolved_backup
from operations.reset.models import _RESET_ADVISORY_LOCK_KEY, DELETE_ORDER, ResetError
from operations.reset.organization import (
    NULL_ORGANIZATION_DELETIONS,
    AuthAccount,
    OrganizationRemovalPlan,
    UserReferences,
    build_organization_removal_plan,
    read_census,
    read_operator,
    read_user_references,
    rows,
    user_match,
)
from operations.reset.planning import _read_alembic_head

# One DELETE per table runs without a table lock while the API is stopped. A Large pack's
# records, audit history and the account delete (each account clears roughly 90 unindexed
# performed_by references in the other organizations) take far longer than the full reset's
# 30 s on an emptied database; 300 s still bounds a hung statement.
_STATEMENT_TIMEOUT = "300s"
_PLAN_CHANGED = "The removal plan changed; run a fresh dry run and confirmation"

PlanBuilder = Callable[..., OrganizationRemovalPlan]


def _execute(connection: Any, statement: str | sql.Composable, params: Any = None) -> None:
    with connection.cursor() as cursor:
        cursor.execute(statement, params)


@contextmanager
def _timed(timings: dict[str, float], name: str) -> Iterator[None]:
    started = time.perf_counter()
    try:
        yield
    finally:
        timings[name] = round(time.perf_counter() - started, 3)


def _rollback_safely(connection: Any) -> None:
    try:
        connection.rollback()
    except Exception:
        pass


def _replan(
    connection: Any,
    plan: OrganizationRemovalPlan,
    build_plan: PlanBuilder,
    accounts: Sequence[AuthAccount],
    keys: tuple[str, ...],
) -> OrganizationRemovalPlan:
    def listed(prefixes: tuple[str, ...]) -> tuple[str, ...]:
        if prefixes != plan.storage_prefixes:
            raise ResetError(_PLAN_CHANGED)
        return keys

    return build_plan(
        connection,
        slugs=plan.slugs,
        operator_email=plan.operator_email,
        domains=plan.domains,
        auth_accounts=accounts,
        list_storage_keys=listed,
    )


def _delete_rows(
    connection: Any,
    plan: OrganizationRemovalPlan,
    references: UserReferences,
    timings: dict[str, float],
) -> None:
    params = {"orgs": list(plan.organization_ids), "users": list(plan.removable_user_ids)}
    # The logo and title-field references point back into rows deleted later; clear them
    # for the removed organizations only.
    _execute(
        connection,
        "UPDATE public.organizations SET logo_file_id = NULL "
        "WHERE id = ANY(%(orgs)s) AND logo_file_id IS NOT NULL",
        params,
    )
    _execute(
        connection,
        "UPDATE public.modules SET title_field_id = NULL "
        "WHERE org_id = ANY(%(orgs)s) AND title_field_id IS NOT NULL",
        params,
    )
    for table in DELETE_ORDER:
        if table in references.organization_tables:
            with _timed(timings, f"delete_{table}"):
                _execute(
                    connection,
                    sql.SQL("DELETE FROM {} WHERE org_id = ANY(%(orgs)s)").format(
                        sql.Identifier("public", table)
                    ),
                    params,
                )
    for table in NULL_ORGANIZATION_DELETIONS if plan.removable_user_ids else ():
        _execute(
            connection,
            sql.SQL("DELETE FROM {} WHERE org_id IS NULL AND ({})").format(
                sql.Identifier("public", table), user_match(references.restricting[table])
            ),
            params,
        )
    if plan.removable_user_ids:
        with _timed(timings, "delete_users"):
            _execute(connection, "DELETE FROM public.users WHERE id = ANY(%(users)s)", params)
    _execute(connection, "DELETE FROM public.organizations WHERE id = ANY(%(orgs)s)", params)


def _expected_retained(plan: OrganizationRemovalPlan) -> dict[str, dict[str, int]]:
    expected: dict[str, dict[str, int]] = {}
    for table, counts in plan.retained.items():
        kept = dict(counts)
        if "null" in kept:
            kept["null"] -= plan.null_organization_deletions.get(table, 0)
            if kept["null"] == 0:
                del kept["null"]
        expected[table] = kept
    return expected


def _validate_postconditions(
    connection: Any, plan: OrganizationRemovalPlan, references: UserReferences
) -> None:
    after = read_census(connection, plan.organization_ids, plan.removable_user_ids, references)
    if any(after.target_counts.values()):
        raise ResetError("A row of a removed organization remained")
    if {table: dict(counts) for table, counts in after.retained.items()} != _expected_retained(
        plan
    ):
        raise ResetError("Another organization's rows changed during the removal")
    remaining = (
        rows(
            connection,
            "SELECT count(*) FROM public.users WHERE id = ANY(%(users)s)",
            {"users": list(plan.removable_user_ids)},
        )
        if plan.removable_user_ids
        else [(0,)]
    )
    if remaining != [(0,)]:
        raise ResetError("A removed account remained")
    if read_operator(connection, plan.operator_email) != (
        plan.operator_id,
        plan.operator_provider_id,
    ):
        raise ResetError("The installation operator changed")
    if _read_alembic_head(connection) != plan.alembic_head:
        raise ResetError("The database migration head changed")


def apply_organization_removal(
    connection: Any,
    plan: OrganizationRemovalPlan,
    *,
    confirmation: str | None,
    auth: Any,
    storage: Any,
    list_auth_accounts: Callable[[], Sequence[AuthAccount]],
    build_plan: PlanBuilder = build_organization_removal_plan,
) -> Mapping[str, float]:
    """Remove the confirmed organizations; return each phase's duration in seconds."""
    if confirmation != plan.impact_digest:
        raise ResetError("An exact impact-digest confirmation is required")
    timings: dict[str, float] = {}
    lock_held = provider_started = provider_done = commit_started = committed = False
    try:
        connection.rollback()
        lock_held = rows(
            connection, "SELECT pg_try_advisory_lock(%(key)s)", {"key": _RESET_ADVISORY_LOCK_KEY}
        ) == [(True,)]
        if not lock_held:
            raise ResetError("Another application reset or removal is running")
        require_no_unresolved_backup(connection, plan.installation_id)
        connection.commit()
        with _timed(timings, "preflight_plan"):
            keys = tuple(storage.list_prefixed_keys(plan.storage_prefixes))
            fresh = _replan(connection, plan, build_plan, list_auth_accounts(), keys)
            connection.commit()
        if fresh.impact_digest != plan.impact_digest:
            raise ResetError(_PLAN_CHANGED)
        with _timed(timings, "storage_inventory"):
            final_keys = tuple(storage.list_prefixed_keys(plan.storage_prefixes))

        _execute(connection, "SET LOCAL lock_timeout = '5s'")
        _execute(connection, f"SET LOCAL statement_timeout = '{_STATEMENT_TIMEOUT}'")
        require_no_unresolved_backup(connection, plan.installation_id)
        with _timed(timings, "transaction_plan"):
            locked = _replan(connection, plan, build_plan, list_auth_accounts(), final_keys)
        if locked.impact_digest != plan.impact_digest:
            raise ResetError(_PLAN_CHANGED)
        references = read_user_references(connection)
        with _timed(timings, "row_deletes"):
            _delete_rows(connection, locked, references, timings)
        with _timed(timings, "postconditions"):
            _validate_postconditions(connection, locked, references)
        # Auth goes last inside the open transaction: a failed or slow row delete rolls back
        # with every provider account intact, and a failed Auth cleanup rolls the rows back,
        # so the kept profiles let a fresh dry run finish the job.
        auth.require_present(plan.operator_provider_id)
        provider_started = True
        with _timed(timings, "auth_cleanup"):
            try:
                auth.delete_and_verify_missing(plan.provider_account_ids)
            except Exception:
                raise ResetError(
                    "Provider account cleanup is incomplete; the organizations were retained; "
                    "run a fresh dry run before retrying"
                ) from None
        provider_done = True
        commit_started = True
        with _timed(timings, "commit"):
            connection.commit()
        committed = True
        with _timed(timings, "storage_cleanup"):
            try:
                storage.delete_prefixed_and_verify_empty(final_keys, plan.storage_prefixes)
            except Exception:
                try:
                    remaining = str(len(storage.list_prefixed_keys(plan.storage_prefixes)))
                except Exception:
                    remaining = "unknown"
                raise ResetError(
                    "The organizations were removed but private storage cleanup is incomplete "
                    f"({remaining} private files remain under "
                    f"{', '.join(plan.storage_prefixes)})"
                ) from None
        return timings
    except ResetError:
        _rollback_safely(connection)
        if commit_started and not committed:
            raise ResetError(
                "Provider cleanup finished but the database commit outcome is uncertain; "
                "inspect the installation before retrying"
            ) from None
        if provider_done and not committed:
            raise ResetError(
                "Provider accounts were deleted but the organizations were retained; "
                "run a fresh dry run before retrying"
            ) from None
        raise
    except Exception as error:
        _rollback_safely(connection)
        if commit_started and not committed:
            message = (
                "Provider cleanup finished but the database commit outcome is uncertain; "
                "inspect the installation before retrying"
            )
        elif provider_started and not committed:
            message = (
                "Provider accounts may have been deleted but the organizations were retained; "
                "run a fresh dry run before retrying"
            )
        else:
            message = "Unable to remove the organizations"
        refusal = ResetError(message)
        # The cause stays hidden (it may carry provider details); its type does not.
        refusal.add_note(f"Cause: {type(error).__name__}")
        raise refusal from None
    finally:
        if lock_held:
            _rollback_safely(connection)
            try:
                _execute(
                    connection,
                    "SELECT pg_advisory_unlock(%(key)s)",
                    {"key": _RESET_ADVISORY_LOCK_KEY},
                )
                connection.commit()
            except Exception:
                _rollback_safely(connection)
