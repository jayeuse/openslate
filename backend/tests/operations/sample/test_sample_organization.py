"""A second sample pack counts only its own organization and its own people."""

from __future__ import annotations

from uuid import UUID

import httpx
import pytest

from operations.reset.auth import ResetAuth
from operations.reset.models import ResetError
from operations.sample.organization import (
    organization_storage_objects,
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
