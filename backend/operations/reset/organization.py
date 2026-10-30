"""Plan the removal of one sample pack's organizations, keeping every other organization.

The plan names the organizations, the accounts that belong only to them, their provider
Auth accounts and their private Storage objects, and freezes the row counts of every
other organization so that execution can prove it left them unchanged.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any
from uuid import UUID

from psycopg import sql

from operations.reset.backups import _installation
from operations.reset.models import APPLICATION_TABLES, ResetError
from operations.reset.planning import _as_uuid, _read_alembic_head, _read_public_table_names

# NULL-organization rows that restrict a removed account and go with it: the account's own
# avatar file and its installation notifications. Any other such row refuses the plan.
NULL_ORGANIZATION_DELETIONS = ("files", "in_app_notifications")
_SAMPLE_SLUG = re.compile(r"sample-[a-z0-9]+(?:-[a-z0-9]+)*")
_DOMAIN = re.compile(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+")
_RESTRICT_ACTIONS = frozenset({"a", "r"})  # pg_constraint.confdeltype NO ACTION, RESTRICT

_OPERATOR_STATEMENT = """
SELECT profile.id, profile.supabase_user_id FROM public.users AS profile
 WHERE profile.email = %(email)s AND profile.status = 'active' AND profile.is_deleted = false
   AND EXISTS (SELECT 1 FROM public.platform_operators AS operator
                WHERE operator.user_id = profile.id AND operator.is_deleted = false)
"""
_TARGETS_STATEMENT = "SELECT id FROM public.organizations WHERE slug = ANY(%(slugs)s) ORDER BY id"
# Members of the organizations, plus profiles of the pack's domains with no membership at all.
# A membership row counts even when soft-deleted: it still restricts the account.
_ACCOUNTS_STATEMENT = """
SELECT profile.id, profile.supabase_user_id,
       EXISTS (SELECT 1 FROM public.memberships AS other
                WHERE other.user_id = profile.id AND other.org_id <> ALL(%(orgs)s)),
       EXISTS (SELECT 1 FROM public.platform_operators AS operator
                WHERE operator.user_id = profile.id)
  FROM public.users AS profile
 WHERE profile.id IN (SELECT member.user_id FROM public.memberships AS member
                       WHERE member.org_id = ANY(%(orgs)s))
    OR (lower(regexp_replace(profile.email, '^.*@', '')) = ANY(%(domains)s)
        AND NOT EXISTS (SELECT 1 FROM public.memberships AS member
                         WHERE member.user_id = profile.id))
 ORDER BY profile.id
"""
_ORGANIZATION_TABLES_STATEMENT = """
SELECT table_name FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name = 'org_id'
"""
_USER_REFERENCES_STATEMENT = """
SELECT source.relname, column_name.attname, reference.confdeltype,
       cardinality(reference.conkey)
  FROM pg_catalog.pg_constraint AS reference
  JOIN pg_catalog.pg_class AS source ON source.oid = reference.conrelid
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = source.relnamespace
  JOIN pg_catalog.pg_attribute AS column_name
    ON column_name.attrelid = reference.conrelid AND column_name.attnum = reference.conkey[1]
 WHERE reference.contype = 'f' AND reference.confrelid = 'public.users'::regclass
   AND namespace.nspname = 'public'
 ORDER BY 1, 2
"""
_LINKED_ACCOUNTS_STATEMENT = (
    "SELECT supabase_user_id FROM public.users WHERE supabase_user_id = ANY(%(ids)s)"
)
_EXISTING_PROFILES_STATEMENT = "SELECT id FROM public.users WHERE id = ANY(%(ids)s)"


@dataclass(frozen=True)
class AuthAccount:
    """One provider Auth account in the pack's email domains."""

    id: UUID
    email: str
    openslate_user_id: UUID | None = None


@dataclass(frozen=True)
class UserReferences:
    """Every foreign key to ``users.id``, by table: restricting columns, then all columns."""

    organization_tables: frozenset[str]
    restricting: Mapping[str, tuple[str, ...]]
    referencing: Mapping[str, tuple[str, ...]]


