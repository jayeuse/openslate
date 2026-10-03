"""Persisted workspace security rules shared by identity and settings boundaries."""

from datetime import timedelta
from ipaddress import IPv4Network, IPv6Address, IPv6Network, ip_address, ip_network

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.integrations.supabase_auth import SupabaseAuthUnavailable
from app.systems.manage.workspace.models import WorkspaceProfile

PASSWORD_CHOICES = frozenset({(12, True, False), (16, True, True), (20, False, False)})
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
