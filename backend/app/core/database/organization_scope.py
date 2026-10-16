"""Bind each database transaction to one organization for PostgreSQL row-level security.

Row-level security policies read the transaction-local setting ``openslate.org_id``.
A request stores its resolved organization on the session; a background worker
binds one organization for each pass of its loop. The setting is applied with
``is_local => true`` at the start of every transaction, so it never outlives the
transaction or leaks to the next user of a pooled connection. A transaction
without an organization reads no organization rows.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any
from uuid import UUID

from sqlalchemy import Connection, event, text
from sqlalchemy.orm import Session

ORGANIZATION_SCOPE_KEY = "openslate.org_id"
_SET_SCOPE = text("SELECT set_config('openslate.org_id', :org_id, true)")
_worker_organization: ContextVar[UUID | None] = ContextVar(
    "openslate_worker_organization", default=None
)


def apply_connection_scope(connection: Connection, org_id: UUID | None) -> None:
    """Set the organization for the connection's current transaction."""

    connection.execute(_SET_SCOPE, {"org_id": "" if org_id is None else str(org_id)})


def current_worker_organization() -> UUID | None:
    """The organization the current worker pass is bound to, if any."""

    return _worker_organization.get()


def session_organization(session: Session) -> UUID | None:
    """The organization this session's transactions are bound to, if any."""

    org_id = session.info.get(ORGANIZATION_SCOPE_KEY)
    return org_id if isinstance(org_id, UUID) else _worker_organization.get()


def scope_session(session: Session, org_id: UUID | None) -> None:
    """Bind the session's current and later transactions to one organization."""

    session.info[ORGANIZATION_SCOPE_KEY] = org_id
    if session.in_transaction():
        apply_connection_scope(session.connection(), org_id)


@contextmanager
def worker_organization(org_id: UUID) -> Iterator[None]:
    """Bind sessions that a worker opens on this thread to one organization."""

    token = _worker_organization.set(org_id)
    try:
        yield
    finally:
        _worker_organization.reset(token)


def _apply_on_begin(session: Session, _transaction: Any, connection: Connection) -> None:
    org_id = session_organization(session)
    if org_id is not None:
        apply_connection_scope(connection, org_id)


def register(session_class: type[Session]) -> None:
    """Apply the bound organization whenever the session begins a transaction."""

    if not event.contains(session_class, "after_begin", _apply_on_begin):
        event.listen(session_class, "after_begin", _apply_on_begin)
