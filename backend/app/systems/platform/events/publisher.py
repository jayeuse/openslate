"""Best-effort post-commit PostgreSQL invalidation publication."""

import logging
from collections.abc import Iterable
from dataclasses import replace
from uuid import UUID

import psycopg

from app.core.config import get_settings
from app.core.observability import failure_cause, log_event
from app.systems.platform.events.hub import CHANNEL, _psycopg_url
from app.systems.platform.events.models import InvalidationEvent, resync_event

MAX_INVALIDATIONS_PER_COMMIT = 64


def publish_invalidations(
    events: Iterable[InvalidationEvent], *, database_url: str | None = None
) -> bool:
    """Publish one committed transaction's deduplicated invalidations on one connection.

    ``database_url`` is the database the transaction committed to; a session bound to
    another database than the configured one must not notify the configured one.
    """

    unique_events = tuple(dict.fromkeys(events))
    public_events = tuple(event for event in unique_events if event.recipient_id is None)
    private_events = tuple(event for event in unique_events if event.recipient_id is not None)
    if len(public_events) > MAX_INVALIDATIONS_PER_COMMIT:
        public_events = (resync_event(),)
    if len(private_events) > MAX_INVALIDATIONS_PER_COMMIT:
        # Recipient-specific invalidations are best effort; never turn them into
        # a resync signal visible to another recipient.
        private_events = ()
    unique_events = public_events + private_events
    if not unique_events:
        return True

    try:
        settings = get_settings()
        with psycopg.connect(
            _psycopg_url(database_url or settings.database_url),
            autocommit=True,
            connect_timeout=settings.database_connect_timeout_seconds,
            options=f"-c statement_timeout={settings.database_statement_timeout_ms}",
        ) as connection:
            account_ids = {
                event.account_id or event.entity_id
                for event in unique_events
                if event.org_id is None and event.recipient_id is None
                and (event.account_id is not None or event.entity == "users")
            } - {None}
            organizations: dict[UUID, list[UUID]] = {}
            if account_ids:
                for account_id, org_id in connection.execute(
                    "SELECT user_id, org_id FROM public.memberships WHERE user_id = ANY(%s)",
                    (list(account_ids),),
                ).fetchall():
                    organizations.setdefault(account_id, []).append(org_id)
            for event in unique_events:
                account_id = event.account_id or (
                    event.entity_id if event.entity == "users" and event.org_id is None else None
                )
                routed = (
                    tuple(replace(event, org_id=org_id, account_id=None)
                          for org_id in organizations.get(account_id, []))
                    if account_id is not None and event.org_id is None else (event,)
                )
                for invalidation in routed:
                    connection.execute(
                        "SELECT pg_notify(%s, %s)", (CHANNEL, invalidation.to_transport_json()),
                    )
    except psycopg.Error as error:
        log_event(
            "realtime_invalidation_failure",
            level=logging.WARNING,
            reason_code="publish_failed",
            upstream="postgresql",
            cause=failure_cause(error),
        )
        return False
    return True


def publish_invalidation(event: InvalidationEvent) -> bool:
    """Publish one event for callers outside the audit transaction listener."""

    return publish_invalidations((event,))
