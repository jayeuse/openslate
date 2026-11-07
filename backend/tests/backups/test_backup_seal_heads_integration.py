"""The bridge op that reads the audit chain heads for the backup (K27, S13)."""

import json

import pytest
from sqlalchemy import text

from app.core.database.session import AuditSession
from app.systems.manage.audit.seals import seal_audit
from operations import backup_state
from tests.audit.seal_support import SealWorld, add_audit_row, hour_of
from tests.audit.seal_support import world as world
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration


def test_the_bridge_returns_the_latest_seal_of_each_chain_as_the_runtime(
    world: SealWorld,
) -> None:
    with world.engines.owner.begin() as connection:
        add_audit_row(connection, hour_of(1, 1), world.first)
        # Starts the installation chain here, whatever rows other tests left.
        add_audit_row(connection, hour_of(1, 0), None)
    seal_audit(world.engines.runtime, now=hour_of(1, 6))
    with world.engines.owner.connect() as connection:
        stored = {
            org_id: chain.hex()
            for org_id, chain in connection.execute(
                text(
                    "SELECT org_id, chain_hash FROM public.audit_seals "
                    "WHERE hour_start = '2001-01-01 03:00+00'"
                )
            )
        }
    command = backup_state.COMMAND_ADAPTER.validate_json(
        json.dumps({"op": "audit-seal-heads", "installation_id": "client-a", "project": "client-a"})
    )

    with AuditSession(bind=world.engines.runtime) as db:
        heads = backup_state.execute(db, command)["heads"]
        db.rollback()

    mine = {
        head["org_id"]: head
        for head in heads
        if head["org_id"] in {str(world.first), str(world.second), None}
    }
    assert mine == {
        str(org_id) if org_id else None: {
            "org_id": str(org_id) if org_id else None,
            "hour_start": "2001-01-01T03:00:00+00:00",
            "chain_hash": stored[org_id],
            "row_count": 0,
        }
        for org_id in (world.first, world.second, None)
    }
    assert list(heads[-1]) == ["org_id", "hour_start", "chain_hash", "row_count"]
