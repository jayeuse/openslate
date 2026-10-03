"""Safely reset local OpenSlate application data while preserving one administrator."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping, Sequence
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from psycopg import connect

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config.environment import environment_inputs
from app.core.config.instance import (
    InstanceTargetError,
    assert_psycopg_target,
    instance_target_for_process,
)
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from operations.reset_auth import ResetAuth
from operations.reset_execution import (
    _validate_postconditions as _execution_validate_postconditions,
)
from operations.reset_execution import apply_reset as _execute_reset
from operations.reset_models import (
    _LOCK_APPLICATION_STATEMENT,
    _RESET_ADVISORY_LOCK_KEY,
    APPLICATION_TABLES,
    DELETE_ORDER,
    NON_PRESERVED_TABLES,
    ResetError,
    ResetPlan,
)
from operations.reset_planning import (
    _read_alembic_head,
    _read_profile,
    required_environment,
    validate_local_database_url,
)
from operations.reset_planning import (
    _validated_database_url as _psycopg_database_url,
)
from operations.reset_planning import (
    build_reset_plan as _build_reset_plan,
)
from operations.reset_storage import ResetStorage, require_api_stopped

__all__ = (
    "APPLICATION_TABLES",
    "DELETE_ORDER",
    "NON_PRESERVED_TABLES",
    "ResetError",
    "ResetPlan",
    "_LOCK_APPLICATION_STATEMENT",
    "_RESET_ADVISORY_LOCK_KEY",
    "_parser",
    "_print_plan",
    "_psycopg_database_url",
    "_read_alembic_head",
    "_read_profile",
    "ResetStorage",
    "_validate_postconditions",
    "apply_reset",
    "build_reset_plan",
    "main",
    "require_api_stopped",
    "required_environment",
    "required_storage_environment",
    "validate_local_database_url",
)


def required_storage_environment(mapping: Mapping[str, str]) -> tuple[str, str, float, str, str]:
    """Return the guarded provider endpoint and API bind target."""
    values: list[str] = []
    for name in ("SUPABASE_URL", "SUPABASE_SECRET_KEY", "BACKEND_BIND_HOST", "BACKEND_PORT"):
        value = mapping.get(name, "")
        if not isinstance(value, str) or not value.strip():
            raise ResetError(f"{name} is required")
        values.append(value.strip())
    try:
        timeout = float(mapping.get("SUPABASE_TIMEOUT_SECONDS", "10"))
    except (TypeError, ValueError):
        raise ResetError("SUPABASE_TIMEOUT_SECONDS is invalid") from None
    return values[0], values[1], timeout, values[2], values[3]


def build_reset_plan(
    connection: Any,
    sample_email: str,
    *,
    storage_object_keys: tuple[str, ...] = (),
    provider_account_ids: tuple[UUID, ...] | None = None,
) -> ResetPlan:
    return _build_reset_plan(
        connection,
        sample_email,
        storage_object_keys=storage_object_keys,
        provider_account_ids=provider_account_ids,
        read_profile_fn=_read_profile,
    )


def _validate_postconditions(connection: Any, plan: ResetPlan) -> None:
    _execution_validate_postconditions(
        connection,
        plan,
        read_profile_fn=_read_profile,
    )


def _require_development_confirmation(values: Mapping[str, str]) -> None:
    if values.get("ENVIRONMENT", "").strip().casefold() != "development":
        raise ResetError("Noninteractive reset is available only with ENVIRONMENT=development")
    for name in ("MIGRATION_DATABASE_URL", "SUPABASE_URL"):
        try:
            host = urlsplit(values.get(name, "")).hostname
            if host != "localhost" and (host is None or not ip_address(host).is_loopback):
                raise ValueError
        except ValueError:
            raise ResetError(
                "Noninteractive reset requires loopback database and Auth URLs"
            ) from None


def apply_reset(
    connection: Any,
    plan: ResetPlan,
    *,
    execute: bool = False,
    stdin_is_tty: bool = False,
    confirmation: str | None = None,
    storage: Any | None = None,
    auth: Any | None = None,
    backend_host: str | None = None,
    backend_port: str | None = None,
    noninteractive_environment: Mapping[str, str] | None = None,
) -> None:
    if noninteractive_environment is not None:
        if not execute:
            raise ResetError("Noninteractive confirmation requires --execute")
        _require_development_confirmation(noninteractive_environment)
    if (
        execute
        and (stdin_is_tty or noninteractive_environment is not None)
        and confirmation == plan.impact_digest
    ):
        if backend_host is None or backend_port is None:
            raise ResetError("BACKEND_BIND_HOST and BACKEND_PORT are required for execute mode")
        require_api_stopped(backend_host, backend_port)
    _execute_reset(
        connection,
        plan,
        execute=execute,
        stdin_is_tty=stdin_is_tty,
        noninteractive_development=noninteractive_environment is not None,
        confirmation=confirmation,
        storage=storage,
        auth=auth,
        read_profile_fn=_read_profile,
        build_plan_fn=build_reset_plan,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute", action="store_true", help="execute the displayed local reset plan"
    )
    parser.add_argument(
        "--confirm-digest",
        metavar="DIGEST",
        help="confirm a fresh preview digest without a TTY in local development only",
    )
    return parser


def _print_plan(plan: ResetPlan) -> None:
    print("Dry run: no application data was changed.")
    print("target=guarded local OpenSlate PostgreSQL, Supabase Auth and Storage")
    print(f"admin_email={plan.sample_email}")
    print(f"admin_id={plan.preserved_admin_id}")
    print(f"profiles_to_delete={plan.profiles_to_delete}")
    print(f"inactive_admin_profiles_to_delete={plan.inactive_admin_profiles_to_delete}")
    print(f"provider_accounts_to_delete={len(plan.provider_account_ids)}")
    linked_ids = {
        provider_id for _, provider_id in plan.provider_subjects if provider_id is not None
    }
    orphan_count = len(set(plan.provider_account_ids) - linked_ids)
    print(f"unlinked_provider_accounts_to_delete={orphan_count}")
    print(f"private_storage_objects_to_delete={len(plan.storage_object_keys)}")
    print("counts:")
    for table_name in APPLICATION_TABLES:
        print(f"  {table_name}={plan.counts[table_name]}")
    print(f"impact_digest={plan.impact_digest}")
    print("To execute, use --execute and enter this impact digest exactly when prompted.")
    print("Development only: use --execute --confirm-digest <impact_digest> without a TTY.")


def main(argv: Sequence[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    connection: Any = None
    try:
        if args.confirm_digest is not None and not args.execute:
            raise ResetError("--confirm-digest requires --execute")
        values = environment_inputs(DOTENV_PATH)
        if args.confirm_digest is not None:
            _require_development_confirmation(values)
        environment = values.get("ENVIRONMENT", "").strip().casefold()
        if environment not in {"development", "dev", "local", "test"}:
            raise ResetError(
                "Application data reset is available only for local development or disposable tests"
            )
        migration_url, admin_email = required_environment(values)
        provider_url, secret_key, timeout, backend_host, backend_port = (
            required_storage_environment(values)
        )
        target = instance_target_for_process(migration_url, "openslate_owner")
        runner_manifest_authorized = target is None
        validate_local_database_url(
            migration_url, target, runner_manifest_authorized=runner_manifest_authorized
        )
        assert_provider_instance(
            values, database_url=migration_url, expected_user="openslate_owner"
        )
        connection = connect(
            _psycopg_database_url(
                migration_url,
                target,
                runner_manifest_authorized=runner_manifest_authorized,
            )
        )
        if target is not None:
            assert_psycopg_target(connection, target, expected_user="openslate_owner")
        storage = ResetStorage(provider_url, secret_key, timeout)
        auth = ResetAuth(provider_url, secret_key, timeout)
        storage_keys = storage.list_object_keys()
        local_plan = build_reset_plan(connection, admin_email, storage_object_keys=storage_keys)
        provider_account_ids = auth.list_account_ids(
            local_plan.preserved_admin_provider_id, local_plan.sample_email
        )
        plan = build_reset_plan(
            connection,
            admin_email,
            storage_object_keys=storage_keys,
            provider_account_ids=provider_account_ids,
        )
        connection.rollback()
        _print_plan(plan)
        if args.execute:
            stdin_is_tty = sys.stdin.isatty()
            if args.confirm_digest is None:
                if not stdin_is_tty:
                    raise ResetError("Execute mode requires a TTY")
                confirmation = input("Enter the impact digest exactly as shown to execute: ")
            else:
                confirmation = args.confirm_digest
            apply_reset(
                connection,
                plan,
                execute=True,
                stdin_is_tty=stdin_is_tty,
                confirmation=confirmation,
                storage=storage,
                auth=auth,
                backend_host=backend_host,
                backend_port=backend_port,
                noninteractive_environment=values if args.confirm_digest is not None else None,
            )
            print(
                "Application data reset completed; the administrator account was preserved "
                "and local sessions were revoked. Sign in again."
            )
    except SystemExit:
        raise
    except ResetError as error:
        raise SystemExit(str(error)) from None
    except InstanceTargetError as error:
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
