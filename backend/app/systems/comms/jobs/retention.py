"""Versioned D17 policy; preview and update each require independent fresh password proof."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy import false, func, or_, select, text, true
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error, require_conversation_access
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.jobs.models import CommsRetentionPolicy
from app.systems.comms.jobs.protected import admin, password_admin
from app.systems.comms.jobs.schemas import (
    ChannelScope,
    RetentionPolicy,
    RetentionPreview,
    RetentionPreviewRequest,
    RetentionQuery,
    RetentionResponse,
    RetentionUpdate,
    WorkspaceScope,
)
from app.systems.comms.messages.link_models import CommsMessageAttachment
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.moderation.service import match
from app.systems.comms.realtime.events import organization_event
from app.systems.platform.files.models import File
from app.systems.sandbox.lifecycle.exceptions import LifecycleError
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
router = APIRouter(
    prefix="/comms/retention", tags=["comms"], dependencies=[Depends(get_current_membership)]
)


def lock_policy(db: Session) -> None:
    db.connection().execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"comms:retention:{bound_organization(db)}"},
    )


def scope_id(scope: WorkspaceScope | ChannelScope) -> UUID | None:
    return scope.id if isinstance(scope, ChannelScope) else None


def rows(db: Session) -> dict[UUID | None, CommsRetentionPolicy]:
    return {
        row.conversation_id: row
        for row in db.scalars(
            select(CommsRetentionPolicy)
            .where(
                CommsRetentionPolicy.org_id == bound_organization_column(),
                CommsRetentionPolicy.is_deleted.is_(False),
            )
            .execution_options(populate_existing=True)
        )
    }


def resolve(
    db: Session, scope: WorkspaceScope | ChannelScope, proposed: RetentionPolicy | None = None
) -> RetentionResponse:
    current = rows(db)
    workspace, local = current.get(None), current.get(scope_id(scope))
    policy = proposed or RetentionPolicy(
        scope=scope,
        message_days=local.message_days if local else (0 if scope.kind == "workspace" else None),
        file_days=local.file_days if local else (0 if scope.kind == "workspace" else None),
    )
    effective, sources = {}, {}
    for field in ("message_days", "file_days"):
        value = getattr(policy, field)
        effective[field] = (
            value if value is not None else (getattr(workspace, field) if workspace else 0)
        )
        sources[field] = scope.kind if value is not None else "workspace"
    return RetentionResponse.model_validate(
        {"policy": policy, "effective": effective, "sources": sources}
    )


def version(db: Session, scope: WorkspaceScope | ChannelScope) -> str:
    current = rows(db)
    selected = [current[key] for key in {None, scope_id(scope)} if key in current]
    state = {
        "org": str(bound_organization(db)),
        "scope": scope.model_dump(mode="json"),
        "rows": sorted(
            [(str(row.id), row.revision, row.message_days, row.file_days) for row in selected]
        ),
    }
    return '"' + hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest() + '"'


def cutoff(now: datetime, days: int | None) -> datetime | None:
    if not days:
        return None
    try:
        return now - timedelta(days=days)
    except OverflowError:
        return datetime.min.replace(tzinfo=UTC)


def impact(db: Session, proposed: RetentionPolicy, now: datetime) -> tuple[int, int]:
    all_rows = rows(db)
    totals = [0, 0]
    for conversation in db.scalars(
        select(CommsConversation).where(
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.is_deleted.is_(False),
            CommsConversation.id == scope_id(proposed.scope)
            if proposed.scope.kind == "channel"
            else true(),
        )
    ):
        local = all_rows.get(conversation.id) if conversation.kind == "channel" else None
        workspace = all_rows.get(None)
        values = []
        for field in ("message_days", "file_days"):
            if proposed.scope.kind == "channel":
                value = getattr(proposed, field)
                value = (
                    value if value is not None else (getattr(workspace, field) if workspace else 0)
                )
            else:
                override = getattr(local, field) if local else None
                value = override if override is not None else getattr(proposed, field)
            values.append(cutoff(now, value))
        if values[0] is not None:
            totals[0] += (
                db.scalar(
                    select(func.count())
                    .select_from(CommsMessage)
                    .where(
                        CommsMessage.org_id == bound_organization_column(),
                        CommsMessage.conversation_id == conversation.id,
                        CommsMessage.created_at < values[0],
                        CommsMessage.retention_erased_at.is_(None),
                    )
                )
                or 0
            )
        expired_sources = select(CommsMessage.id).where(
            CommsMessage.org_id == bound_organization_column(),
            CommsMessage.conversation_id == conversation.id,
            CommsMessage.created_at < values[0] if values[0] is not None else false(),
        )
        attachment_ids = select(CommsMessageAttachment.file_id).where(
            CommsMessageAttachment.org_id == bound_organization_column(),
            CommsMessageAttachment.message_id.in_(expired_sources),
        )
        totals[1] += (
            db.scalar(
                select(func.count())
                .select_from(File)
                .where(
                    File.org_id == bound_organization_column(),
                    File.conversation_id == conversation.id,
                    File.purpose == "comms_attachment",
                    File.state != "purged",
                    or_(
                        File.created_at < values[1] if values[1] is not None else false(),
                        File.id.in_(attachment_ids),
                    ),
                )
            )
            or 0
        )
    return totals[0], totals[1]


def _authorized_scope(db: Session, actor: User, scope: WorkspaceScope | ChannelScope) -> None:
    admin(db, actor)
    lock_policy(db)
    if isinstance(scope, ChannelScope):
        conversation = require_conversation_access(db, actor, scope.id, "read")
        if conversation.kind != "channel":
            raise error("comms_invalid_input", "Channel retention requires a channel", 422)


def _binding(db: Session, actor: User, proposal: RetentionPolicy, tag: str) -> str:
    return hashlib.sha256(
        json.dumps(
            {
                "purpose": "comms-retention-v1",
                "org": str(bound_organization(db)),
                "actor": str(actor.id),
                "proposal": proposal.model_dump(mode="json"),
                "etag": tag,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


@router.get("", response_model=RetentionResponse)
def get_policy(
    query: Annotated[RetentionQuery, Query()], db: DB, actor: Actor, http: Response
) -> RetentionResponse:
    scope = (
        ChannelScope(kind="channel", id=query.channel_id)
        if query.channel_id
        else WorkspaceScope(kind="workspace")
    )
    _authorized_scope(db, actor, scope)
    private(http)
    http.headers["ETag"] = version(db, scope)
    return resolve(db, scope)


@router.post("/preview", response_model=RetentionPreview)
def preview(
    payload: RetentionPreviewRequest, db: DB, actor: Actor, http: Response, if_match: Match = None
) -> RetentionPreview:
    proposal = RetentionPolicy.model_validate(payload.model_dump(exclude={"password"}))
    _authorized_scope(db, actor, proposal.scope)
    match(if_match, version(db, proposal.scope))
    actor = password_admin(db, actor, payload.password)
    _authorized_scope(db, actor, proposal.scope)
    tag = version(db, proposal.scope)
    match(if_match, tag)
    messages, files = impact(db, proposal, utc_now())
    value = resolve(db, proposal.scope, proposal)
    try:
        issued = issue_challenge(
            db,
            actor.id,
            "purge",
            "comms_retention",
            scope_id(proposal.scope) or bound_organization(db),
            _binding(db, actor, proposal, tag),
            hex_token=True,
        )
    except LifecycleError as exc:
        raise error("comms_conflict", "Preview is unavailable", int(exc.status_code)) from exc
    private(http)
    return RetentionPreview(
        **value.model_dump(),
        message_count=messages,
        file_count=files,
        preview_digest=issued.token,
        expires_at=issued.expires_at,
    )


@router.put("", response_model=RetentionResponse)
def update(
    payload: RetentionUpdate, db: DB, actor: Actor, http: Response, if_match: Match = None
) -> RetentionResponse:
    proposal = RetentionPolicy.model_validate(
        payload.model_dump(exclude={"password", "preview_digest"})
    )
    with transaction(db):
        _authorized_scope(db, actor, proposal.scope)
        tag = version(db, proposal.scope)
        match(if_match, tag)
        target = scope_id(proposal.scope) or bound_organization(db)
        try:
            expected = challenge_impact_digest(
                db, payload.preview_digest, actor.id, "purge", "comms_retention", target
            )
            if expected != _binding(db, actor, proposal, tag):
                raise error("comms_conflict", "Preview does not match this proposal", 409)
            verify_challenge(
                db,
                payload.preview_digest,
                actor.id,
                "purge",
                "comms_retention",
                target,
                expected,
                actor.email,
                payload.password,
            )
        except LifecycleError as exc:
            raise error(
                "comms_fresh_admin_required" if exc.status_code == 403 else "comms_conflict",
                "Preview or password confirmation is unavailable",
                int(exc.status_code),
            ) from exc
        _authorized_scope(db, actor, proposal.scope)
        match(if_match, version(db, proposal.scope))
        row = rows(db).get(scope_id(proposal.scope))
        if row is None:
            row = CommsRetentionPolicy(
                org_id=bound_organization(db),
                conversation_id=scope_id(proposal.scope),
                author_id=actor.id,
                message_days=proposal.message_days,
                file_days=proposal.file_days,
            )
            db.add(row)
        else:
            if row.revision >= 2147483647:
                raise error("comms_conflict", "Policy version exhausted", 409)
            row.message_days, row.file_days, row.author_id = (
                proposal.message_days,
                proposal.file_days,
                actor.id,
            )
            row.revision += 1
        db.flush()
        value = resolve(db, proposal.scope)
        private(http)
        http.headers["ETag"] = version(db, proposal.scope)
        organization_event(db, "structure")
    return value
