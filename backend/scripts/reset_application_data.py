"""Safely reset local OpenSlate application data while preserving Auth state."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from psycopg import connect

if __package__:
    from .reset_execution import (  # type: ignore[import-not-found]
        _validate_postconditions as _execution_validate_postconditions,
    )
    from .reset_execution import (
        apply_reset as _execute_reset,
    )
    from .reset_models import (  # type: ignore[import-not-found]
        _LOCK_APPLICATION_STATEMENT,
        _LOCK_AUTH_STATEMENT,
        _RESET_ADVISORY_LOCK_KEY,
        APPLICATION_TABLES,
        DELETE_ORDER,
        NON_PRESERVED_TABLES,
        ResetError,
        ResetPlan,
    )
    from .reset_planning import (  # type: ignore[import-not-found]
        _read_alembic_head,
        _read_auth_users,
        _read_counts,
        _read_profile,
        _read_roles,
        parse_supabase_status_database_url,
        read_supabase_status_database_url,
        required_environment,
        validate_local_database_url,
        validate_local_project,
    )
    from .reset_planning import (
        _validated_database_url as _psycopg_database_url,
    )
    from .reset_planning import (
        build_reset_plan as _build_reset_plan,
    )
else:
    from reset_execution import (
        _validate_postconditions as _execution_validate_postconditions,
    )
    from reset_execution import (
        apply_reset as _execute_reset,
    )
    from reset_models import (
        _LOCK_APPLICATION_STATEMENT,
        _LOCK_AUTH_STATEMENT,
        _RESET_ADVISORY_LOCK_KEY,
        APPLICATION_TABLES,
        DELETE_ORDER,
        NON_PRESERVED_TABLES,
        ResetError,
        ResetPlan,
    )
    from reset_planning import (
        _read_alembic_head,
        _read_auth_users,
        _read_counts,
        _read_profile,
        _read_roles,
        parse_supabase_status_database_url,
        read_supabase_status_database_url,
        required_environment,
        validate_local_database_url,
        validate_local_project,
    )
    from reset_planning import (
        _validated_database_url as _psycopg_database_url,
    )
    from reset_planning import (
        build_reset_plan as _build_reset_plan,
    )


__all__ = (
    "APPLICATION_TABLES",
    "DELETE_ORDER",
    "NON_PRESERVED_TABLES",
    "ResetError",
    "ResetPlan",
    "_LOCK_APPLICATION_STATEMENT",
    "_LOCK_AUTH_STATEMENT",
    "_RESET_ADVISORY_LOCK_KEY",
    "_parser",
    "_print_plan",
    "_psycopg_database_url",
    "_read_alembic_head",
    "_read_auth_users",
    "_read_counts",
    "_read_profile",
    "_read_roles",
    "_validate_postconditions",
    "apply_reset",
    "build_reset_plan",
    "main",
    "parse_supabase_status_database_url",
    "read_supabase_status_database_url",
    "required_environment",
    "validate_local_database_url",
    "validate_local_project",
)


def build_reset_plan(connection: Any, sample_email: str) -> ResetPlan:
    return _build_reset_plan(
        connection,
        sample_email,
        read_profile_fn=_read_profile,
        read_roles_fn=_read_roles,
    )


def _validate_postconditions(connection: Any, plan: ResetPlan) -> None:
    _execution_validate_postconditions(
        connection,
        plan,
        read_profile_fn=_read_profile,
        read_roles_fn=_read_roles,
    )


def apply_reset(
    connection: Any,
    plan: ResetPlan,
    *,
    execute: bool = False,
    stdin_is_tty: bool = False,
    confirmation: str | None = None,
) -> None:
    _execute_reset(
        connection,
        plan,
        execute=execute,
        stdin_is_tty=stdin_is_tty,
        confirmation=confirmation,
        read_profile_fn=_read_profile,
        read_roles_fn=_read_roles,
        build_plan_fn=build_reset_plan,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="execute the displayed local reset plan after an interactive digest confirmation",
    )
    return parser


def _print_plan(plan: ResetPlan) -> None:
    print("Dry run: no application data was changed.")
    print("target=local Supabase PostgreSQL (127.0.0.1:54322/postgres)")
    print(f"admin_email={plan.sample_email}")
    print(f"admin_id={plan.preserved_admin_id}")
    print(f"auth_user_count={plan.auth_user_count}")
    print(f"profiles_to_delete={plan.profiles_to_delete}")
    print(f"inactive_admin_profiles_to_delete={plan.inactive_admin_profiles_to_delete}")
    print("counts:")
    for table_name in APPLICATION_TABLES:
        print(f"  {table_name}={plan.counts[table_name]}")
    print(f"impact_digest={plan.impact_digest}")
    print("To execute, use --execute and enter this impact digest exactly when prompted.")


def main(argv: Sequence[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    connection: Any = None
    try:
        migration_url, sample_email = required_environment(os.environ)
        root = Path(__file__).resolve().parents[2]
        validate_local_database_url(migration_url)
        validate_local_project(root)
        status_url = read_supabase_status_database_url()
        validate_local_database_url(migration_url, expected_url=status_url)

        connection = connect(_psycopg_database_url(migration_url))
        plan = build_reset_plan(connection, sample_email)
        _print_plan(plan)

        if args.execute:
            if not sys.stdin.isatty():
                raise ResetError("Execute mode requires a TTY")
            confirmation = input("Enter the impact digest exactly as shown to execute: ")
            apply_reset(
                connection,
                plan,
                execute=True,
                stdin_is_tty=True,
                confirmation=confirmation,
            )
            print("Application data reset completed; Auth identities were preserved.")
    except SystemExit:
        raise
    except ResetError as error:
        raise SystemExit(str(error)) from None
    except Exception:
        raise SystemExit("Unable to reset application data") from None
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
