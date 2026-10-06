"""Bound, ordered MFA observations at explicit committed identity boundaries."""

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.integrations.supabase_auth import ProviderUser, SupabaseAuthUnavailable
from app.systems.access.identity.models import IdentityMfaObservation
from app.systems.access.users.models import User


def observation_started_at() -> datetime:
    """Order provider evidence by local read start, independently of policy clocks."""
    return utc_now()


def initialize_observation(db: Session, user_id: UUID) -> None:
    """The caller already holds the User lock or has just created the User."""
    if db.get(IdentityMfaObservation, user_id) is None:
        db.add(IdentityMfaObservation(user_id=user_id))
        db.flush()


def record_observation(
    db: Session,
    user_id: UUID,
    provider_id: UUID,
    verified_totp: bool | None,
    started_at: datetime,
) -> None:
    """Lock an existing row last; never initialize from Session-first refresh."""
    observation = db.scalar(
        select(IdentityMfaObservation)
        .where(IdentityMfaObservation.user_id == user_id)
        .execution_options(populate_existing=True)
        .with_for_update(of=IdentityMfaObservation)
    )
    if observation is None:
        return
    binding = db.scalar(select(User.supabase_user_id).where(User.id == user_id))
    if binding != provider_id or (
        observation.observed_at is not None and started_at <= observation.observed_at
    ):
        return
    observation.observed_provider_user_id = provider_id
    observation.verified_totp = verified_totp
    observation.observed_at = started_at


def record_provider_observation(
    db: Session, user_id: UUID, provider_user: ProviderUser, started_at: datetime
) -> None:
    record_observation(
        db,
        user_id,
        provider_user.id,
        any(
            factor.factor_type == "totp" and factor.status == "verified"
            for factor in provider_user.factors
        ),
        started_at,
    )


def commit_bound_observation(
    db: Session,
    user_id: UUID,
    provider_id: UUID,
    verified_totp: bool | None,
    started_at: datetime,
) -> None:
    """Projection failure cannot roll back an already committed captured effect."""
    try:
        record_observation(db, user_id, provider_id, verified_totp, started_at)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise SupabaseAuthUnavailable("Unable to persist MFA observation") from error