@dataclass(frozen=True)
class Census:
    target_counts: Mapping[str, int]
    # Rows of every other organization, and NULL-organization rows ("null"), per table.
    retained: Mapping[str, Mapping[str, int]]
    null_organization_deletions: Mapping[str, int]
    blockers: tuple[str, ...]


@dataclass(frozen=True)
class OrganizationRemovalPlan:
    slugs: tuple[str, ...]
    organization_ids: tuple[UUID, ...]
    domains: tuple[str, ...]
    operator_email: str
    operator_id: UUID
    operator_provider_id: UUID
    installation_id: str
    alembic_head: str
    target_counts: Mapping[str, int]
    null_organization_deletions: Mapping[str, int]
    removable_user_ids: tuple[UUID, ...]
    kept_member_ids: tuple[UUID, ...]
    provider_account_ids: tuple[UUID, ...]
    storage_prefixes: tuple[str, ...]
    storage_object_keys: tuple[str, ...]
    auth_accounts: tuple[AuthAccount, ...] = field(repr=False)
    retained: Mapping[str, Mapping[str, int]] = field(repr=False)
    impact_digest: str = ""


def rows(
    connection: Any, statement: str | sql.Composable, params: Mapping[str, object] | None = None
) -> list[tuple[Any, ...]]:
    with connection.cursor() as cursor:
        cursor.execute(statement, params)
        return list(cursor.fetchall())


def validated_slugs(slugs: Iterable[str]) -> tuple[str, ...]:
    """Only sample organizations can be removed; any other slug refuses the whole plan."""
    values = tuple(slugs)
    if (
        not values
        or len(set(values)) != len(values)
        or any(not isinstance(slug, str) or _SAMPLE_SLUG.fullmatch(slug) is None for slug in values)
    ):
        raise ResetError("Only sample organizations (slug sample-...) can be removed")
    return tuple(sorted(values))


def _validated_domains(domains: Iterable[str], operator_email: str) -> tuple[str, ...]:
    values = tuple(sorted({domain.strip().casefold() for domain in domains}))
    if not values or any(_DOMAIN.fullmatch(domain) is None for domain in values):
        raise ResetError("The pack email domains are invalid")
    if operator_email.rpartition("@")[2] in values:
        raise ResetError("The installation operator belongs to a pack email domain")
    return values


def read_operator(connection: Any, email: str) -> tuple[UUID, UUID]:
    """The configured installation operator, which the removal never deletes."""
    found = rows(connection, _OPERATOR_STATEMENT, {"email": email.strip().casefold()})
    if len(found) != 1 or found[0][1] is None:
        raise ResetError("The configured email must resolve to one active installation operator")
    return _as_uuid(found[0][0]), _as_uuid(found[0][1])


def read_user_references(connection: Any) -> UserReferences:
    """Read the foreign keys to ``users.id`` from the catalog, not from a hand-kept list."""
    organization_tables = frozenset(
        str(row[0]) for row in rows(connection, _ORGANIZATION_TABLES_STATEMENT)
    )
    restricting: dict[str, list[str]] = {}
    referencing: dict[str, list[str]] = {}
    for table, column, action, width in rows(connection, _USER_REFERENCES_STATEMENT):
        if width != 1 or table not in APPLICATION_TABLES:
            raise ResetError("An account reference is not supported by organization removal")
        referencing.setdefault(table, []).append(column)
        if action in _RESTRICT_ACTIONS:
            restricting.setdefault(table, []).append(column)
    return UserReferences(
        organization_tables,
        MappingProxyType({table: tuple(columns) for table, columns in restricting.items()}),
        MappingProxyType({table: tuple(columns) for table, columns in referencing.items()}),
    )


def user_match(columns: Sequence[str]) -> sql.Composable:
    """``col = ANY(%(users)s) OR ...`` over catalog column names, or ``false``."""
    if not columns:
        return sql.SQL("false")
    return sql.SQL(" OR ").join(
        sql.SQL("{} = ANY(%(users)s)").format(sql.Identifier(column)) for column in columns
    )


def _group_column(table: str, references: UserReferences) -> str | None:
    if table == "organizations":
        return "id"
    return "org_id" if table in references.organization_tables else None


