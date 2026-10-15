"""Observation constraints, runtime ACLs and cascade on the fresh root."""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tests.conftest import create_member, create_organization, guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment

pytestmark = pytest.mark.integration


@pytest.fixture
def migration_user():
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    identity = uuid4()
    with Session(engine) as db:
        organization = create_organization(db)
        org_id = organization.id
        create_member(db, organization, "admin", id=identity,
                      email=f"observation-{identity}@example.test", username=identity.hex)
        db.commit()
    try:
        yield identity
    finally:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM memberships WHERE user_id=:id"), {"id": identity})
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": identity})
            connection.execute(text("DELETE FROM organizations WHERE id=:id"), {"id": org_id})
        engine.dispose()


@pytest.mark.parametrize(
    "bad",
    ["known_without_binding", "known_without_time", "binding_without_time", "time_without_binding"],
)
def test_observation_check_rejects_incomplete_authority(bad, migration_user):
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    values = {
        "user": migration_user,
        "provider": uuid4(),
        "verified": True,
        "observed": "2035-01-01T00:00:00Z",
    }
    values[
        "provider" if bad in {"known_without_binding", "time_without_binding"} else "observed"
    ] = None
    if bad in {"binding_without_time", "time_without_binding"}:
        values["verified"] = None
    try:
        with engine.connect() as connection:
            with pytest.raises(IntegrityError) as caught:
                connection.execute(
                    text(
                        "INSERT INTO "
                        "identity_mfa_observations(user_id,observed_provider_user_id,verified_totp,observed_at)"
                        " VALUES(:user,:provider,:verified,:observed)"
                    ),
                    values,
                )
            assert (
                caught.value.orig.diag.constraint_name == "ck_identity_mfa_observations_authority"
            )
            connection.rollback()
    finally:
        engine.dispose()


def test_runtime_projection_privileges_and_user_cascade_are_narrow(migration_user):
    environment = guarded_migration_environment()
    runtime = guarded_create_engine(environment["TEST_DATABASE_URL"])
    owner = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    try:
        with runtime.begin() as connection:
            connection.execute(
                text("INSERT INTO identity_mfa_observations(user_id) VALUES(:id)"),
                {"id": migration_user},
            )
            assert (
                connection.scalar(
                    text("SELECT verified_totp FROM identity_mfa_observations WHERE user_id=:id"),
                    {"id": migration_user},
                )
                is None
            )
            connection.execute(
                text(
                    "UPDATE identity_mfa_observations SET "
                    "verified_totp=false,observed_at=now(),observed_provider_user_id=:provider"
                    " WHERE user_id=:id"
                ),
                {"id": migration_user, "provider": uuid4()},
            )
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege(current_user,'auth.sessions','SELECT')")
                )
                is False
            )
        with owner.begin() as connection:
            connection.execute(
                text("DELETE FROM memberships WHERE user_id=:id"), {"id": migration_user}
            )
            connection.execute(text("DELETE FROM users WHERE id=:id"), {"id": migration_user})
            assert (
                connection.scalar(
                    text("SELECT count(*) FROM identity_mfa_observations WHERE user_id=:id"),
                    {"id": migration_user},
                )
                == 0
            )
    finally:
        runtime.dispose()
        owner.dispose()
