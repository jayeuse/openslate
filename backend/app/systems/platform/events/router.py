"""Authenticated server-sent events for cache invalidation only."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.exc import SQLAlchemyError
from starlette.responses import StreamingResponse
from starlette.types import Send

from app.core.config import get_settings
from app.core.config.development import browser_origin_is_permitted
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase_auth import (
    InvalidProviderToken,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.provider_sessions import resolve_provider_session
from app.systems.access.users.models import User
from app.systems.platform.events.hub import EventHub, EventSubscription, SubscriberLimitReached

router = APIRouter(prefix="/events", tags=["events"])
_HEARTBEAT_SECONDS = 15.0
_SEND_TIMEOUT_SECONDS = 15.0
_bearer = HTTPBearer(auto_error=False)


class BoundedSSEStreamingResponse(StreamingResponse):
    """Close a stalled stream so its generator can release its subscriber slot."""

    def __init__(
        self,
        *args: Any,
        send_timeout_seconds: float = _SEND_TIMEOUT_SECONDS,
        on_close: Callable[[], Awaitable[None]] | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._send_timeout_seconds = send_timeout_seconds
        self._on_close = on_close

    async def stream_response(self, send: Send) -> None:
        try:
            await self._send_with_timeout(
                send,
                {
                    "type": "http.response.start",
                    "status": self.status_code,
                    "headers": self.raw_headers,
                },
            )
            async for chunk in self.body_iterator:
                if not isinstance(chunk, bytes | memoryview):
                    chunk = chunk.encode(self.charset)
                await self._send_with_timeout(
                    send,
                    {"type": "http.response.body", "body": chunk, "more_body": True},
                )
            await self._send_with_timeout(
                send,
                {"type": "http.response.body", "body": b"", "more_body": False},
            )
        except TimeoutError:
            return
        finally:
            try:
                close = getattr(self.body_iterator, "aclose", None)
                if callable(close):
                    await close()
            finally:
                if self._on_close is not None:
                    await self._on_close()

    async def _send_with_timeout(self, send: Send, message: dict[str, object]) -> None:
        await asyncio.wait_for(send(message), timeout=self._send_timeout_seconds)


@dataclass(frozen=True, slots=True)
class EventPrincipal:
    access_token: str


def get_event_principal(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> EventPrincipal:
    cookie_token = request.cookies.get("openslate_access")
    bearer_token = bearer.credentials if bearer is not None else None
    if bool(cookie_token) == bool(bearer_token):
        raise _unauthorized()
    if cookie_token is not None:
        origin = request.headers.get("origin")
        fetch_site = request.headers.get("sec-fetch-site")
        settings = get_settings()
        if (
            request.headers.get("authorization") is not None
            or (origin is None and fetch_site is None)
            or (fetch_site is None and origin != settings.public_origin)
            or (origin is not None and not browser_origin_is_permitted(settings, origin))
            or (fetch_site is not None and fetch_site != "same-origin")
        ):
            raise _unauthorized()
    raw_token = cookie_token or bearer_token
    if raw_token is None:
        raise _unauthorized()
    try:
        get_supabase_auth_client().verify_access_token(raw_token)
    except InvalidProviderToken as error:
        raise _unauthorized() from error
    except SupabaseAuthUnavailable as error:
        raise HTTPException(status_code=503, detail="Event authorization unavailable") from error
    return EventPrincipal(raw_token)


@router.get("")
async def events(
    request: Request,
    principal: Annotated[EventPrincipal, Depends(get_event_principal)],
) -> StreamingResponse:
    hub = request.app.state.events_hub
    if not isinstance(hub, EventHub):
        raise RuntimeError("event hub is not configured")
    user = await reauthorize_event_principal(principal)
    if user is None:
        raise _unauthorized()
    try:
        subscription = await hub.subscribe(user)
    except SubscriberLimitReached:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many event streams",
        ) from None
    return BoundedSSEStreamingResponse(
        event_stream(request, hub, principal, initial_user=user, subscription=subscription),
        media_type="text/event-stream",
        send_timeout_seconds=_SEND_TIMEOUT_SECONDS,
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
        on_close=lambda: hub.unsubscribe(subscription),
    )


async def event_stream(
    request: Request,
    hub: EventHub,
    principal: EventPrincipal,
    *,
    heartbeat_seconds: float = _HEARTBEAT_SECONDS,
    reauthorize: Callable[[EventPrincipal], Awaitable[object | None]] | None = None,
    initial_user: object | None = None,
    subscription: EventSubscription | None = None,
) -> AsyncIterator[bytes]:
    """Send resyncs while reauthorizing outside the request session lifetime."""

    check_identity = reauthorize or reauthorize_event_principal

    async def checked_identity() -> object | None:
        try:
            return await check_identity(principal)
        except HTTPException:
            # Headers are already sent; close the stream on an outage.
            return None

    active_subscription = subscription
    try:
        user = initial_user if initial_user is not None else await checked_identity()
        if user is None:
            return
        if active_subscription is None:
            try:
                active_subscription = await hub.subscribe(user)
            except SubscriberLimitReached:
                return
        yield b"event: resync\ndata: {}\n\n"
        while not await request.is_disconnected():
            try:
                event = await asyncio.wait_for(active_subscription.queue.get(), heartbeat_seconds)
            except TimeoutError:
                user = await checked_identity()
                if user is None:
                    return
                if hub.refresh_subscription(active_subscription, user):
                    yield b"event: resync\ndata: {}\n\n"
                    continue
                yield b": heartbeat\n\n"
                continue
            if active_subscription.closed:
                return
            if event is None:
                user = await checked_identity()
                if user is None:
                    return
                hub.refresh_subscription(active_subscription, user)
                yield b"event: resync\ndata: {}\n\n"
                continue
            user = await checked_identity()
            if user is None:
                return
            if hub.refresh_subscription(active_subscription, user):
                yield b"event: resync\ndata: {}\n\n"
                continue
            if not hub.can_receive(active_subscription, event):
                continue
            yield f"event: invalidate\ndata: {event.to_json()}\n\n".encode()
    finally:
        if active_subscription is not None:
            await hub.unsubscribe(active_subscription)


async def reauthorize_event_principal(principal: EventPrincipal) -> User | None:
    """Validate token, user, role, and session using a short-lived DB session."""

    return await asyncio.to_thread(_reauthorize_in_database, principal)


def _reauthorize_in_database(principal: EventPrincipal) -> User | None:
    client = get_supabase_auth_client()
    try:
        claims = client.verify_access_token(principal.access_token)
    except InvalidProviderToken:
        return None
    except SupabaseAuthUnavailable as error:
        raise HTTPException(status_code=503, detail="Event authorization unavailable") from error
    try:
        with AuditSession(get_engine()) as db:
            resolved = resolve_provider_session(db, claims, client)
            return resolved[0] if resolved is not None else None
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        raise HTTPException(status_code=503, detail="Event authorization unavailable") from error


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
