"""The Realtime join function and the provisioned realtime.messages policies."""

import json
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Connection, text

from app.core.base_model import utc_now
from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration
SIGNATURE = "public.can_join_realtime_topic(text)"


def _can_join(connection: Connection, topic: str, **claims: object) -> bool:
    with connection.begin_nested():
        connection.execute(
            text("SELECT set_config('request.jwt.claims', :claims, true)"),
            {"claims": json.dumps(claims)},
        )
        return bool(
            connection.scalar(text("SELECT public.can_join_realtime_topic(:topic)"),
                              {"topic": topic})
        )


def _claims(user_id: UUID, org_id: UUID | str) -> dict[str, object]:
    return {"role": "authenticated", "purpose": "realtime", "sub": str(user_id),
            "org_id": str(org_id)}


def test_function_is_owner_bound_and_executable_only_by_realtime_role(integration_owner_db):
    connection = integration_owner_db.connection()
    row = connection.execute(text(
        "SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner), "
        "l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang "
        f"WHERE p.oid = '{SIGNATURE}'::regprocedure"
    )).one()
    assert row[0:2] == (True, "s")
    assert dict(value.split("=", 1) for value in row[2])["search_path"] == "pg_catalog, pg_temp"
    assert row[3:] == ("openslate_owner", "plpgsql")
    privilege = text("SELECT has_function_privilege(:role, :signature, 'EXECUTE')")
    assert connection.scalar(privilege, {"role": "authenticated", "signature": SIGNATURE})
    for role in ("anon", "service_role", "openslate_runtime"):
        assert connection.scalar(privilege, {"role": role, "signature": SIGNATURE}) is False


def test_realtime_messages_carry_only_the_membership_policies(integration_owner_db):
    rows = integration_owner_db.connection().execute(text(
        # Catalog lookup by name: openslate_owner has no USAGE on the realtime schema.
        "SELECT polname, polcmd, polpermissive, polroles = ARRAY['authenticated'::regrole::oid] "
        "FROM pg_policy JOIN pg_class ON pg_class.oid = pg_policy.polrelid "
        "JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace "
        "WHERE nspname = 'realtime' AND relname = 'messages' ORDER BY polname"
    )).all()
    assert [tuple(row) for row in rows] == [
        ("openslate_realtime_member_read", "r", True, True),
        ("openslate_realtime_member_write", "a", True, True),
    ]


def test_join_requires_purpose_topic_prefix_and_a_live_membership(integration_owner_db):
    db = integration_owner_db
    organization = create_organization(db)
    other = create_organization(db)
    member, _membership = create_member(db, organization)
    db.flush()
    connection = db.connection()
    topic = f"org:{organization.id}:probe"
    claims = _claims(member.id, organization.id)

    assert _can_join(connection, topic, **claims)
    assert _can_join(connection, f"org:{organization.id}:chat:{uuid4()}", **claims)
    assert not _can_join(connection, f"org:{other.id}:probe", **claims)
    assert not _can_join(connection, f"org:{organization.id}:", **claims)
    assert not _can_join(connection, f"org:{organization.id.hex}:probe", **claims)
    assert not _can_join(connection, topic, **{**claims, "purpose": "session"})
    assert not _can_join(connection, topic, role="authenticated", sub=str(member.id))
    assert not _can_join(connection, topic, **{**claims, "role": "anon"})
    assert not _can_join(connection, topic, **{**claims, "org_id": "not-a-uuid"})
    assert not _can_join(connection, topic, **{**claims, "sub": "not-a-uuid"})
    assert not _can_join(connection, topic, **_claims(uuid4(), organization.id))
    assert not _can_join(connection, f"org:{other.id}:probe", **_claims(member.id, other.id))


@pytest.mark.parametrize(
    "revocation",
    [
        "UPDATE public.memberships SET status = 'disabled' WHERE user_id = :user",
        "UPDATE public.memberships SET is_deleted = true WHERE user_id = :user",
        "UPDATE public.users SET status = 'disabled' WHERE id = :user",
    ],
    ids=["membership-disabled", "membership-deleted", "account-disabled"],
)
def test_join_is_refused_once_access_ends(integration_owner_db, revocation: str):
    db = integration_owner_db
    organization = create_organization(db)
    member, _membership = create_member(db, organization)
    db.flush()
    connection = db.connection()
    topic = f"org:{organization.id}:probe"
    assert _can_join(connection, topic, **_claims(member.id, organization.id))

    connection.execute(text(revocation), {"user": member.id})

    assert not _can_join(connection, topic, **_claims(member.id, organization.id))


def test_join_is_refused_after_guest_expiry(integration_owner_db):
    db = integration_owner_db
    organization = create_organization(db)
    sponsor, _ = create_member(db, organization, "admin")
    guest, _ = create_member(
        db, organization, "guest", sponsor_user_id=sponsor.id,
        expires_at=utc_now() + timedelta(days=1),
    )
    db.flush()
    connection = db.connection()
    topic = f"org:{organization.id}:probe"
    assert _can_join(connection, topic, **_claims(guest.id, organization.id))

    connection.execute(
        text("UPDATE public.memberships SET expires_at = now() - interval '1 minute' "
             "WHERE user_id = :user"),
        {"user": guest.id},
    )

    assert not _can_join(connection, topic, **_claims(guest.id, organization.id))
