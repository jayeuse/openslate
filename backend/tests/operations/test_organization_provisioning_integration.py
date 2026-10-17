"""Operator creation and bootstrap preserve explicit account/provider ownership."""

import subprocess
import sys
from dataclasses import replace
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.core.integrations.supabase_auth import (
    ProviderUser,
    SupabaseAuthClient,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.users import service as user_service
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import Membership, PlatformOperator, User
from app.systems.access.users.schemas import InvitationCreate
from app.systems.boards.models import Board
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.designs.models import SandboxDocument
from operations import bootstrap_admin, create_organization

pytest_plugins = ("tests.auth.provider_account_support",)
pytestmark = pytest.mark.integration


def test_operator_creates_complete_organization_for_explicit_account(provider_account):
    _, _, _, account_id, owner = provider_account
    slug = "created-" + uuid4().hex
    command = [sys.executable, "operations/create_organization.py", "--confirm", "--name",
               "Created organization", "--slug", slug, "--admin-user-id", str(account_id)]
    created = subprocess.run(command, capture_output=True, text=True)
    assert created.returncode == 0, created.stderr
    with Session(owner) as db:
        org_id = db.scalar(select(WorkspaceProfile.id).where(WorkspaceProfile.slug == slug))
    try:
        with Session(owner) as db:
            org = db.get(WorkspaceProfile, org_id)
            assert org.display_name == "Created organization" and org.slug == slug
            assert org.timezone == "UTC" and org.locale == "en-US"
            membership = db.scalar(select(Membership).where(Membership.org_id == org_id))
            assert membership.user_id == account_id and membership.role == "admin"
            assert membership.status == "active"
            document = db.scalar(select(SandboxDocument).where(SandboxDocument.org_id == org_id))
            assert document.document["schemaVersion"] == 4
            assert document.document["design"]["departments"] == []
            board = db.scalar(select(Board).where(Board.org_id == org_id))
            assert board.scope == "company" and board.name == "Company Board"
            assert not db.scalar(select(PlatformOperator.id).where(
                PlatformOperator.user_id == account_id))
        duplicate = subprocess.run(command, capture_output=True, text=True)
        assert duplicate.returncode != 0
        with Session(owner) as db:
            assert len(db.scalars(select(WorkspaceProfile).where(
                WorkspaceProfile.slug == slug
            )).all()) == 1
    finally:
        _remove_organization(owner, org_id)


def _remove_organization(owner, org_id):
    with Session(owner) as db:
        for model in (Membership, Board, SandboxDocument):
            for row in db.scalars(select(model).where(model.org_id == org_id)):
                db.delete(row)
        db.flush()
        db.execute(text("DELETE FROM audit_logs WHERE org_id = :id"), {"id": org_id})
        db.delete(db.get(WorkspaceProfile, org_id))
        db.commit()


@pytest.fixture
def pending_owner_world(integration_owner_db, monkeypatch):
    owner = integration_owner_db.get_bind().engine
    slug = "pending-" + uuid4().hex
    invitation = InvitationCreate(email=f"{slug}@example.test", username=slug)
    provider = Mock(spec=SupabaseAuthClient)
    created = {}

    def create(email, local_id, operation_id):
        created[email] = ProviderUser(uuid4(), None, email, {
            "openslate_user_id": str(local_id),
            "openslate_invitation_operation_id": str(operation_id),
        })
        return created[email]

    provider.admin_create_invitation_user.side_effect = create
    provider.find_invitation_user.side_effect = lambda email, *_: created.get(email)
    provider.admin_send_invitation.side_effect = SupabaseAuthUnavailable("unavailable")
    for module in (user_service, create_organization):
        monkeypatch.setattr(module, "get_supabase_auth_client", lambda: provider)

    def run(command, payload=invitation):
        if command == "bootstrap":
            return bootstrap_admin._provision(get_settings(), payload, name="Pending", slug=slug)
        with AuditSession(get_engine()) as db:
            return create_organization.provision(
                db, name="Pending", slug=slug, invitation=payload,
            )

    try:
        yield owner, invitation, provider, run, slug
    finally:
        with Session(owner) as db:
            org_id = db.scalar(select(WorkspaceProfile.id).where(WorkspaceProfile.slug == slug))
            user_id = db.scalar(select(User.id).where(User.email == invitation.email))
            for row in db.scalars(select(PlatformOperator).where(
                PlatformOperator.user_id == user_id
            )):
                db.delete(row)
            db.commit()
        if org_id is not None:
            _remove_organization(owner, org_id)
        with Session(owner) as db:
            if user_id is not None:
                db.delete(db.get(User, user_id))
                db.commit()


@pytest.mark.parametrize("command", ["create", "bootstrap"])
def test_invitation_failure_preserves_owner_and_same_reservation_resumes(
    pending_owner_world, command,
):
    owner, invitation, provider, run, slug = pending_owner_world
    with pytest.raises((InvitationError, bootstrap_admin.BootstrapError)):
        run(command)
    with Session(owner) as db:
        org = db.scalars(select(WorkspaceProfile).where(WorkspaceProfile.slug == slug)).one()
        user = db.scalars(select(User).where(User.email == invitation.email)).one()
        membership = db.scalars(select(Membership).where(Membership.org_id == org.id)).one()
        org_id, user_id, operation_id = org.id, user.id, membership.provider_invitation_operation_id
        assert org.owner_user_id == user_id
        assert membership.user_id == user_id and membership.role == "admin"
        assert membership.status == user.status == "pending"
        assert operation_id is not None and membership.invitation_sent_at is None
        resources = tuple(db.scalars(select(model.id).where(model.org_id == org.id)).one()
                          for model in (Board, SandboxDocument))
        # Also recover an exact ownerless reservation left by an older command.
        org.owner_user_id = None
        db.commit()
    provider.admin_send_invitation.side_effect = None
    # Find the provider identity using the reservation's actual correlation, not an email-only bind.
    reserved = provider.find_invitation_user(invitation.email, user_id, operation_id)
    provider.admin_send_invitation.return_value = reserved
    result = run(command)
    assert (result.org_id if command == "bootstrap" else result.id) == org_id
    with Session(owner) as db:
        org = db.get(WorkspaceProfile, org_id)
        assert org.owner_user_id == user_id
        assert db.get(User, user_id).supabase_user_id == reserved.id
        membership = db.scalars(select(Membership).where(Membership.org_id == org_id)).one()
        assert membership.provider_invitation_operation_id == operation_id
        assert membership.invitation_sent_at is not None
        assert tuple(db.scalars(select(model.id).where(model.org_id == org_id)).one()
                     for model in (Board, SandboxDocument)) == resources
        assert bool(db.scalar(select(PlatformOperator.id).where(
            PlatformOperator.user_id == user_id
        ))) is (command == "bootstrap")
    provider.admin_create_invitation_user.assert_called_once()


@pytest.mark.parametrize("command", ["create", "bootstrap"])
@pytest.mark.parametrize("different", ["email", "username"])
def test_resume_refuses_another_identity_without_provider_effects(
    pending_owner_world, command, different,
):
    owner, invitation, provider, run, slug = pending_owner_world
    with pytest.raises((InvitationError, bootstrap_admin.BootstrapError)):
        run(command)
    provider.reset_mock()
    payload = invitation.model_copy(update={different: (
        "other@example.test" if different == "email" else "other-owner"
    )})
    with pytest.raises((ValueError, bootstrap_admin.BootstrapError)):
        run(command, payload)
    assert provider.mock_calls == []
    with Session(owner) as db:
        org = db.scalars(select(WorkspaceProfile).where(WorkspaceProfile.slug == slug)).one()
        user = db.scalars(select(User).where(User.email == invitation.email)).one()
        assert org.owner_user_id == user.id


def test_owner_reservation_database_failure_rolls_back_all_initial_state(pending_owner_world):
    owner, invitation, provider, run, slug = pending_owner_world
    with owner.begin() as connection:
        connection.execute(text(
            "ALTER TABLE public.organizations ADD CONSTRAINT owned_reservation_failure "
            "CHECK (owner_user_id IS NULL) NOT VALID"
        ))
    try:
        with pytest.raises((InvitationError, ValueError)):
            run("create")
    finally:
        with owner.begin() as connection:
            connection.execute(text(
                "ALTER TABLE public.organizations DROP CONSTRAINT owned_reservation_failure"
            ))
    provider.admin_create_invitation_user.assert_not_called()
    with Session(owner) as db:
        assert db.scalar(select(WorkspaceProfile.id).where(WorkspaceProfile.slug == slug)) is None
        assert db.scalar(select(User.id).where(User.email == invitation.email)) is None


def test_bootstrap_requires_explicit_provider_binding_and_creates_first_operator(provider_account):
    email, _, provider_id, account_id, owner = provider_account
    with Session(owner) as db:
        original = db.scalar(select(Membership).where(Membership.user_id == account_id))
        original_org_id = original.org_id
        user = db.get(User, account_id)
        invitation = InvitationCreate(email=email, username=user.username)
        assert user.supabase_user_id is None
    org_id = None
    slug = "bootstrap-" + uuid4().hex
    try:
        provider = get_supabase_auth_client().get_admin_user(provider_id)
        with patch.object(bootstrap_admin, "get_supabase_auth_client", return_value=Mock(
            get_admin_user=Mock(return_value=replace(provider, email_confirmed_at=None))
        )), pytest.raises(bootstrap_admin.BootstrapError):
            bootstrap_admin._provision(
                get_settings(), invitation, provider_user_id=provider_id,
                name="First organization", slug=slug,
            )
        with Session(owner) as db:
            assert db.scalar(select(WorkspaceProfile.id).where(
                WorkspaceProfile.slug == slug
            )) is None
            assert db.get(User, account_id).supabase_user_id is None
        result = bootstrap_admin._provision(
            get_settings(), invitation, provider_user_id=provider_id,
            name="First organization", slug=slug,
        )
        org_id = result.org_id
        with Session(owner) as db:
            user = db.get(User, result.user_id)
            assert result.user_id == account_id and user.supabase_user_id == provider_id
            assert user.status == "active"
            row = db.scalar(select(Membership).where(Membership.org_id == org_id))
            assert row.user_id == account_id and row.role == "admin" and row.status == "active"
            assert db.scalar(select(PlatformOperator.id).where(
                PlatformOperator.user_id == account_id
            ))
            assert db.scalar(select(Board.id).where(Board.org_id == org_id))
            assert db.scalar(select(SandboxDocument.id).where(SandboxDocument.org_id == org_id))
        # Rerunning with the same explicit identity does not grant a second organization.
        repeated = bootstrap_admin._provision(
            get_settings(), invitation, provider_user_id=provider_id,
            name="First organization", slug=result.slug,
        )
        assert repeated.user_id == account_id and repeated.org_id == org_id
    finally:
        with Session(owner) as db:
            org_id = org_id or db.scalar(select(WorkspaceProfile.id).where(
                WorkspaceProfile.slug == slug
            ))
            for row in db.scalars(select(PlatformOperator).where(
                PlatformOperator.user_id == account_id
            )):
                db.delete(row)
            db.commit()
        if org_id:
            _remove_organization(owner, org_id)
        # The provider fixture still owns and removes its original organization/account.
        assert original_org_id is not None
