"""Authenticated server-sent events for cache invalidation only."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.exc import SQLAlchemyError
from starlette.responses import StreamingResponse
from starlette.types import Send

from app.core.config import get_settings
from app.core.config.development import browser_origin_is_permitted
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase_auth import (
    InvalidProviderToken,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.mfa import MFARequired, requires_mfa
from app.systems.access.identity.provider_sessions import resolve_provider_session
from app.systems.access.identity.provider_user_cache import recent_provider_user
from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import allowed_module_ids
from app.systems.access.users.membership import current_membership, is_platform_operator
from app.systems.boards.access import readable_board_ids
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import ip_allowed, load_workspace_policy
from app.systems.platform.events.hub import (
    EventHub,
    EventSubscription,
    EventViewer,
    SubscriberLimitReached,
)

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
    client_ip: str | None = None
    # The organization the stream asked for; None means the session's active organization.
    org_id: UUID | None = None


def get_event_principal(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    org: UUID | None = None,
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
    return EventPrincipal(raw_token, request.client.host if request.client else None, org)


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
    principal = replace(principal, org_id=user.org_id)
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
    reauthorize: Callable[[EventPrincipal], Awaitable[EventViewer | None]] | None = None,
    initial_user: EventViewer | None = None,
    subscription: EventSubscription | None = None,
) -> AsyncIterator[bytes]:
    """Send resyncs while reauthorizing outside the request session lifetime."""

    check_identity = reauthorize or reauthorize_event_principal

    async def checked_identity() -> EventViewer | None:
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
        principal = replace(principal, org_id=user.org_id)
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


async def reauthorize_event_principal(principal: EventPrincipal) -> EventViewer | None:
    """Validate identity and readable scopes using a short-lived DB session."""

    return await asyncio.to_thread(_reauthorize_in_database, principal)


def _reauthorize_in_database(principal: EventPrincipal) -> EventViewer | None:
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
            if resolved is None:
                return None
            user, identity_session = resolved
            # The stream stays bound to the organization it opened in (D16); every
            # re-check enters that organization again with its MFA and network rules.
            org_id = principal.org_id or identity_session.active_org_id
            if org_id is None:
                return None
            organization = db.get(WorkspaceProfile, org_id)
            if organization is None or organization.is_deleted:
                return None
            if not ip_allowed(load_workspace_policy(db, org_id=org_id), principal.client_ip):
                raise HTTPException(
                    status_code=403,
                    detail={
                        "code": "ip_not_allowed",
                        "message": "Access from this address is not allowed",
                    },
                )
            scope_session(db, org_id)
            membership = current_membership(db, user)
            if membership is None:
                return None
            provider_id = user.supabase_user_id
            provider_user = (
                (recent_provider_user(provider_id) or client.get_admin_user(provider_id))
                if provider_id is not None else None
            )
            if provider_user is None or (
                requires_mfa(organization, membership, provider_user)
                and claims.assurance_level != "aal2"
            ):
                return None
            return EventViewer(
                user_id=user.id,
                role=membership.role,
                module_ids=allowed_module_ids(db, user, AccessLevel.READ),
                board_ids=readable_board_ids(db, user),
                org_id=org_id,
                operator=is_platform_operator(db, user.id),
            )
    except MFARequired as error:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "mfa_required",
                "message": "Complete multi-factor authentication to continue",
            },
        ) from error
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        raise HTTPException(status_code=503, detail="Event authorization unavailable") from error


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
