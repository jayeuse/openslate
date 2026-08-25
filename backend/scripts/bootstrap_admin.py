"""Provision the first administrator through the Supabase Auth invite flow.

The script never creates a local credential.  Supabase Auth owns the identity,
and its user-created trigger creates the pending local profile.  This script
then activates that profile and promotes it to the seeded ``admin`` role.
"""

import argparse
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

# Keep the documented ``python scripts/bootstrap_admin.py`` invocation working
# without requiring callers to manage PYTHONPATH.
if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import Settings, get_settings
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase import SupabaseAdminClient
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus
from app.systems.users.service import InvitationError, invite_user

CONFIRMATION_ENV = "BOOTSTRAP_ADMIN_CONFIRM"
LOCAL_ENVIRONMENTS = frozenset({"development", "dev", "local"})


class BootstrapError(RuntimeError):
    """A safe operational error raised while provisioning an administrator."""


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True, help="email address to invite")
    parser.add_argument("--username", required=True, help="local username for the invitee")
    parser.add_argument(
        "--confirm",
        action="store_true",
        help=(
            "confirm first-administrator provisioning; required outside development/local "
            f"unless {CONFIRMATION_ENV}=1 is set"
        ),
    )
    return parser


def _confirmation_from_environment() -> bool:
    return os.environ.get(CONFIRMATION_ENV, "").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _validate_confirmation(settings: Settings, confirmed: bool) -> None:
    if settings.environment.strip().casefold() not in LOCAL_ENVIRONMENTS and not (
        confirmed or _confirmation_from_environment()
    ):
        raise BootstrapError(
            "Administrator bootstrap requires --confirm outside development/local environments"
        )


def _invitation(parser: argparse.ArgumentParser, email: str, username: str) -> InvitationCreate:
    try:
        return InvitationCreate(email=email, username=username)
    except ValueError:
        parser.error("email and username must be valid")


def _active_role(db: AuditSession, role: UserRole) -> Role:
    result = db.scalar(select(Role).where(Role.role == role, Role.is_deleted.is_(False)))
    if result is None:
        raise BootstrapError(f"The active {role.value} role is not configured")
    return result


def _validate_schema_and_roles(db: AuditSession) -> tuple[Role, Role]:
    """Touch the local profile table and require both seeded Auth roles."""
    db.scalar(select(User.id).limit(1))
    member_role = _active_role(db, UserRole.MEMBER)
    admin_role = _active_role(db, UserRole.ADMIN)
    return member_role, admin_role


def _matching_profile(db: AuditSession, invitation: InvitationCreate) -> User | None:
    email_profile = db.scalar(select(User).where(User.email == invitation.email))
    username_profile = db.scalar(select(User).where(User.username == invitation.username))
    if email_profile is None and username_profile is None:
        return None
    if (
        email_profile is not None
        and username_profile is None
        and email_profile.status == UserStatus.PENDING.value
        and email_profile.username.startswith("auth_")
        and not email_profile.is_deleted
    ):
        # invite_user can safely replace this stranded infrastructure profile.
        return None
    if email_profile is not None and username_profile is not None:
        if email_profile.id != username_profile.id:
            raise BootstrapError("Email and username belong to different profiles")
        return email_profile
    raise BootstrapError("Email or username is already associated with another profile")


def _active_admin_count(db: AuditSession) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(User)
            .join(Role, User.role_id == Role.id)
            .where(
                User.is_deleted.is_(False),
                User.status == UserStatus.ACTIVE.value,
                Role.is_deleted.is_(False),
                Role.role == UserRole.ADMIN,
            )
        )
        or 0
    )


def _promote(db: AuditSession, user: User, admin_role: Role) -> None:
    user.role_id = admin_role.id
    user.role = admin_role
    user.status = UserStatus.ACTIVE.value
    user.is_deleted = False
    user.deleted_at = None


def _provision(settings: Settings, invitation: InvitationCreate) -> User:
    auth_client: SupabaseAdminClient | None = None
    invited_user: User | None = None

    with AuditSession(get_engine()) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext()
        member_role, admin_role = _validate_schema_and_roles(db)
        existing_profile = _matching_profile(db, invitation)

        if existing_profile is not None:
            already_active_admin = (
                existing_profile.role_id == admin_role.id
                and existing_profile.status == UserStatus.ACTIVE.value
                and not existing_profile.is_deleted
            )
            if not already_active_admin and _active_admin_count(db):
                raise BootstrapError("An active administrator already exists")
            _promote(db, existing_profile, admin_role)
            try:
                db.commit()
                db.refresh(existing_profile)
            except SQLAlchemyError as error:
                db.rollback()
                raise BootstrapError("Unable to finalize administrator profile") from error
            return existing_profile

        if _active_admin_count(db):
            raise BootstrapError("An active administrator already exists")

        auth_client = SupabaseAdminClient(settings)
        try:
            invited_user = invite_user(
                db,
                invitation.model_copy(update={"role_id": member_role.id}),
                client=auth_client,
            )
            # invite_user commits the trigger-created profile as an active member.
            # Promotion is a separate audited ORM commit so the first admin grant
            # is visible in the normal application audit stream.
            _promote(db, invited_user, admin_role)
            db.commit()
            db.refresh(invited_user)
            return invited_user
        except (InvitationError, SQLAlchemyError, BootstrapError) as error:
            db.rollback()
            if invited_user is not None:
                try:
                    auth_client.delete_user(invited_user.id)
                except Exception:
                    pass
            if isinstance(error, BootstrapError):
                raise
            raise BootstrapError("Unable to finalize administrator profile") from error


def main(argv: Sequence[str] | None = None) -> None:
    parser = _parser()
    args = parser.parse_args(argv)
    invitation = _invitation(parser, args.email, args.username)

    try:
        settings = get_settings()
        _validate_confirmation(settings, args.confirm)
        user = _provision(settings, invitation)
    except SystemExit:
        raise
    except Exception:
        # Keep database, Auth, and configuration details out of command output.
        raise SystemExit("Unable to provision administrator") from None

    print(
        f"user_id={user.id} email={user.email} username={user.username} status={user.status}"
    )


if __name__ == "__main__":
    main()
