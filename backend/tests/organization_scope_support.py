"""Keep overridden request actors inside their organization's row-level security scope.

The real current-user and current-identity dependencies resolve the membership and
bind the request transaction to its organization. A test that overrides them skips
that step, so wrap the override with ``scoped_override`` to bind the actor's
organization the same way.
"""

from __future__ import annotations

import contextvars
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

from fastapi import Depends
from sqlalchemy import Connection, Engine, event, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import ORGANIZATION_SCOPE_KEY, scope_session
from app.core.database.session import get_db
from app.systems.access.users.membership import (
    current_membership,
    organization_required,
    remember_membership,
)
from app.systems.access.users.models import Membership, User


def actor_organization(db: Session, user_id: UUID) -> UUID | None:
    """The organization of the actor's only active membership, else of its only membership."""

    rows = db.execute(
        select(Membership.org_id, Membership.status).where(
            Membership.user_id == user_id, Membership.is_deleted.is_(False)
        ).limit(3)
    ).all()
    active = [org_id for org_id, status in rows if status == "active"]
    if len(active) == 1:
        return active[0]
    return rows[0].org_id if len(rows) == 1 else None


def scoped_override(
    original: Callable[..., Any],
    *,
    org_id: UUID | None = None,
    membership: Membership | None = None,
) -> Callable[..., Any]:
    """Wrap a current-user or current-identity override like the real dependency.

    The request is bound to the actor's organization (or ``org_id``), and an actor
    without an eligible membership there is refused with ``organization_required``,
    as production refuses it. ``membership`` supplies an already loaded, detached
    membership so statement-budget tests do not count the authentication read.
    """

    # Defaults, not Annotated: string annotations cannot resolve the closure's ``original``.
    def dependency(db: Session = Depends(get_db), value: Any = Depends(original)) -> Any:  # noqa: B008
        user = getattr(value, "user", value)
        user_id = getattr(user, "id", None)
        # Mocked sessions (``Mock(spec=Session)``) have no real info and no database.
        real = isinstance(db, Session) and isinstance(db.info, dict)
        if not real or not isinstance(user_id, UUID):
            return value
        if membership is not None:
            merged = db.merge(membership, load=False)
            scope_session(db, merged.org_id)
            remember_membership(db, merged)
            return value
        scope_session(db, org_id or actor_organization(db, user_id))
        if isinstance(user, User) and current_membership(db, user) is None:
            raise organization_required()
        return value

    return dependency


# Unit tests run without a database; their sessions are bound to this organization.
UNIT_ORGANIZATION_ID = UUID("01a14400-0000-7000-8000-00000000c0de")


# The organization a test created applies to raw connections on the test's own threads.
# It is keyed by thread, not by context variable: TestClient copies context variables
# into request handling, and a request must bind its organization the production way.
_bound_threads: dict[int, UUID] = {}


@contextmanager
def organization_bindings() -> Iterator[None]:
    """Forget every thread binding when the test ends."""

    try:
        yield
    finally:
        _bound_threads.clear()


def bind_test_organization(org_id: UUID) -> None:
    """Bind raw connections and direct worker calls on this thread to ``org_id``."""

    _bound_threads[threading.get_ident()] = org_id


def scope_like_a_request(db: Session) -> None:
    """Bind an unscoped test session to the organization this test thread created last."""

    org_id = _bound_threads.get(threading.get_ident())
    if org_id is not None and not isinstance(db.info.get(ORGANIZATION_SCOPE_KEY), UUID):
        scope_session(db, org_id)


def _apply_test_scope(connection: Connection) -> None:
    org_id = _bound_threads.get(threading.get_ident())
    if org_id is not None:
        connection.exec_driver_sql(
            "SELECT set_config('openslate.org_id', %(org_id)s, true)", {"org_id": str(org_id)}
        )


if not event.contains(Engine, "begin", _apply_test_scope):
    event.listen(Engine, "begin", _apply_test_scope)


def in_context(function: Callable[..., Any]) -> Callable[..., Any]:
    """Run ``function`` in another thread with this thread's context and binding."""

    context = contextvars.copy_context()
    org_id = _bound_threads.get(threading.get_ident())

    def run(*args: Any, **kwargs: Any) -> Any:
        thread = threading.get_ident()
        previous = _bound_threads.get(thread)
        if org_id is not None:
            _bound_threads[thread] = org_id
        try:
            return context.run(function, *args, **kwargs)
        finally:
            if previous is None:
                _bound_threads.pop(thread, None)
            else:
                _bound_threads[thread] = previous

    return run
