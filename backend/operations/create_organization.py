"""Create one organization and explicitly grant its first administrator through the CLI."""

import argparse
import re
import sys
from collections.abc import Sequence
from pathlib import Path
from uuid import UUID

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.environment import environment_inputs
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from app.core.database import model_registry  # noqa: F401
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase_auth import ProviderUser, get_supabase_auth_client
from app.systems.access.identity.mfa_observations import initialize_observation
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.access.users.schemas import InvitationCreate
from app.systems.access.users.service import invite_user
from app.systems.boards.models import Board
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.designs.models import SandboxDocument
from app.systems.sandbox.designs.schemas import DesignDocument
from app.systems.sandbox.designs.schemas import SandboxDocument as Document
from app.systems.sandbox.designs.service import canonical_document


def provision(
    db: Session, *, name: str, slug: str, admin_user_id: UUID | None = None,
    invitation: InvitationCreate | None = None, provider_user_id: UUID | None = None,
    confirmed_provider: ProviderUser | None = None,
) -> WorkspaceProfile:
    """Commit the organization and its initial authority; provider invites retain reservations.

    An explicit provider ID is operator authority to link that identity, never
    an email-equality sign-in path. Provider accounts are not edited or replaced.
    """
    if not name.strip() or len(name.strip()) > 200 or not re.fullmatch(
        r"[a-z0-9]+(?:-[a-z0-9]+)*", slug
    ) or len(slug) > 200:
        raise ValueError("Organization name or slug is invalid")
    if (admin_user_id is None) == (invitation is None):
        raise ValueError("Choose an account or an invitation")
    provider = get_supabase_auth_client()
    user = None
    if provider_user_id is not None:
        if invitation is None:
            raise ValueError("An explicit provider binding requires account identity")
        provider_user = confirmed_provider or provider.get_admin_user(provider_user_id)
        if (provider_user.id != provider_user_id or provider_user.email != invitation.email
                or provider_user.email_confirmed_at is None or not provider_user.is_eligible()):
            raise ValueError("Provider account does not match the requested administrator")
        user = db.scalar(select(User).where(User.email == invitation.email))
        if user is not None and (
            user.username != invitation.username or user.is_deleted or user.status != "active"
            or user.supabase_user_id not in {None, provider_user_id}
        ):
            raise ValueError("Account is not available for explicit provider binding")
        if user is None:
            user = User(email=invitation.email, username=invitation.username, status="active")
            db.add(user)
            db.flush()
            initialize_observation(db, user.id)
        user.supabase_user_id = provider_user_id
    elif admin_user_id is not None:
        user = db.get(User, admin_user_id, populate_existing=True, with_for_update=True)
        if user is None or user.is_deleted or user.status != "active":
            raise ValueError("Administrator account is not active")
    try:
        org = WorkspaceProfile(display_name=name.strip(), slug=slug, timezone="UTC", locale="en-US")
        db.add(org)
        db.flush()
        scope_session(db, org.id)
        document, digest, size = canonical_document(Document(
            kind="openslate-sandbox", schema_version=4, design=DesignDocument(),
        ))
        db.add(SandboxDocument(
            org_id=org.id, document=document, content_hash=digest, byte_count=size
        ))
        db.add(Board(org_id=org.id, scope="company", name="Company Board"))
        if user is not None:
            db.add(Membership(org_id=org.id, user_id=user.id, role="admin", status="active"))
            db.commit()
        else:
            assert invitation is not None
            invite_user(db, invitation.model_copy(update={"role": UserRole.ADMIN}),
                        bootstrap=True, org_id=org.id)
        db.refresh(org)
        return org
    except SQLAlchemyError as error:
        db.rollback()
        raise ValueError("Unable to create organization") from error


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--confirm", action="store_true")
    identity = parser.add_mutually_exclusive_group(required=True)
    identity.add_argument("--admin-user-id", type=UUID)
    identity.add_argument("--email")
    parser.add_argument("--username")
    args = parser.parse_args(argv)
    try:
        settings = get_settings()
        if settings.environment not in {"development", "dev", "local"} and not args.confirm:
            raise ValueError("Organization creation requires --confirm")
        assert_provider_instance(
            environment_inputs(DOTENV_PATH), database_url=settings.database_url,
            expected_user="openslate_runtime",
        )
        invitation = (
            InvitationCreate(email=args.email, username=args.username) if args.email else None
        )
        with AuditSession(get_engine()) as db:
            org = provision(db, name=args.name, slug=args.slug, admin_user_id=args.admin_user_id,
                            invitation=invitation)
            print(f"org_id={org.id} slug={org.slug}")
    except Exception:
        raise SystemExit("Unable to create organization") from None


if __name__ == "__main__":
    main()
