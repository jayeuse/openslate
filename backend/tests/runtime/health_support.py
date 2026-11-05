"""Committed rows for the S5 and S6 PostgreSQL tests, removed again by the owner role.

The sampler, the signal writer, the error log and the support file of the installation
owner each open their own sessions, so their tests need committed rows. Every helper here
writes through the owner role and returns what it made, so each test removes exactly that.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from uuid import UUID

from sqlalchemy import Engine, text
from uuid6 import uuid7

from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import guarded_pooled_engine

SAMPLE_COLUMNS = (
    "sampled_at", "data_status", "data_ms", "signing_in_status", "signing_in_ms",
    "files_status", "files_ms", "email_status", "database_bytes",
)


def owner_engine() -> Engine:
    return guarded_pooled_engine(os.environ["MIGRATION_DATABASE_URL"])


def runtime_engine() -> Engine:
    return guarded_pooled_engine(os.environ["TEST_DATABASE_URL"])


def clear_samples() -> None:
    """Samples are installation-wide and only tests write them in the test stack."""

    with owner_engine().begin() as connection:
        connection.execute(text("DELETE FROM public.system_health_samples"))


def add_sample(at: datetime, **values: object) -> None:
    row: dict[str, object] = {
        "sampled_at": at, "data_status": "working", "data_ms": 20,
        "signing_in_status": "working", "signing_in_ms": 30, "files_status": "working",
        "files_ms": 40, "email_status": "set_up", "database_bytes": None, **values,
    }
    with owner_engine().begin() as connection:
        connection.execute(
            text(
                f"INSERT INTO public.system_health_samples ({', '.join(SAMPLE_COLUMNS)}) "
                f"VALUES ({', '.join(':' + name for name in SAMPLE_COLUMNS)})"
            ),
            row,
        )


def sample_rows() -> list[tuple]:
    with owner_engine().connect() as connection:
        return [
            tuple(row)
            for row in connection.execute(
                text(
                    f"SELECT {', '.join(SAMPLE_COLUMNS)} FROM public.system_health_samples "
                    "ORDER BY sampled_at"
                )
            )
        ]


@contextmanager
def kept_signals() -> Iterator[None]:
    """Restore the six signal rows after a test that moves them."""

    with owner_engine().connect() as connection:
        before = dict(
            connection.execute(text("SELECT key, last_seen_at FROM public.system_health_signals"))
            .tuples()
            .all()
        )
    try:
        yield
    finally:
        with owner_engine().begin() as connection:
            for key, seen in before.items():
                connection.execute(
                    text("UPDATE public.system_health_signals SET last_seen_at = :seen "
                         "WHERE key = :key"),
                    {"key": key, "seen": seen},
                )


def set_signals(**seen: datetime | None) -> None:
    with owner_engine().begin() as connection:
        for key, moment in seen.items():
            connection.execute(
                text("UPDATE public.system_health_signals SET last_seen_at = :seen "
                     "WHERE key = :key"),
                {"key": key, "seen": moment},
            )


def committed_organization(label: str) -> UUID:
    org_id = uuid7()
    with owner_engine().begin() as connection:
        connection.execute(WorkspaceProfile.__table__.insert().values(
            id=org_id, slug=f"health-{label}-{org_id}", display_name=f"Health {label}",
            timezone="UTC", locale="en-US",
        ))
    return org_id


def add_server_error(
    request_id: UUID, *, org_id: UUID | None, occurred_at: datetime,
    status: int = 500, route: str = "/api/records/{record_id}",
) -> None:
    with owner_engine().begin() as connection:
        connection.execute(
            text(
                "INSERT INTO public.server_errors "
                "(request_id, occurred_at, status, method, route, org_id) "
                "VALUES (:request_id, :occurred_at, :status, 'GET', :route, :org_id)"
            ),
            {"request_id": request_id, "occurred_at": occurred_at, "status": status,
             "route": route, "org_id": org_id},
        )


def remove_organizations(*org_ids: UUID) -> None:
    """Delete the organizations and every row these tests attach to them."""

    with owner_engine().begin() as connection:
        ids = {"ids": list(org_ids)}
        for table in ("server_errors", "files", "memberships"):
            connection.execute(text(f"DELETE FROM public.{table} WHERE org_id = ANY(:ids)"), ids)
        connection.execute(text("DELETE FROM public.organizations WHERE id = ANY(:ids)"), ids)


def remove_server_errors(*request_ids: UUID) -> None:
    with owner_engine().begin() as connection:
        connection.execute(
            text("DELETE FROM public.server_errors WHERE request_id = ANY(:ids)"),
            {"ids": list(request_ids)},
        )


def server_error_rows(*request_ids: UUID) -> list[tuple]:
    with owner_engine().connect() as connection:
        return [
            tuple(row)
            for row in connection.execute(
                text(
                    "SELECT request_id, status, method, route, org_id FROM public.server_errors "
                    "WHERE request_id = ANY(:ids) ORDER BY occurred_at, request_id"
                ),
                {"ids": list(request_ids)},
            )
        ]


def written_counts() -> tuple[int, int]:
    """Committed audit rows and security events of the whole installation."""

    with owner_engine().connect() as connection:
        return (
            int(connection.scalar(text("SELECT count(*) FROM public.audit_logs")) or 0),
            int(connection.scalar(text("SELECT count(*) FROM public.security_events")) or 0),
        )
