"""Bootstrap the first organization, administrator and installation operator."""

import argparse
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

# Keep the documented ``python operations/bootstrap_admin.py`` invocation working
# without requiring callers to manage PYTHONPATH.
if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import Settings, get_admin_settings, get_settings
from app.core.config.environment import environment_inputs
from app.core.config.instance import (
    assert_database_url,
    assert_instance_target,
    instance_target_for_process,
)
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from app.core.database import model_registry  # noqa: F401
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import Membership, PlatformOperator, User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from operations.create_organization import provision

LOCAL_ENVIRONMENTS = frozenset({"development", "dev", "local"})


class BootstrapError(RuntimeError):
    """A safe operational error raised while provisioning an administrator."""


@dataclass(frozen=True, slots=True)
class BootstrapResult:
    user_id: UUID
    email: str
    username: str
    status: str
    org_id: UUID
    slug: str


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="confirm first-administrator provisioning outside development/local environments",
    )
    parser.add_argument("--name", default="OpenSlate")
    parser.add_argument("--slug", default="openslate")
    parser.add_argument("--provider-user-id", type=UUID,
                        help="explicitly link a surviving confirmed provider identity")
    return parser


def _validate_confirmation(settings: Settings, confirmed: bool) -> None:
    if settings.environment.strip().casefold() not in LOCAL_ENVIRONMENTS and not confirmed:
        raise BootstrapError(
            "Administrator bootstrap requires --confirm outside development/local environments"
        )


def _invitation(email: str, username: str) -> InvitationCreate:
    try:
        return InvitationCreate(email=email, username=username)
    except ValueError:
        raise BootstrapError("ADMIN_EMAIL and ADMIN_USERNAME must be valid") from None


def _validate_schema(db: AuditSession) -> None:
    """Touch the account and membership schema before provisioning."""
    db.scalar(select(User.id, Membership.role).join(
        Membership, Membership.user_id == User.id,
    ).limit(1))


def _matching_profile(db: AuditSession, invitation: InvitationCreate) -> User | None:
    email_profile = db.scalar(select(User).where(User.email == invitation.email))
    username_profile = db.scalar(select(User).where(User.username == invitation.username))
    if email_profile is None and username_profile is None:
        return None
    if email_profile is not None and username_profile is not None:
        if email_profile.id != username_profile.id:
            raise BootstrapError("Email and username belong to different profiles")
        return email_profile
    return email_profile or username_profile


def _admin_assignment_count(db: AuditSession, *, excluded_user_id: UUID | None = None) -> int:
    statement = (
        select(func.count())
        .select_from(User)
        .join(Membership, Membership.user_id == User.id)
        .where(User.is_deleted.is_(False), Membership.is_deleted.is_(False),
               Membership.role == UserRole.ADMIN.value)
    )
    if excluded_user_id is not None:
        statement = statement.where(User.id != excluded_user_id)
    return int(db.scalar(statement) or 0)


def _is_exact_admin_reservation(db: AuditSession, user: User, invitation: InvitationCreate) -> bool:
    membership = db.scalars(select(Membership).where(
        Membership.user_id == user.id, Membership.status == UserStatus.PENDING.value,
        Membership.is_deleted.is_(False),
    ).limit(2)).all()
    if len(membership) != 1:
        return False
    reservation = membership[0]
    return bool(
        reservation.role == UserRole.ADMIN.value
        and user.status == UserStatus.PENDING.value
        and not user.is_deleted
        and reservation.provider_invitation_operation_id is not None
        and reservation.invitation_accepted_at is None
        and user.email == invitation.email
        and user.username == invitation.username
    )


