"""Persisted workspace security rules shared by identity and settings boundaries."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from ipaddress import IPv4Network, IPv6Address, IPv6Network, ip_address, ip_network
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.base_model import utc_now
from app.core.integrations.supabase_auth import SupabaseAuthUnavailable
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.eligibility import established_user_clause, is_established_user
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile

COMMON_PASSWORDS = frozenset(
    Path(__file__).with_name("common_passwords.txt").read_text(encoding="utf-8").splitlines()
)
MAX_IP_NETWORKS = 100
_MAPPED_IPV4 = IPv6Network("::ffff:0:0/96")


class PasswordPolicyViolation(ValueError):
    """A candidate password does not meet the workspace's safe public requirement."""


def load_workspace_policy(db: Session) -> WorkspaceProfile:
    """Read current persisted policy without committing or admitting fallback defaults."""
    try:
        profile = db.scalar(
            select(WorkspaceProfile)
            .where(WorkspaceProfile.singleton_key.is_(True))
            .execution_options(populate_existing=True)
        )
    except SQLAlchemyError as error:
        raise SupabaseAuthUnavailable("Workspace security policy is unavailable") from error
    if not isinstance(profile, WorkspaceProfile):
        raise SupabaseAuthUnavailable("Workspace security policy is unavailable")
    return profile


def validate_password(profile: WorkspaceProfile, password: str) -> None:
    minimum = max(12, profile.password_min_length)
    requirements = [f"at least {minimum} characters"]
    if profile.password_require_mixed_case:
        requirements.append("uppercase and lowercase letters")
    if profile.password_require_number:
        requirements.append("at least one number")
    if (
        len(password) < minimum
        or len(password) > 128
        or (
            profile.password_require_mixed_case
            and not (
                any(char.isupper() for char in password)
                and any(char.islower() for char in password)
            )
        )
        or (profile.password_require_number and not any(char.isdigit() for char in password))
    ):
        raise PasswordPolicyViolation("Password must contain " + ", ".join(requirements))
    if password.casefold() in COMMON_PASSWORDS:
        raise PasswordPolicyViolation("Choose a password that is not commonly used")


def session_timeout(profile: WorkspaceProfile) -> timedelta:
    return timedelta(minutes=profile.session_timeout_minutes)


def canonical_network(value: str) -> str:
    network = ip_network(value.strip(), strict=False)
    if isinstance(network, IPv6Network) and network.subnet_of(_MAPPED_IPV4):
        return str(IPv4Network((int(network.network_address) & 0xFFFFFFFF, network.prefixlen - 96)))
    return str(network)


def ip_allowed(profile: WorkspaceProfile, source: str | None) -> bool:
    """Evaluate resolved client addresses; never interpret client-controlled headers."""
    ranges = profile.ip_allow_list
    if not isinstance(ranges, list) or len(ranges) > MAX_IP_NETWORKS:
        return False
    if not ranges:
        return True
    if source is None:
        return False
    try:
        address = ip_address(source)
        if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        # Parse every configured range before allowing any match: malformed persisted
        # policy fails closed even when another range would permit this address.
        networks = [ip_network(canonical_network(value)) for value in ranges]
    except (ValueError, TypeError, AttributeError):
        return False
    return any(address.version == network.version and address in network for network in networks)


def mfa_role_required(profile: WorkspaceProfile, role: str) -> bool:
    return bool(getattr(profile, f"mfa_require_{role}", False))


def mfa_enrollment_deadline(profile: WorkspaceProfile, since: datetime | None) -> datetime | None:
    return since + timedelta(days=profile.mfa_grace_days) if since is not None else None


@dataclass(frozen=True)
class SessionDeadlines:
    session_timeout_minutes: int
    session_absolute_lifetime_minutes: int | None


def snapshot_deadlines(profile: WorkspaceProfile) -> SessionDeadlines:
    return SessionDeadlines(
        profile.session_timeout_minutes, profile.session_absolute_lifetime_minutes
    )


