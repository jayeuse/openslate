"""The Realtime join function and the provisioned realtime.messages policies."""

import json
from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError

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
            connection.scalar(
                text("SELECT public.can_join_realtime_topic(:topic)"), {"topic": topic}
            )
        )


def _claims(user_id: UUID, org_id: UUID | str) -> dict[str, object]:
    return {
        "role": "authenticated",
        "purpose": "realtime",
        "sub": str(user_id),
        "org_id": str(org_id),
    }


def test_function_is_owner_bound_and_executable_only_by_realtime_role(integration_owner_db):
    connection = integration_owner_db.connection()
    row = connection.execute(
        text(
            "SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner), "
            "l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang "
            f"WHERE p.oid = '{SIGNATURE}'::regprocedure"
        )
    ).one()
    assert row[0:2] == (True, "s")
    assert dict(value.split("=", 1) for value in row[2])["search_path"] == "pg_catalog, pg_temp"
    assert row[3:] == ("openslate_owner", "plpgsql")
    privilege = text("SELECT has_function_privilege(:role, :signature, 'EXECUTE')")
    assert connection.scalar(privilege, {"role": "authenticated", "signature": SIGNATURE})
    for role in ("anon", "service_role", "openslate_runtime"):
        assert connection.scalar(privilege, {"role": role, "signature": SIGNATURE}) is False


def test_realtime_messages_carry_only_the_membership_policies(integration_owner_db):
    rows = (
        integration_owner_db.connection()
        .execute(
            text(
                # Catalog lookup by name does not depend on realtime schema USAGE.
                "SELECT polname, polcmd, polpermissive, "
                "polroles = ARRAY['authenticated'::regrole::oid] "
                "FROM pg_policy JOIN pg_class ON pg_class.oid = pg_policy.polrelid "
                "JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace "
                "WHERE nspname = 'realtime' AND relname = 'messages' ORDER BY polname"
            )
        )
        .all()
    )
    assert [tuple(row) for row in rows] == [
        ("openslate_realtime_member_read", "r", True, True),
        ("openslate_realtime_member_write", "a", True, True),
    ]


def _send_oid(connection: Connection) -> int:
    # Catalog lookup avoids requiring realtime USAGE just to inspect the exact overload.
    return connection.execute(
        text(
            "SELECT p.oid FROM pg_catalog.pg_proc p "
            "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace "
            "WHERE n.nspname = 'realtime' AND p.proname = 'send' "
            "AND pg_catalog.oidvectortypes(p.proargtypes) = 'jsonb, text, text, boolean'"
        )
    ).scalar_one()


def test_send_owner_has_no_sql_publish_privileges(integration_owner_db):
    connection = integration_owner_db.connection()
    privileges = connection.execute(
        text(
            "SELECT has_schema_privilege('openslate_owner', 'realtime', 'USAGE'), "
            "has_function_privilege('openslate_owner', CAST(:routine AS oid), 'EXECUTE')"
        ),
        {"routine": _send_oid(connection)},
    ).one()
    assert tuple(privileges) == (False, False)


@pytest.mark.parametrize("role", ["openslate_app", "openslate_runtime", "authenticated"])
def test_send_direct_execute_is_denied(integration_owner_db, role: str):
    connection = integration_owner_db.connection()
    assert (
        connection.scalar(
            text("SELECT has_function_privilege(:role, CAST(:routine AS oid), 'EXECUTE')"),
            {"role": role, "routine": _send_oid(connection)},
        )
        is False
    )


def test_send_runtime_invocation_raises_insufficient_privilege(integration_db):
    connection = integration_db.connection()
    assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
    # The provider can swallow insert/RLS errors as warnings. Only a real 42501
    # exception counts as denial; the effective-EXECUTE tests protect the ACL itself.
    with connection.begin_nested() as savepoint:
        with pytest.raises(DBAPIError) as failure:
            connection.execute(
                text("SELECT realtime.send('{}'::jsonb, 'probe', :topic, true)"),
                {"topic": f"org:{uuid4()}:probe"},
            )
        # Recover the expected failed statement before releasing the savepoint.
        savepoint.rollback()
    assert getattr(failure.value.orig, "sqlstate", None) == "42501"


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
    assert not _can_join(connection, f"org:{organization.id}:chat:{uuid4()}", **claims)
    assert _can_join(connection, f"org:{organization.id}:user:{member.id}", **claims)
    assert not _can_join(connection, f"org:{organization.id}:user:{uuid4()}", **claims)
    assert _can_join(connection, f"org:{organization.id}:presence", **claims)
    assert not _can_join(connection, f"org:{organization.id}:conversation:{uuid4()}", **claims)
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
        db,
        organization,
        "guest",
        sponsor_user_id=sponsor.id,
        expires_at=utc_now() + timedelta(days=1),
    )
    db.flush()
    connection = db.connection()
    topic = f"org:{organization.id}:probe"
    assert _can_join(connection, topic, **_claims(guest.id, organization.id))
    assert _can_join(
        connection, f"org:{organization.id}:presence", **_claims(guest.id, organization.id)
    )

    connection.execute(
        text(
            "UPDATE public.memberships SET expires_at = now() - interval '1 minute' "
            "WHERE user_id = :user"
        ),
        {"user": guest.id},
    )

    assert not _can_join(connection, topic, **_claims(guest.id, organization.id))


def test_conversation_join_needs_a_live_subject_grant_and_purge_removes_projection(
    integration_owner_db,
):
    from sqlalchemy import select
    from uuid6 import uuid7

    from app.systems.comms.conversations.models import CommsConversation
    from app.systems.comms.realtime.models import CommsRealtimeGrant

    db = integration_owner_db
    org = create_organization(db)
    actor, _ = create_member(db, org)
    other, _ = create_member(db, org)
    conversation = CommsConversation(
        id=uuid7(),
        org_id=org.id,
        kind="channel",
        scope="members",
        name="Owned grant",
        created_by=actor.id,
    )
    db.add(conversation)
    db.flush()
    topic = f"org:{org.id}:conversation:{conversation.id}"
    claims = _claims(actor.id, org.id)
    connection = db.connection()
    assert not _can_join(connection, topic, **claims)
    grant = CommsRealtimeGrant(
        org_id=org.id,
        user_id=actor.id,
        conversation_id=conversation.id,
        expires_at=utc_now() + timedelta(minutes=5),
    )
    db.add(grant)
    db.flush()
    assert _can_join(connection, topic, **claims)
    assert not _can_join(connection, topic, **_claims(other.id, org.id))
    grant.expires_at = utc_now() - timedelta(seconds=1)
    db.flush()
    assert not _can_join(connection, topic, **claims)
    grant.expires_at = utc_now() + timedelta(minutes=5)
    conversation.archived_at = utc_now()
    db.flush()
    assert not _can_join(connection, topic, **claims)
    db.delete(conversation)
    db.flush()
    assert (
        list(db.scalars(select(CommsRealtimeGrant.id).where(CommsRealtimeGrant.org_id == org.id)))
        == []
    )
