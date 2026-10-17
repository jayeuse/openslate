"""Future-only recorded User history storage on the fresh root."""

from uuid import uuid4

import pytest
from sqlalchemy import text

from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration


def test_history_columns_initialize_null_without_inventing_observation_facts(integration_db):
    db = integration_db
    identity, provider = uuid4(), uuid4()
    create_member(db, create_organization(db), id=identity,
                  email=f"history-{identity}@example.test", username=identity.hex)
    connection = db.connection()
    connection.execute(
        text(
            "INSERT INTO identity_mfa_observations"
            "(user_id,observed_provider_user_id,verified_totp,observed_at) "
            "VALUES(:id,:provider,true,now())"
        ),
        {"id": identity, "provider": provider},
    )
    assert connection.scalar(
        text(
            "SELECT count(*) FROM information_schema.columns WHERE "
            "table_schema='public' AND table_name='identity_mfa_observations' "
            "AND column_name IN ('last_sign_in_at','last_active_at')"
        )
    ) == 2
    assert (
        connection.execute(
            text(
                "SELECT data_type,is_nullable,column_default FROM "
                "information_schema.columns WHERE table_schema='public' AND "
                "table_name='identity_mfa_observations' AND column_name IN "
                "('last_sign_in_at','last_active_at') ORDER BY column_name"
            )
        ).all()
        == [("timestamp with time zone", "YES", None)] * 2
    )
    assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
    assert connection.execute(
        text(
            "SELECT last_sign_in_at,last_active_at FROM "
            "identity_mfa_observations WHERE user_id=:id"
        ),
        {"id": identity},
    ).one() == (None, None)
