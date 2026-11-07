"""Shared rows, organizations and seal reads for the audit seal tests.

Every row and organization is in 2001, before any other test's data, so the installation
chain starts at these rows and the controlled clock decides what is sealable.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import Connection, text
from uuid6 import uuid7

from app.systems.manage.workspace.models import WorkspaceProfile
from tests.migrations.audit_partition_support import AuditEngines

DAY = datetime(2001, 1, 1, tzinfo=UTC)
CREATED = DAY + timedelta(minutes=30)


@dataclass(frozen=True)
class SealWorld:
    engines: AuditEngines
    first: UUID
    second: UUID


def add_audit_row(
    connection: Connection, created_at: datetime, org_id: UUID | None, **values: object
) -> UUID:
    """The owner adds a row the way the application writes one; no seal sees it yet."""

    row_id = values.pop("id", None) or uuid7()
    connection.execute(
        text(
            "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type, "
            "entity_id, before, after) VALUES (:id, :org, :created_at, 'update', :entity_type, "
            ":entity_id, CAST(:before AS jsonb), CAST(:after AS jsonb))"
        ),
        {
            "id": row_id,
            "org": org_id,
            "created_at": created_at,
            "entity_type": "records" if org_id else "users",
            "entity_id": values.get("entity_id", uuid7()),
            "before": values.get("before"),
            "after": values.get("after", '{"name": "row"}'),
        },
    )
    return row_id


@pytest.fixture
def world(audit_engines: AuditEngines) -> Iterator[SealWorld]:
    """Two organizations created on 2001-01-01 at 00:30 UTC, and nothing sealed."""

    first, second = uuid7(), uuid7()
    with audit_engines.owner.begin() as connection:
        for org_id in (first, second):
            connection.execute(
                WorkspaceProfile.__table__.insert().values(
                    id=org_id, slug=f"seal-{org_id}", display_name="Seal", timezone="UTC",
                    locale="en-US", created_at=CREATED, updated_at=CREATED,
                )
            )
    try:
        yield SealWorld(audit_engines, first, second)
    finally:
        remove_chains(audit_engines, [first, second])


def remove_chains(engines: AuditEngines, organizations: list[UUID]) -> None:
    """Remove the organizations, their rows and seals, and the 2001 installation chain."""

    ids = {"orgs": organizations, "end": datetime(2002, 1, 1, tzinfo=UTC)}
    with engines.owner.begin() as connection:
        for table, moment in (("audit_seals", "hour_start"), ("audit_logs", "created_at")):
            connection.execute(
                text(
                    f"DELETE FROM public.{table} WHERE org_id = ANY(:orgs) "
                    f"OR (org_id IS NULL AND {moment} < :end)"
                ),
                ids,
            )
        connection.execute(text("DELETE FROM public.organizations WHERE id = ANY(:orgs)"), ids)


def sealed_hours(engines: AuditEngines, org_id: UUID | None) -> dict[datetime, int]:
    chain = "org_id = :org" if org_id else "org_id IS NULL AND hour_start < '2002-01-01'"
    with engines.owner.connect() as connection:
        rows = connection.execute(
            text(f"SELECT hour_start, row_count FROM public.audit_seals WHERE {chain}"),
            {"org": org_id},
        )
        return {hour.astimezone(UTC): count for hour, count in rows}


def hour_of(day: int, hour: int) -> datetime:
    return datetime(2001, 1, day, hour, tzinfo=UTC)
