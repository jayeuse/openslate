"""One organization per sample pack: its stable slug, preflight usage, and creation."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from operations.reset.auth import _ACCOUNT_PAGE_SIZE, _MAX_ACCOUNT_PAGES, ResetAuth
from operations.reset.models import ResetError
from operations.sample.packs.interface import OrganizationPack

# The fresh-install name; population renames the organization to the pack's name.
_INITIAL_NAME = "OpenSlate"
_USAGE_STATEMENT = """
SELECT o.id,
       (SELECT count(*) FROM public.memberships m
         WHERE m.org_id = o.id AND m.user_id <> %(admin)s),
       (SELECT count(*) FROM public.records r WHERE r.org_id = o.id),
       EXISTS (SELECT 1 FROM public.memberships m
                WHERE m.org_id = o.id AND m.user_id = %(admin)s AND m.role = 'admin'
                  AND m.status = 'active' AND m.is_deleted = false)
  FROM public.organizations o
 WHERE o.slug = %(slug)s
"""


@dataclass(frozen=True, slots=True)
class OrganizationUsage:
    organization_id: UUID
    other_members: int
    records: int
    administered: bool


def sample_slug(pack_key: str) -> str:
    """The stable slug that finds a pack's organization again in the same install."""
    return f"sample-{pack_key}"


def pack_email_domains(pack: OrganizationPack) -> frozenset[str]:
    return frozenset(
        domain.casefold()
        for domain in (pack.identity.email_domain, pack.actors.internal_domain,
                       *pack.actors.guest_domains)
    )


def organization_usage(connection: Any, slug: str, admin_id: UUID) -> OrganizationUsage | None:
    """Read the pack organization's sample footprint; None when it does not exist yet."""
    rows = connection.execute(_USAGE_STATEMENT, {"admin": admin_id, "slug": slug}).fetchall()
    if not rows:
        return None
    (organization_id, members, records, administered), = rows
    return OrganizationUsage(UUID(str(organization_id)), int(members), int(records),
                             administered is True)


def organization_storage_objects(object_keys: Iterable[str], organization_id: UUID | None) -> int:
    """Count private objects of one organization (``<bucket>/org/<id>/...``) only."""
    if organization_id is None:
        return 0
    prefix = f"org/{organization_id}/"
    return sum(key.partition("/")[2].startswith(prefix) for key in object_keys)


def pack_provider_accounts(
    auth: ResetAuth, admin_provider_id: UUID, admin_email: str, domains: frozenset[str]
) -> int:
    """Count provider Auth accounts in the pack's email domains; other packs do not count."""
    admin_seen = False
    count = 0
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
                if user_id == admin_provider_id:
                    admin_seen = email == admin_email.strip().casefold()
                else:
                    count += email.rpartition("@")[2] in domains
        except (ValueError, TypeError, KeyError):
            raise ResetError("The provider Auth inventory is invalid") from None
        if len(users) < _ACCOUNT_PAGE_SIZE:
            if not admin_seen:
                raise ResetError("The preserved administrator is missing from Auth")
            return count
    raise ResetError("The provider Auth inventory is incomplete")


def create_sample_organization(
    values: Mapping[str, str], target: Any, pack: OrganizationPack, admin_id: UUID
) -> UUID:
    """Create the pack organization, owned by the administrator, on the verified owner target."""
    from psycopg import connect
    from sqlalchemy import create_engine
    from sqlalchemy.pool import NullPool

    from app.core.config.instance import assert_psycopg_target
    from app.core.database.session import AuditSession
    from operations.create_organization import provision
    from operations.reset.planning import _validated_database_url, required_environment

    database_url = _validated_database_url(required_environment(values)[0], target)

    def owner_connection() -> Any:
        connection = connect(database_url)
        assert_psycopg_target(connection, target, expected_user="openslate_owner")
        connection.rollback()
        return connection

    engine = create_engine("postgresql+psycopg://", creator=owner_connection, poolclass=NullPool)
    try:
        with AuditSession(engine) as db:
            organization = provision(
                db, name=_INITIAL_NAME, slug=sample_slug(pack.identity.key),
                admin_user_id=admin_id,
            )
            return organization.id
    finally:
        engine.dispose()
