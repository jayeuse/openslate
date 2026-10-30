"""``seed_sample_data.py remove``: remove one pack's organization pair from the local install.

The dry run prints the plan and its digest. ``--execute`` asks for the digest on a TTY;
``--execute --confirm-digest <digest>`` runs without one in local development only.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from psycopg import connect

from app.core.config.instance import assert_psycopg_target
from operations.reset.auth import _ACCOUNT_PAGE_SIZE, _MAX_ACCOUNT_PAGES, ResetAuth
from operations.reset.models import ResetError
from operations.reset.organization import (
    AuthAccount,
    OrganizationRemovalPlan,
    build_organization_removal_plan,
)
from operations.reset.organization_execution import apply_organization_removal
from operations.reset.planning import _validated_database_url, required_environment
from operations.reset.storage import ResetStorage, require_api_stopped
from operations.reset_application_data import (
    _require_development_confirmation,
    required_storage_environment,
)
from operations.sample.organization import pack_email_domains, sample_slug, testing_domain
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import pack_keys


def add_remove_command(commands: Any) -> None:
    remove = commands.add_parser("remove", help="remove one pack's organization pair")
    remove.add_argument("--organization", choices=pack_keys(), required=True)
    remove.add_argument("--execute", action="store_true", help="execute the displayed plan")
    remove.add_argument("--confirm-digest", metavar="DIGEST", help="development only, no TTY")


def removal_domains(pack: OrganizationPack) -> frozenset[str]:
    """The pack's people and guests, and its testing accounts (``<pack>.test``)."""
    return pack_email_domains(pack) | {testing_domain(pack)}


def list_domain_accounts(auth: ResetAuth, domains: frozenset[str]) -> tuple[AuthAccount, ...]:
    """List the provider Auth accounts whose email is in one of the pack's domains."""
    accounts: dict[UUID, AuthAccount] = {}
    for page in range(1, _MAX_ACCOUNT_PAGES + 1):
        status, body = auth._request(
            "GET", None, params={"page": str(page), "per_page": str(_ACCOUNT_PAGE_SIZE)}
        )
        if status != 200:
            raise ResetError("The provider Auth inventory is unavailable")
        try:
            users = json.loads(body)["users"]
            if not isinstance(users, list) or len(users) > _ACCOUNT_PAGE_SIZE:
                raise ValueError
            for user in users:
                user_id, email = UUID(user["id"]), str(user["email"]).strip().casefold()
                if user_id in accounts:
                    raise ValueError
                if email.rpartition("@")[2] not in domains:
                    continue
                metadata = user.get("app_metadata") or {}
                owner = metadata.get("openslate_user_id") if isinstance(metadata, dict) else None
                accounts[user_id] = AuthAccount(user_id, email, UUID(owner) if owner else None)
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ResetError("The provider Auth inventory is invalid") from None
        if len(users) < _ACCOUNT_PAGE_SIZE:
            return tuple(sorted(accounts.values(), key=lambda account: str(account.id)))
    raise ResetError("The provider Auth inventory is incomplete")


def _print_plan(plan: OrganizationRemovalPlan) -> None:
    print("Dry run: no application data was changed.")
    print(f"organizations_to_remove={','.join(plan.slugs)}")
    print(f"organization_ids={','.join(str(value) for value in plan.organization_ids)}")
    print(f"profiles_to_delete={len(plan.removable_user_ids)}")
    print(f"profiles_kept_without_these_memberships={len(plan.kept_member_ids)}")
    print(f"provider_accounts_to_delete={len(plan.provider_account_ids)}")
    print(f"private_storage_objects_to_delete={len(plan.storage_object_keys)}")
    for table, count in sorted(plan.null_organization_deletions.items()):
        print(f"account_{table}_without_organization_to_delete={count}")
    others = {org for counts in plan.retained.values() for org in counts if org != "null"}
    print(f"other_organizations_kept={len(others)}")
    print("counts:")
    for table, count in sorted(plan.target_counts.items()):
        if count:
            print(f"  {table}={count}")
    print(f"impact_digest={plan.impact_digest}")


def remove_sample_pack(
    pack: OrganizationPack, args: argparse.Namespace, values: Mapping[str, str], target: Any
) -> int:
    """Plan, and with ``--execute`` apply, the removal of the pack's organization pair."""
    if args.confirm_digest is not None and not args.execute:
        raise ResetError("--confirm-digest requires --execute")
    migration_url, admin_email = required_environment(values)
    provider_url, secret_key, timeout, backend_host, backend_port = required_storage_environment(
        values
    )
    storage = ResetStorage(provider_url, secret_key, timeout)
    auth = ResetAuth(provider_url, secret_key, timeout)
    domains = removal_domains(pack)
    with connect(_validated_database_url(migration_url, target)) as connection:
        assert_psycopg_target(connection, target, expected_user="openslate_owner")
        plan = build_organization_removal_plan(
            connection,
            slugs=(sample_slug(pack.identity.key), sample_slug(pack.identity.key, partner=True)),
            operator_email=admin_email,
            domains=domains,
            auth_accounts=list_domain_accounts(auth, domains),
            list_storage_keys=storage.list_prefixed_keys,
        )
        connection.rollback()
        _print_plan(plan)
        if not args.execute:
            print("To execute, use --execute and enter this impact digest exactly when prompted.")
            return 0
        if args.confirm_digest is None:
            if not sys.stdin.isatty():
                raise ResetError("Execute mode requires a TTY")
            confirmation = input("Enter the impact digest exactly as shown to execute: ")
        else:
            _require_development_confirmation(values)
            confirmation = args.confirm_digest
        require_api_stopped(backend_host, backend_port)
        timings = apply_organization_removal(
            connection,
            plan,
            confirmation=confirmation,
            auth=auth,
            storage=storage,
            list_auth_accounts=lambda: list_domain_accounts(auth, domains),
        )
    tables = sorted(
        (name for name in timings if name.startswith("delete_")), key=lambda name: timings[name]
    )
    for phase, seconds in timings.items():
        # Every phase, but only the five slowest single-table deletes.
        if not phase.startswith("delete_") or phase in tables[-5:]:
            print(f"seconds_{phase}={seconds}")
    print("Removed the pack's organizations; every other organization and the operator were kept.")
    return 0