def effective_session_expiry(
    session: IdentitySession,
    policy: WorkspaceProfile | SessionDeadlines,
) -> datetime:
    deadlines = [
        session.expires_at,
        session.refreshed_at + timedelta(minutes=policy.session_timeout_minutes),
    ]
    if policy.session_absolute_lifetime_minutes is not None:
        deadlines.append(
            session.created_at + timedelta(minutes=policy.session_absolute_lifetime_minutes)
        )
    return min(deadlines)


def renewed_session_expiry(
    session: IdentitySession, policy: WorkspaceProfile, now: datetime
) -> datetime:
    deadline = now + session_timeout(policy)
    if policy.session_absolute_lifetime_minutes is not None:
        deadline = min(
            deadline,
            session.created_at + timedelta(minutes=policy.session_absolute_lifetime_minutes),
        )
    return deadline


def session_expiry_expression(profile: WorkspaceProfile) -> ColumnElement[datetime]:
    deadlines = [
        IdentitySession.expires_at,
        IdentitySession.refreshed_at + session_timeout(profile),
    ]
    if profile.session_absolute_lifetime_minutes is not None:
        deadlines.append(
            IdentitySession.created_at
            + timedelta(minutes=profile.session_absolute_lifetime_minutes)
        )
    return func.least(*deadlines)


def clamp_session_deadlines(
    db: Session, old: SessionDeadlines, candidate: WorkspaceProfile
) -> None:
    for session in db.scalars(
        select(IdentitySession)
        .where(IdentitySession.revoked_at.is_(None))
        .order_by(IdentitySession.id)
        .execution_options(populate_existing=True)
        .with_for_update(of=IdentitySession, nowait=True)
    ):
        session.expires_at = min(
            effective_session_expiry(session, old), effective_session_expiry(session, candidate)
        )


def lock_policy_users(
    db: Session,
    old: dict[str, bool],
    profile: WorkspaceProfile,
    changed: set[str],
) -> None:
    roles = {
        role
        for role in ("admin", "member", "guest")
        if old[role] != mfa_role_required(profile, role)
        or ("mfa_grace_days" in changed and mfa_role_required(profile, role))
    }
    if "session_concurrent_limit" in changed:
        roles.update(("admin", "member", "guest"))
    if not roles:
        return
    timestamp = utc_now()
    for user in db.scalars(
        select(User)
        .where(established_user_clause(), User.role.in_(roles))
        .order_by(User.id)
        .execution_options(populate_existing=True)
        .with_for_update(of=User, nowait=True)
    ):
        transition_mfa_episode(
            user, old[user.role], mfa_role_required(profile, user.role), timestamp
        )


def transition_mfa_episode(user: User, was_required: bool, required: bool, now: datetime) -> None:
    if not is_established_user(user):
        return
    if required and not was_required:
        user.mfa_required_since = now
    elif not required and was_required:
        user.mfa_required_since = None


def apply_role_mfa_episode(db: Session, user: User, role: str) -> None:
    profile = db.scalar(
        select(WorkspaceProfile)
        .where(WorkspaceProfile.singleton_key.is_(True))
        .execution_options(populate_existing=True)
        .with_for_update(read=True)
    )
    if profile is None:
        raise SupabaseAuthUnavailable("Workspace security policy is unavailable")
    transition_mfa_episode(
        user, mfa_role_required(profile, user.role), mfa_role_required(profile, role), utc_now()
    )


def accepted_mfa_episode(db: Session, user: User, now: datetime) -> None:
    profile = db.scalar(
        select(WorkspaceProfile)
        .where(WorkspaceProfile.singleton_key.is_(True))
        .execution_options(populate_existing=True)
        .with_for_update(read=True)
    )
    if profile is None:
        raise SupabaseAuthUnavailable("Workspace security policy is unavailable")
    if mfa_role_required(profile, user.role):
        user.mfa_required_since = now
