"""Fresh self-only profile merge and committed avatar replacement cleanup."""

from contextlib import nullcontext
from datetime import timedelta
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import CurrentIdentity
from app.core.base_model import utc_now
from app.systems.access.policy.checks import require_live_session
from app.systems.access.policy.scope import effective_levels
from app.systems.access.users.membership import eligible_memberships, is_platform_operator
from app.systems.access.users.models import Membership, User
from app.systems.access.users.schemas import (
    AccountResponse,
    AuthMeResponse,
    DefaultOrganizationBlocked,
    SelfProfileUpdate,
)
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.files.access import error, fresh_user
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend, file_processing
from app.systems.platform.files.purge import (
    DeletionClaim,
    claim_avatar_replacement,
    delete_and_finalize,
)
from app.systems.platform.files.quota import lock_quota


def self_profile_response(
    db: Session, user: User, membership: Membership | None,
    default_organization_blocked: DefaultOrganizationBlocked | None = None,
) -> AuthMeResponse:
    account = AccountResponse.model_validate(user).model_dump()
    access = effective_levels(db, user, membership=membership).entries() if membership else []
    entries = [
        {"department_id": department_id, "module_id": module_id, "level": level}
        for department_id, module_id, level in access
    ]
    organizations = {org.id: org for org in db.scalars(select(WorkspaceProfile).join(
        Membership, Membership.org_id == WorkspaceProfile.id
    ).where(Membership.user_id == user.id, WorkspaceProfile.is_deleted.is_(False)))}
    def summary(row: Membership) -> dict[str, object]:
        org = organizations[row.org_id]
        return {"org_id": org.id, "name": org.display_name, "slug": org.slug, "role": row.role}
    pending = []
    for row in db.scalars(select(Membership).where(
        Membership.user_id == user.id, Membership.status == "pending",
        Membership.is_deleted.is_(False), Membership.invitation_sent_at.is_not(None),
        Membership.invitation_accepted_at.is_(None),
    ).order_by(Membership.org_id)):
        org = organizations.get(row.org_id)
        if org is None or row.invitation_sent_at is None:
            continue
        deadline = row.invitation_sent_at + timedelta(days=org.invitation_expiry_days)
        if deadline > utc_now() and (row.expires_at is None or row.expires_at > utc_now()):
            pending.append({**summary(row), "id": row.id, "expires_at": deadline})
    return AuthMeResponse.model_validate(
        {
            **account, "account": account,
            "memberships": [summary(row) for row in eligible_memberships(db, user.id)],
            "pending_invitations": pending,
            "current_organization": (
                {
                    **summary(membership), "access": entries,
                    "owner": organizations[membership.org_id].owner_user_id == user.id,
                }
                if membership else None
            ),
            "default_organization_blocked": default_organization_blocked,
            "role": membership.role if membership else None,
            "operator": is_platform_operator(db, user.id),
            "sponsor_user_id": membership.sponsor_user_id if membership else None,
            "expires_at": membership.expires_at if membership else None,
            "invitation_sent_at": membership.invitation_sent_at if membership else None,
            "access": entries,
        }
    )


def ready_avatar(file: File | None, owner_id: UUID) -> File:
    if file is None or file.purpose != "user_avatar" or file.creator_id != owner_id:
        raise error("file_not_found", "Avatar not found", 404)
    if (
        file.is_deleted
        or file.state != "ready"
        or file.operation_id is not None
        or not file.digest
        or file.actual_size is None
        or not 0 < file.actual_size <= 2097152
        or file.media_type not in {"image/png", "image/jpeg"}
    ):
        raise error("avatar_not_ready", "Avatar is not available")
    return file


def update_self_profile(
    db: Session,
    identity: CurrentIdentity,
    payload: SelfProfileUpdate,
    storage: StorageBackend,
    membership: Membership | None = None,
    default_organization_blocked: DefaultOrganizationBlocked | None = None,
) -> AuthMeResponse:
    avatar_supplied = "avatar_file_id" in payload.model_fields_set
    actor_id = identity.user.id
    claim: DeletionClaim | None = None
    if avatar_supplied:
        # The old avatar's Storage cleanup cannot be retried by the client, so wait for a slot.
        # End the authentication read first: a waiting save holds no pooled connection, and
        # the save rechecks the session and locks the person again in its own transaction.
        db.rollback()
    with file_processing() if avatar_supplied else nullcontext():
        try:
            if avatar_supplied:
                lock_quota(db, account=actor_id)
            require_live_session(db, actor_id=actor_id, session_id=identity.session_id)
            db.refresh(identity.user, with_for_update={"nowait": True} if avatar_supplied else True)
            actor = fresh_user(db, actor_id)
            old_id = actor.avatar_file_id
            if avatar_supplied and old_id != payload.avatar_file_id:
                ids = sorted(
                    {value for value in (old_id, payload.avatar_file_id) if value is not None}
                )
                files = {
                    file.id: file
                    for file in db.scalars(
                        select(File)
                        .where(File.id.in_(ids))
                        .order_by(File.id)
                        .with_for_update(nowait=True)
                        .execution_options(populate_existing=True)
                    )
                }
                if payload.avatar_file_id is not None:
                    ready_avatar(files.get(payload.avatar_file_id), actor_id)
                if old_id is not None:
                    old = ready_avatar(files.get(old_id), actor_id)
                    claim = claim_avatar_replacement(db, old, actor_id)
            changed = False
            for key, value in payload.model_dump(exclude_unset=True).items():
                if getattr(actor, key) != value:
                    setattr(actor, key, value)
                    changed = True
            if changed:
                db.commit()
            # A no-op must also release locks before any response computation.
            else:
                db.rollback()
        except SQLAlchemyError as exc:
            db.rollback()
            raise error("profile_unavailable", "Unable to update profile", 503) from exc
        except HTTPException:
            db.rollback()
            raise
        if claim is not None:
            try:
                delete_and_finalize(db, claim, storage)
            except HTTPException as exc:
                db.rollback()
                raise error(
                    "profile_avatar_cleanup_partial",
                    "Profile saved; previous avatar deletion requires reconciliation",
                    503,
                ) from exc
        return self_profile_response(db, fresh_user(db, actor_id), membership,
                                     default_organization_blocked)
