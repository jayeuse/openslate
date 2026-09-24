"""Best-effort post-commit PostgreSQL invalidation publication."""

import logging
from collections.abc import Iterable

import psycopg

from app.core.config import get_settings
from app.core.observability import log_event
from app.systems.platform.events.hub import CHANNEL, _psycopg_url
from app.systems.platform.events.models import InvalidationEvent, resync_event

MAX_INVALIDATIONS_PER_COMMIT = 64


def publish_invalidations(events: Iterable[InvalidationEvent]) -> bool:
    """Publish one committed transaction's deduplicated invalidations on one connection."""

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
        database_url = _psycopg_url(settings.database_url)
        with psycopg.connect(
            database_url,
            autocommit=True,
            connect_timeout=settings.database_connect_timeout_seconds,
            options=f"-c statement_timeout={settings.database_statement_timeout_ms}",
        ) as connection:
            for event in unique_events:
                connection.execute("SELECT pg_notify(%s, %s)", (CHANNEL, event.to_transport_json()))
    except psycopg.Error:
        log_event(
            "realtime_invalidation_failure",
            level=logging.WARNING,
            reason_code="publish_failed",
            upstream="postgresql",
        )
        return False
    return True


def publish_invalidation(event: InvalidationEvent) -> bool:
    """Publish one event for callers outside the audit transaction listener."""

    return publish_invalidations((event,))