def read_census(
    connection: Any,
    organization_ids: Sequence[UUID],
    removable_user_ids: Sequence[UUID],
    references: UserReferences,
) -> Census:
    """Count every table's rows per organization and every reference to a removed account."""
    targets = set(organization_ids)
    target_counts: dict[str, int] = {}
    retained: dict[str, Mapping[str, int]] = {}
    deletions: dict[str, int] = {}
    blockers: set[str] = set()
    for table in APPLICATION_TABLES:
        group = _group_column(table, references)
        statement = sql.SQL(
            "SELECT {group}, count(*), count(*) FILTER (WHERE {restricting}), "
            "count(*) FILTER (WHERE {referencing}) FROM {table} GROUP BY 1"
        ).format(
            group=sql.Identifier(group) if group is not None else sql.SQL("NULL::uuid"),
            # No removed account matches nothing; an empty array is never sent.
            restricting=user_match(
                references.restricting.get(table, ()) if removable_user_ids else ()
            ),
            referencing=user_match(
                references.referencing.get(table, ()) if removable_user_ids else ()
            ),
            table=sql.Identifier("public", table),
        )
        target = 0
        kept: dict[str, int] = {}
        for organization, count, restricted, referenced in rows(
            connection, statement, {"users": list(removable_user_ids)}
        ):
            if group is None:
                # Installation tables: a restricting row (an operator role) keeps the account.
                if restricted:
                    blockers.add(table)
                continue
            if organization is not None and _as_uuid(organization) in targets:
                target += int(count)
                continue
            if organization is None and restricted:
                if table in NULL_ORGANIZATION_DELETIONS:
                    deletions[table] = int(restricted)
                else:
                    blockers.add(table)
            elif organization is not None and referenced:
                # Another organization still refers to the account; it is not the pack's alone.
                blockers.add(table)
            kept["null" if organization is None else str(organization)] = int(count)
        if group is not None:
            target_counts[table] = target
            retained[table] = MappingProxyType(dict(sorted(kept.items())))
    return Census(
        MappingProxyType(target_counts),
        MappingProxyType(retained),
        MappingProxyType(deletions),
        tuple(sorted(blockers)),
    )


def _classify_accounts(
    connection: Any, organization_ids: Sequence[UUID], domains: Sequence[str], operator_id: UUID
) -> tuple[tuple[tuple[UUID, UUID | None], ...], tuple[UUID, ...]]:
    removable: list[tuple[UUID, UUID | None]] = []
    kept: list[UUID] = []
    for user_id, provider_id, elsewhere, operator in rows(
        connection,
        _ACCOUNTS_STATEMENT,
        {"orgs": list(organization_ids), "domains": list(domains)},
    ):
        profile = _as_uuid(user_id)
        if elsewhere or operator or profile == operator_id:
            kept.append(profile)
        else:
            removable.append((profile, _as_uuid(provider_id) if provider_id is not None else None))
    return tuple(removable), tuple(kept)


def _provider_account_ids(
    connection: Any,
    removable: Sequence[tuple[UUID, UUID | None]],
    accounts: Sequence[AuthAccount],
    operator_provider_id: UUID,
) -> tuple[UUID, ...]:
    """Removed accounts' provider ids, plus pack-domain Auth accounts that no profile holds."""
    removed_profiles = {user_id for user_id, _ in removable}
    account_ids = [account.id for account in accounts]
    owners = [account.openslate_user_id for account in accounts if account.openslate_user_id]
    held = (
        {
            _as_uuid(row[0])
            for row in rows(connection, _LINKED_ACCOUNTS_STATEMENT, {"ids": account_ids})
        }
        if account_ids
        else set()
    )
    existing = (
        {
            _as_uuid(row[0])
            for row in rows(connection, _EXISTING_PROFILES_STATEMENT, {"ids": owners})
        }
        if owners
        else set()
    )
    selected = {provider_id for _, provider_id in removable if provider_id is not None}
    for account in accounts:
        owner = account.openslate_user_id
        # An unbound account whose metadata names a kept profile stays with that profile.
        if account.id not in held and (
            owner is None or owner in removed_profiles or owner not in existing
        ):
            selected.add(account.id)
    if operator_provider_id in selected:
        raise ResetError("The installation operator cannot be removed")
    return tuple(sorted(selected, key=str))


