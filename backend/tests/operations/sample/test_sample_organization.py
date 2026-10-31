"""A second sample pack counts only its own organization and its own people."""

from __future__ import annotations

import json
from uuid import UUID

import httpx
import pytest

from operations.reset.auth import ResetAuth
from operations.reset.models import ResetError
from operations.sample.organization import (
    organization_storage_objects,
    organization_usage,
    other_organizations,
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


def test_the_pack_administrator_is_a_testing_account_outside_the_pack_domains() -> None:
    # The administrator is admin@<pack>.test, a kept testing account; the populate-once
    # guard still counts every account in the pack's own email domains.
    harbor = get_pack("harbor")
    person = harbor.actors.people[0].email
    users = [
        {"id": str(ADMIN_PROVIDER), "email": "owner@install.example"},
        {"id": "0190a000-0000-7000-8000-000000000006", "email": "admin@harbor.test"},
        {"id": "0190a000-0000-7000-8000-000000000007", "email": person},
    ]
    domains = pack_email_domains(harbor)

    assert pack_administrator_email(harbor) == "admin@harbor.test"
    assert pack_administrator_email(get_pack("local_government")) == "admin@local-government.test"
    operator = "owner@install.example"
    assert pack_provider_accounts(_auth(users), ADMIN_PROVIDER, operator, domains) == 1


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
        pack_administrator="admin@harbor.test",
    )

    assert usage is not None and usage.other_members == 0
    ((statement, values),) = connection.statements
    assert values == {
        "admin": ADMIN_PROVIDER,
        "slug": "sample-harbor",
        "pack_administrator": "admin@harbor.test",
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


def test_people_are_unique_across_every_pack_in_one_installation() -> None:
    # Live seven-pack run: Nonprofit shared two usernames with other packs, so its
    # invitation was refused (409) once the packs populated one installation together.
    from collections import Counter
    from datetime import date

    from operations.sample.packs.registry import pack_keys
    from operations.sample.scenario import build_dataset

    usernames: Counter[str] = Counter()
    emails: Counter[str] = Counter()
    for key in pack_keys():
        pack = get_pack(key)
        people = build_dataset("large", 83, date(2026, 10, 2), organization=pack).organization
        usernames.update(person.username.lower() for person in people.actors.people)
        emails.update(person.email.lower() for person in people.actors.people)
        emails[pack_administrator_email(pack)] += 1

    assert [name for name, count in usernames.items() if count > 1] == []
    assert [email for email, count in emails.items() if count > 1] == []


def test_pack_organization_writes_publish_to_the_database_they_commit_to(monkeypatch) -> None:
    # Sample populate runs logged realtime_invalidation_failure (publish_failed,
    # OperationalError) on every in-process commit: the owner engine had an empty URL, so
    # the audit listener's post-commit publish connected to no database at all.
    import operations.create_organization as provisioning
    import operations.reset.planning as planning
    from app.core.database import session as database_session
    from operations.sample import organization as sample_organization

    owner = "postgresql://openslate_owner:owner-secret@127.0.0.1:55432/postgres"
    monkeypatch.setattr(planning, "required_environment", lambda values: (owner, None))
    monkeypatch.setattr(planning, "_validated_database_url", lambda value, target: value)
    seen: list[str] = []

    class Recording:
        def __init__(self, engine) -> None:
            seen.append(engine.url.set(drivername="postgresql").render_as_string(False))

        def __enter__(self):
            return self

        def __exit__(self, *exc) -> None:
            return None

    monkeypatch.setattr(database_session, "AuditSession", Recording)
    created = UUID("00000000-0000-4000-8000-0000000000ab")
    monkeypatch.setattr(
        provisioning, "provision", lambda db, **kwargs: type("Org", (), {"id": created})()
    )
    result = sample_organization.create_sample_organization(
        {}, object(), get_pack("harbor"), UUID("00000000-0000-4000-8000-0000000000ac")
    )
    assert result == created
    assert seen == [owner]


def test_other_organizations_leave_out_only_the_pack_pair() -> None:
    frozen = [
        json.dumps({"slug": slug})
        for slug in ("sample-school", "sample-school-partner", "sample-harbor", "acme")
    ]

    assert other_organizations(frozen, get_pack("school")) == 2
    assert other_organizations(frozen[:2], get_pack("school")) == 0
