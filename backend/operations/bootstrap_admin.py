"""Reserve the first administrator and send a Supabase email invitation."""

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

from app.common.normalization import normalize_email, normalize_username
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
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from app.systems.access.users.service import invite_user, reconcile_invitation
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext

LOCAL_ENVIRONMENTS = frozenset({"development", "dev", "local"})


class BootstrapError(RuntimeError):
    """A safe operational error raised while provisioning an administrator."""


@dataclass(frozen=True, slots=True)
class BootstrapResult:
    user_id: UUID
    email: str
    username: str
    status: str


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="confirm first-administrator provisioning outside development/local environments",
    )
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
    """Touch the local profile table, including its role column."""
    db.scalar(select(User.id, User.role).limit(1))


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
        .where(User.is_deleted.is_(False), User.role == UserRole.ADMIN.value)
    )
    if excluded_user_id is not None:
        statement = statement.where(User.id != excluded_user_id)
    return int(db.scalar(statement) or 0)


def _is_exact_admin_reservation(user: User, invitation: InvitationCreate) -> bool:
    try:
        normalized_email = normalize_email(user.email)
        normalized_username = normalize_username(user.username)
    except ValueError:
        return False
    return bool(
        user.role == UserRole.ADMIN.value
        and user.status == UserStatus.PENDING.value
        and not user.is_deleted
        and user.provider_invitation_operation_id is not None
        and user.invitation_accepted_at is None
        and normalized_email == invitation.email
        and normalized_username == invitation.username
    )


def _provision(settings: Settings, invitation: InvitationCreate) -> BootstrapResult:
    with AuditSession(get_engine()) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext()
        _validate_schema(db)
        existing_profile = _matching_profile(db, invitation)

        if existing_profile is not None:
            if _is_exact_admin_reservation(existing_profile, invitation):
                if not _admin_assignment_count(db, excluded_user_id=existing_profile.id):
                    reconcile_invitation(db, existing_profile.id, actor_id=None, bootstrap=True)
                    return BootstrapResult(
                        existing_profile.id,
                        existing_profile.email,
                        existing_profile.username,
                        existing_profile.status,
                    )
                raise BootstrapError("An administrator reservation already exists")
            raise BootstrapError("Email or username is already associated with another profile")

        if _admin_assignment_count(db):
            raise BootstrapError("An administrator reservation already exists")

        try:
            user = invite_user(
                db,
                invitation.model_copy(update={"role": UserRole.ADMIN}),
                actor_id=None,
                bootstrap=True,
            )
            return BootstrapResult(user.id, user.email, user.username, user.status)
        except (InvitationError, SQLAlchemyError) as error:
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
        result = _provision(settings, invitation)
    except SystemExit:
        raise
    except Exception:
        # Keep database, Auth, and configuration details out of command output.
        raise SystemExit("Unable to provision administrator") from None

    print(
        f"user_id={result.user_id} email={result.email} "
        f"username={result.username} status={result.status}"
    )
    print("Complete the emailed invitation to activate the administrator account.")


if __name__ == "__main__":
    main()