def _provision(
    settings: Settings, invitation: InvitationCreate, *, provider_user_id: UUID | None = None,
    name: str = "OpenSlate", slug: str = "openslate",
) -> BootstrapResult:
    # Provider I/O precedes the short serialized installation transaction.
    confirmed_provider = (
        get_supabase_auth_client().get_admin_user(provider_user_id) if provider_user_id else None
    )
    with AuditSession(get_engine()) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext()
        _validate_schema(db)
        # The installation singleton orders concurrent first-operator bootstraps.
        db.scalar(select(PlatformSettings).with_for_update())
        existing_profile = _matching_profile(db, invitation)
        try:
            org = db.scalar(select(WorkspaceProfile).where(WorkspaceProfile.slug == slug))
            if org is not None:
                if existing_profile is None or (
                    existing_profile.email != invitation.email
                    or existing_profile.username != invitation.username
                ):
                    raise BootstrapError("Organization bootstrap identity does not match")
                membership = db.scalar(select(Membership).where(
                    Membership.org_id == org.id, Membership.user_id == existing_profile.id,
                    Membership.role == "admin", Membership.is_deleted.is_(False),
                ))
                if membership is None:
                    raise BootstrapError("Organization bootstrap identity does not match")
                if _is_exact_admin_reservation(db, existing_profile, invitation):
                    org = provision(db, name=name, slug=slug, invitation=invitation,
                                    provider_user_id=provider_user_id)
                elif (existing_profile.status != "active" or existing_profile.is_deleted
                      or membership.status != "active"
                      or existing_profile.supabase_user_id is None
                      or (provider_user_id is not None
                          and existing_profile.supabase_user_id != provider_user_id)):
                    raise BootstrapError("Bootstrap reservation is unavailable")
                user = existing_profile
            else:
                if db.scalar(select(PlatformOperator.id).limit(1)) or _admin_assignment_count(db):
                    raise BootstrapError("An administrator reservation already exists")
                if existing_profile is not None and provider_user_id is None:
                    raise BootstrapError("Existing account requires explicit provider identity")
                org = provision(db, name=name, slug=slug,
                                invitation=invitation.model_copy(update={"role": UserRole.ADMIN}),
                                provider_user_id=provider_user_id,
                                confirmed_provider=confirmed_provider)
                created_user = db.scalar(select(User).where(User.email == invitation.email))
                assert created_user is not None
                user = created_user
            if not db.scalar(select(PlatformOperator.id).where(
                PlatformOperator.user_id == user.id
            )):
                db.add(PlatformOperator(user_id=user.id))
            db.commit()
            return BootstrapResult(
                user.id, user.email, user.username, user.status, org.id, org.slug
            )
        except (InvitationError, SQLAlchemyError, ValueError) as error:
            db.rollback()
            raise BootstrapError("Unable to finalize administrator profile") from error


def main(argv: Sequence[str] | None = None) -> None:
    parser = _parser()
    args = parser.parse_args(argv)

    try:
        settings = get_settings()
        admin = get_admin_settings()
        target = instance_target_for_process(settings.database_url, "openslate_runtime")
        if target is not None:
            assert_database_url(settings.database_url, target, expected_user="openslate_runtime")
            with get_engine().connect() as connection:
                assert_instance_target(connection, target, expected_user="openslate_runtime")
        invitation = _invitation(admin.admin_email, admin.admin_username)
        _validate_confirmation(settings, args.confirm)
        assert_provider_instance(
            environment_inputs(DOTENV_PATH), database_url=settings.database_url,
            expected_user="openslate_runtime",
        )
        result = _provision(settings, invitation, provider_user_id=args.provider_user_id,
                            name=args.name, slug=args.slug)
    except SystemExit:
        raise
    except Exception:
        # Keep database, Auth, and configuration details out of command output.
        raise SystemExit("Unable to provision administrator") from None

    print(
        f"user_id={result.user_id} email={result.email} "
        f"username={result.username} status={result.status} "
        f"org_id={result.org_id} slug={result.slug}"
    )
    if result.status == UserStatus.PENDING.value:
        print("Complete the emailed invitation to activate the administrator account.")


if __name__ == "__main__":
    main()
