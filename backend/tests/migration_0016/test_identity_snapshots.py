import os

import pytest
from sqlalchemy import text
from uuid6 import uuid7

from tests.api_integration_support import create_owned_admin, delete_owned_admin
from tests.conftest import _guard_integration_database


@pytest.mark.integration
def test_security_event_identity_snapshots_survive_hard_deleted_user(integration_db) -> None:
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if not owner_url:
        pytest.skip("MIGRATION_DATABASE_URL is required for owned identity setup")
    _guard_integration_database(owner_url)
    actor = create_owned_admin(os.environ["TEST_DATABASE_URL"], owner_url, "identity_snapshot")
    connection = integration_db.connection()
    event_id = uuid7()
    try:
        connection.execute(
            text(
                "INSERT INTO public.security_events "
                "(id, occurred_at, event_type, outcome, source, operation_id, "
                "actor_id, subject_id) "
                "VALUES (:event, CURRENT_TIMESTAMP, 'migration.identity_snapshot', 'success', "
                "'migration-test', :operation, :actor, :actor)"
            ),
            {"event": event_id, "operation": uuid7(), "actor": actor.id},
        )
        connection.execute(text("DELETE FROM public.users WHERE id = :actor"), {"actor": actor.id})
        assert connection.execute(
            text("SELECT actor_id, subject_id FROM public.security_events WHERE id = :event"),
            {"event": event_id},
        ).one() == (actor.id, actor.id)
    finally:
        connection.rollback()
        delete_owned_admin(owner_url, actor.id)
