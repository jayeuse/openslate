"""Signed identity and PostgreSQL authority govern the registered batch route."""

import pytest
from sqlalchemy.orm import Session

from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import FieldType
from app.systems.sandbox.records.models import Record
from tests.catalog.dynamic_field_support import (
    _seed_committed_module,
    _seed_committed_record,
)

pytestmark = pytest.mark.integration
pytest_plugins = ("tests.catalog.dynamic_field_support", "tests.auth.session_policy_support")


def test_registered_batch_requires_signed_live_identity_and_current_write_authority(
    policy_world,
    owned_ids,
):
    world = policy_world
    module = _seed_committed_module(owned_ids, fields=(("Title", FieldType.TEXT, 0, False, {}),))
    key = str(module.fields["Title"])
    record_id = _seed_committed_record(owned_ids, module.module_id, {key: "Before"})
    with Session(world.owner) as db:
        revision = db.get(Record, record_id).updated_at.isoformat()
    payload = {
        "module_id": str(module.module_id),
        "items": [
            {"record_id": str(record_id), "revision": revision, "field_id": key, "value": "Saved"}
        ],
    }
    try:
        for headers in (
            {},
            world.headers(exp=0),
            world.headers(aud="wrong-audience"),
            {"Authorization": "Bearer invalid-token"},
        ):
            response = world.client.post("/api/records/batch-update", headers=headers, json=payload)
            assert response.status_code == 401, response.text
        with Session(world.owner) as db:
            db.get(User, world.actor_id).role = "member"
            db.commit()
        denied = world.client.post(
            "/api/records/batch-update", headers=world.headers(), json=payload
        )
        assert denied.status_code == 403, denied.text
        with Session(world.owner) as db:
            db.get(User, world.actor_id).role = "admin"
            db.commit()
        saved = world.client.post(
            "/api/records/batch-update", headers=world.headers(), json=payload
        )
        assert saved.status_code == 200, saved.text
        assert saved.json()["results"][0]["record"]["data"] == {key: "Saved"}
        with Session(world.owner) as db:
            db.get(IdentitySession, world.session_ids[0]).revoked_at = world.clock
            db.commit()
        revoked = world.client.post(
            "/api/records/batch-update", headers=world.headers(), json=payload
        )
        assert revoked.status_code == 401, revoked.text
        with Session(world.owner) as db:
            assert db.get(Record, record_id).data == {key: "Saved"}
    finally:
        # The auth fixture owns the actor/session; owned_ids cleanup owns this graph.
        # Remove any successful outbox row even when an assertion fails.
        from sqlalchemy import delete, select

        from app.systems.sandbox.record_triggers.models import RecordTriggerEvent

        with Session(world.owner) as db:
            owned_ids.update(
                db.scalars(
                    select(RecordTriggerEvent.id).where(RecordTriggerEvent.record_id == record_id)
                )
            )
            db.execute(delete(RecordTriggerEvent).where(RecordTriggerEvent.record_id == record_id))
            db.commit()