def storage_prefixes(
    organization_ids: Sequence[UUID], removable_user_ids: Sequence[UUID]
) -> tuple[str, ...]:
    return tuple(
        sorted(
            [f"openslate-ready/org/{org_id}" for org_id in organization_ids]
            + [f"openslate-avatars/user/{user_id}" for user_id in removable_user_ids]
        )
    )


def _impact_digest(plan: OrganizationRemovalPlan) -> str:
    payload = {
        "slugs": list(plan.slugs),
        "organization_ids": [str(value) for value in plan.organization_ids],
        "domains": list(plan.domains),
        "operator_id": str(plan.operator_id),
        "operator_provider_id": str(plan.operator_provider_id),
        "installation_id": plan.installation_id,
        "alembic_head": plan.alembic_head,
        "target_counts": dict(plan.target_counts),
        "null_organization_deletions": dict(plan.null_organization_deletions),
        "removable_user_ids": [str(value) for value in plan.removable_user_ids],
        "kept_member_ids": [str(value) for value in plan.kept_member_ids],
        "provider_account_ids": [str(value) for value in plan.provider_account_ids],
        "storage_object_keys": list(plan.storage_object_keys),
        "retained": {table: dict(counts) for table, counts in plan.retained.items()},
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    ).hexdigest()


def build_organization_removal_plan(
    connection: Any,
    *,
    slugs: Iterable[str],
    operator_email: str,
    domains: Iterable[str],
    auth_accounts: Iterable[AuthAccount],
    list_storage_keys: Callable[[tuple[str, ...]], Sequence[str]],
) -> OrganizationRemovalPlan:
    """Read and validate one removal; the digest changes when any planned value changes."""
    try:
        target_slugs = validated_slugs(slugs)
        email = operator_email.strip().casefold()
        pack_domains = _validated_domains(domains, email)
        _read_public_table_names(connection)
        alembic_head = _read_alembic_head(connection)
        installation_id = _installation(connection)
        operator_id, operator_provider_id = read_operator(connection, email)
        organization_ids = tuple(
            _as_uuid(row[0])
            for row in rows(connection, _TARGETS_STATEMENT, {"slugs": list(target_slugs)})
        )
        if not organization_ids:
            raise ResetError("No organization matches the sample pack")
        removable, kept = _classify_accounts(
            connection, organization_ids, pack_domains, operator_id
        )
        removable_ids = tuple(user_id for user_id, _ in removable)
        census = read_census(
            connection, organization_ids, removable_ids, read_user_references(connection)
        )
        if census.blockers:
            raise ResetError(
                "Accounts of the pack are still referenced outside its organizations: "
                + ", ".join(census.blockers)
            )
        accounts = tuple(sorted(set(auth_accounts), key=lambda account: str(account.id)))
        provider_ids = _provider_account_ids(connection, removable, accounts, operator_provider_id)
        prefixes = storage_prefixes(organization_ids, removable_ids)
        keys = tuple(list_storage_keys(prefixes))
        if tuple(sorted(set(keys))) != keys or any(
            not any(key.startswith(f"{p}/") for p in prefixes) for key in keys
        ):
            raise ResetError("The private storage inventory is invalid")
        plan = OrganizationRemovalPlan(
            slugs=target_slugs,
            organization_ids=organization_ids,
            domains=pack_domains,
            operator_email=email,
            operator_id=operator_id,
            operator_provider_id=operator_provider_id,
            installation_id=installation_id,
            alembic_head=alembic_head,
            target_counts=census.target_counts,
            null_organization_deletions=census.null_organization_deletions,
            removable_user_ids=removable_ids,
            kept_member_ids=kept,
            provider_account_ids=provider_ids,
            storage_prefixes=prefixes,
            storage_object_keys=keys,
            auth_accounts=accounts,
            retained=census.retained,
        )
        return replace(plan, impact_digest=_impact_digest(plan))
    except ResetError:
        raise
    except Exception:
        raise ResetError("Unable to plan the organization removal") from None
