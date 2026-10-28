"""A second sample pack counts only its own organization and its own people."""

from __future__ import annotations

from uuid import UUID

import httpx
import pytest

from operations.reset.auth import ResetAuth
from operations.reset.models import ResetError
from operations.sample.organization import (
    organization_storage_objects,
    organization_usage,
    pack_administrator_email,
    pack_email_domains,
    pack_provider_accounts,
)
from operations.sample.packs import get_pack

HARBOR_ORG = UUID("0190a000-0000-7000-8000-0000000000aa")
SCHOOL_ORG = UUID("0190a000-0000-7000-8000-0000000000bb")
ADMIN_PROVIDER = UUID("0190a000-0000-7000-8000-000000000001")


def test_storage_objects_count_only_the_pack_organization_folder() -> None:
    keys = (
        f"openslate-avatars/org/{SCHOOL_ORG}/avatar",
        f"openslate-ready/org/{HARBOR_ORG}/file-a",
        f"openslate-ready/org/{SCHOOL_ORG}/file-b",
        f"openslate-ready/org/{SCHOOL_ORG}-other/file-c",
        "openslate-ready/user/0190a000-0000-7000-8000-000000000002/avatar",
    )

    assert organization_storage_objects(keys, SCHOOL_ORG) == 2
    assert organization_storage_objects(keys, None) == 0


def _auth(users: list[dict[str, str]]) -> ResetAuth:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth/v1/admin/users"
        return httpx.Response(200, json={"users": users})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return ResetAuth("http://127.0.0.1:54321", "service-fixture", 2.0, client=client)


def test_provider_accounts_count_only_the_pack_email_domains() -> None:
    users = [
        {"id": str(ADMIN_PROVIDER), "email": "Owner@Install.example"},
        {"id": "0190a000-0000-7000-8000-000000000003", "email": "lead@harbor-ops.example"},
        {"id": "0190a000-0000-7000-8000-000000000004", "email": "aud@kalinaw-audit.example"},
        {"id": "0190a000-0000-7000-8000-000000000005", "email": "teacher@school.example"},
    ]

    harbor = pack_email_domains(get_pack("harbor"))
    school = pack_email_domains(get_pack("school"))

    admin = "owner@install.example"
    assert pack_provider_accounts(_auth(users), ADMIN_PROVIDER, admin, harbor) == 2
    assert pack_provider_accounts(_auth(users), ADMIN_PROVIDER, admin, school) == 1


def test_provider_inventory_without_the_administrator_is_refused() -> None:
    users = [{"id": "0190a000-0000-7000-8000-000000000005", "email": "teacher@school.example"}]

    with pytest.raises(ResetError, match="administrator is missing"):
        pack_provider_accounts(_auth(users), ADMIN_PROVIDER, "owner@install.example", frozenset())


def test_a_resumed_pack_ignores_exactly_its_pack_administrator_account() -> None:
    harbor = get_pack("harbor")
    users = [
        {"id": str(ADMIN_PROVIDER), "email": "owner@install.example"},
        {"id": "0190a000-0000-7000-8000-000000000006", "email": "administrator@harbor-ops.example"},
        {"id": "0190a000-0000-7000-8000-000000000007", "email": "administrator@school.example"},
    ]
    domains = pack_email_domains(harbor) | pack_email_domains(get_pack("school"))
    resumed = frozenset({pack_administrator_email(harbor)})

    assert pack_administrator_email(harbor) == "administrator@harbor-ops.example"
    # A fresh pack still refuses: its own administrator counts like any pack account.
    operator = "owner@install.example"
    assert pack_provider_accounts(_auth(users), ADMIN_PROVIDER, operator, domains) == 2
    assert (
        pack_provider_accounts(
            _auth(users), ADMIN_PROVIDER, "owner@install.example", domains, ignored_emails=resumed
        )
        == 1
    )


class _Connection:
    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, object]]] = []

    def execute(self, statement: str, values: dict[str, object]) -> _Connection:
        self.statements.append((statement, values))
        return self

    def fetchall(self) -> list[tuple[object, ...]]:
        return [(HARBOR_ORG, 0, 0, True)]


def test_organization_usage_excludes_the_operator_and_the_pack_administrator() -> None:
    connection = _Connection()

    usage = organization_usage(
        connection,
        "sample-harbor",
        ADMIN_PROVIDER,
        pack_administrator="administrator@harbor-ops.example",
    )

    assert usage is not None and usage.other_members == 0
    ((statement, values),) = connection.statements
    assert values == {
        "admin": ADMIN_PROVIDER,
        "slug": "sample-harbor",
        "pack_administrator": "administrator@harbor-ops.example",
    }
    assert "u.email <> %(pack_administrator)s" in statement


def test_every_pack_slug_is_a_valid_organization_slug() -> None:
    # A pack key is a Python package name (local_government); a slug allows only hyphens.
    import re

    from operations.sample.organization import sample_slug
    from operations.sample.packs.registry import pack_keys

    for key in pack_keys():
        for partner in (False, True):
            assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", sample_slug(key, partner=partner))
    assert sample_slug("harbor") == "sample-harbor"
    assert sample_slug("local_government") == "sample-local-government"
