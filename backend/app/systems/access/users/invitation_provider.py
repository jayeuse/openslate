"""Resolve an exact provider identity for a pending local invitation."""

from app.core.integrations.supabase_auth import (
    ProviderUser,
    ProviderUserNotFound,
    SupabaseAuthClient,
)
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import Membership, User


def _require_owned(user: ProviderUser, profile: User, membership: Membership) -> None:
    if (
        user.email != profile.email
        or user.app_metadata.get("openslate_user_id") != str(profile.id)
        or user.app_metadata.get("openslate_invitation_operation_id")
        != str(membership.provider_invitation_operation_id)
    ):
        raise InvitationError("Provider invitation does not match")


def _find_or_create(
    provider: SupabaseAuthClient, profile: User, membership: Membership
) -> ProviderUser:
    operation_id = membership.provider_invitation_operation_id
    if operation_id is None:
        raise InvitationError("Invitation is not pending")
    user = provider.find_invitation_user(profile.email, profile.id, operation_id)
    if user is None:
        user = provider.admin_create_invitation_user(profile.email, profile.id, operation_id)
    _require_owned(user, profile, membership)
    return user


def prepare_invitation_user(
    provider: SupabaseAuthClient, profile: User, membership: Membership
) -> ProviderUser:
    """Keep the old local binding until an owned replacement is sent and committed.

    A confirmed provider identity cannot receive another GoTrue invite. A failed
    provider mutation leaves the local binding and operation marker untouched,
    so an explicit retry can inspect the provider's authoritative state.
    """

    old_id = profile.supabase_user_id
    if old_id is not None:
        try:
            bound = provider.get_admin_user(old_id)
        except ProviderUserNotFound:
            pass
        else:
            if bound.id != old_id:
                raise InvitationError("Provider invitation does not match")
            _require_owned(bound, profile, membership)
            if bound.email_confirmed_at is None:
                return bound
            try:
                provider.admin_delete_user(old_id)
            except ProviderUserNotFound:
                pass

    user = _find_or_create(provider, profile, membership)
    if old_id is not None and user.id == old_id:
        raise InvitationError("Provider invitation does not match")
    if user.email_confirmed_at is not None:
        try:
            provider.admin_delete_user(user.id)
        except ProviderUserNotFound:
            pass
        replaced_id = user.id
        user = _find_or_create(provider, profile, membership)
        if user.id in {replaced_id, old_id} or user.email_confirmed_at is not None:
            raise InvitationError("Provider invitation does not match")
    return user
