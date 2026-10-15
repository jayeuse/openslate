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
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.systems.access.users.models import Membership, PlatformOperator, User
from app.systems.access.users.schemas import InvitationCreate
from app.systems.boards.models import Board
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.designs.models import SandboxDocument
from operations import bootstrap_admin

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
